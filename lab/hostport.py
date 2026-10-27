#!/usr/bin/env python3
"""把容器服务发布到宿主指定地址（Apple container 端口发布的替代方案）。

## 为什么需要这个

实测 Apple container 1.5.0（macOS 27.0.1 / arm64）的 `-p/--publish` **在本机不可用**：
宿主侧端口确实 LISTEN，TCP 也能建连（`nc -z` 成功），但**请求一律被
`Connection reset by peer`**，容器内完全收不到流量。默认网络、自定义网络、
绑定指定 IP、绑定全接口——四种组合全部复现。

但「宿主 → 容器 IP 直连」**完全正常**：

    宿主 curl http://192.168.64.13/     → OK-HELLO      ✅
    curl http://127.0.0.1:18096/        → Connection reset ❌

因此本脚本在宿主上做一层**极简 TCP 转发**，把
`100.64.0.3:<对外端口>` 转发到 `<容器IP>:<容器内端口>`，
既绕开上游缺陷，又满足「对外统一用 100.64.0.3 访问」的约定。

若哪天 `container -p` 修好了，删掉本层直接发布即可——测试侧的地址不变。

## 用法

    python3 lab/hostport.py 8080=192.168.64.13:3000 18080=192.168.64.13:8080

    --bind 100.64.0.3    对外绑定地址（默认取 tailscale IP）
    --list               从运行中的容器自动生成映射并打印

## 设计取舍

- **纯 stdlib**：不引入 socat/nginx 依赖（macOS 默认都没有）
- **每连接双线程转发**：够用且好懂；dev/test 场景连接数很低
- **不解析 HTTP**：保持透明，TCP 层转发对 WebSocket 升级也天然兼容
  （面板的实时推送走 WS，所以不能用会缓冲的 HTTP 代理）
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import threading

DEFAULT_BIND = "100.64.0.3"


def tailscale_ip() -> str | None:
    """取本机 Tailscale IPv4（对外访问地址）。"""
    try:
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5)
        ip = out.stdout.strip().splitlines()[0] if out.stdout.strip() else None
        return ip or None
    except Exception:
        return None


def pump(src: socket.socket, dst: socket.socket) -> None:
    """单向搬运数据；任一端断开就关掉两端，避免半开连接悬挂。"""
    try:
        while True:
            chunk = src.recv(65536)
            if not chunk:
                break
            dst.sendall(chunk)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def serve_once(listener: socket.socket, target: tuple[str, int], label: str) -> None:
    while True:
        try:
            client, addr = listener.accept()
        except OSError:
            return
        try:
            upstream = socket.create_connection(target, timeout=8)
        except OSError as e:
            print(f"  [{label}] 无法连接后端 {target[0]}:{target[1]} —— {e}", flush=True)
            client.close()
            continue
        # ⚠️ 关键：create_connection 的 timeout 会**一直作用于后续 recv/send**。
        # 不置空的话，任何超过 8s 仍未产生数据的请求（例如面板查上游超时、
        # 大文件上传、长轮询）都会被我们主动掐断，客户端只看到
        # `curl: (52) Empty reply from server`——看着像后端崩了，其实是转发器干的。
        upstream.settimeout(None)
        client.settimeout(None)
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pump, args=(upstream, client), daemon=True).start()


def parse_mapping(spec: str) -> tuple[int, str, int]:
    """`对外端口=容器IP:容器端口`"""
    try:
        left, right = spec.split("=", 1)
        host, cport = right.rsplit(":", 1)
        return int(left), host, int(cport)
    except ValueError as e:
        raise SystemExit(f"映射格式错误：{spec!r}（应为 对外端口=容器IP:容器端口）") from e


def main() -> int:
    ap = argparse.ArgumentParser(description="把容器服务转发到宿主（Apple container 端口发布的替代）")
    ap.add_argument("mappings", nargs="*", help="对外端口=容器IP:容器端口")
    ap.add_argument("--bind", default=None, help=f"对外绑定地址（默认 {DEFAULT_BIND}）")
    a = ap.parse_args()

    bind_ip = a.bind or tailscale_ip() or DEFAULT_BIND
    if not a.mappings:
        raise SystemExit("至少给一个映射，例如：8080=192.168.64.13:3000")

    print(f"转发绑定地址：{bind_ip}", flush=True)
    listeners: list[socket.socket] = []
    for spec in a.mappings:
        out_port, chost, cport = parse_mapping(spec)
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind((bind_ip, out_port))
            srv.listen(128)
        except OSError as e:
            raise SystemExit(f"无法绑定 {bind_ip}:{out_port} —— {e}") from e
        label = f"{out_port}"
        print(f"  {bind_ip}:{out_port}  →  {chost}:{cport}", flush=True)
        threading.Thread(target=serve_once, args=(srv, (chost, cport), label), daemon=True).start()
        listeners.append(srv)

    print("就绪。Ctrl-C 退出。", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        print("\n已停止", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
