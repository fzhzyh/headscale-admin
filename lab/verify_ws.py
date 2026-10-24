#!/usr/bin/env python3
"""验证 WebSocket 实时推送：写操作后是否真的把「变化」推给浏览器端。

关键点：不能只验「连得上」，必须验「变了会推」。所以流程是
连上 → 等待基线 → 触发一次真实写操作 → 断言收到对应事件。
"""
import json
import os
import sys
import socket
import ssl
import base64
import hashlib
import struct
import time
import urllib.request
import urllib.error

# 本地联调：强制直连，避免 macOS 系统代理把 127.0.0.1 的请求送去代理
# （曾导致「同一 Key 时而 200 时而 401」的间歇性假故障，详见 _local_net.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local  # noqa: E402

bypass_proxy_for_local()

PANEL = os.environ.get("PANEL_URL", "http://127.0.0.1:8080")
USER = os.environ.get("PANEL_ADMIN_USER", "admin")
PASS = os.environ.get("PANEL_ADMIN_SECRET", "")

PASSED, FAILED = [], []


def check(label, ok, detail=""):
    (PASSED if ok else FAILED).append(label)
    print(f"  {'✓' if ok else '✗'} {label}" + (f"   → {detail}" if detail else ""))


def http(method, path, payload=None, cookie=None, csrf=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(f"{PANEL}{path}", data=data, method=method)
    r.add_header("Accept", "application/json")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    if csrf:
        r.add_header("X-CSRF-Token", csrf)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b.strip().startswith(("{", "[")) else b), resp.headers
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b), e.headers
        except Exception:
            return e.code, b, e.headers


# ---------------- 极简 WebSocket 客户端（不依赖第三方库） ----------------
class WS:
    def __init__(self, url_path, cookie):
        from urllib.parse import urlparse
        u = urlparse(PANEL)
        host, port = u.hostname, u.port or 80
        self.sock = socket.create_connection((host, port), timeout=15)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {url_path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"Cookie: {cookie}\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            self.buf += self.sock.recv(4096)
        head, _, rest = self.buf.partition(b"\r\n\r\n")
        self.status = int(head.split(b" ")[1])
        self.buf = rest

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        n = len(payload)
        hdr = bytes([0x81])
        if n < 126:
            hdr += bytes([0x80 | n])
        elif n < 65536:
            hdr += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            hdr += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(hdr + mask + masked)

    def _read_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("连接已关闭")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=8):
        self.sock.settimeout(timeout)
        try:
            b0, b1 = self._read_exact(2)
            opcode = b0 & 0x0F
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            payload = self._read_exact(length)
            if opcode == 0x9:  # ping
                return None
            if opcode == 0x8:
                return {"__closed__": True}
            return json.loads(payload.decode())
        except (socket.timeout, TimeoutError):
            return None

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


print("=" * 88)
print("1. 登录建立会话")
print("=" * 88)
if not PASS:
    raise SystemExit("需要 PANEL_ADMIN_SECRET")
st, res, hdrs = http("POST", "/api/auth/login", {"username": USER, "password": PASS})
if st != 200 or res.get("need2fa"):
    raise SystemExit(f"登录失败：HTTP {st} {res}")
cookie = hdrs.get("Set-Cookie", "").split(";")[0]
csrf = res.get("csrfToken", "")
check("登录成功", st == 200)

print("\n" + "=" * 88)
print("2. 未认证的连接必须被拒（4401）")
print("=" * 88)
try:
    bad = WS("/api/ws", "hsa_sid=invalid-session-id")
    check("未认证连接仍可完成协议升级（由业务层拒绝）", bad.status == 101, f"HTTP {bad.status}")
    # 服务端会先发一个 error 帧，再以 4401 关闭；两帧都可能先到，都要接受
    saw_error = False
    closed = False
    for _ in range(6):
        m = bad.recv(timeout=5)
        if m is None:
            break
        if m.get("__closed__"):
            closed = True
            break
        if m.get("type") == "error":
            saw_error = True
    check("服务端先下发 error 帧", saw_error, "已收到 type=error")
    check("随后以 4401 关闭连接（前端可据此停止重连）", closed, "连接已关闭")
    bad.close()
except Exception as e:
    check("未认证连接被拒", False, repr(e))

print("\n" + "=" * 88)
print("3. 认证连接应收到 hello 握手")
print("=" * 88)
ws = WS("/api/ws", cookie)
check("WebSocket 升级成功", ws.status == 101, f"HTTP {ws.status}")
hello = None
for _ in range(6):
    m = ws.recv(timeout=6)
    if m and m.get("type") == "hello":
        hello = m
        break
check("收到 hello 事件", hello is not None, json.dumps(hello, ensure_ascii=False)[:200] if hello else "无")
if hello:
    d = hello.get("data") or {}
    check("hello 携带订阅主题", isinstance(d.get("topics"), list), str(d.get("topics")))
    check("hello 携带采样间隔", isinstance(d.get("pollIntervalSec"), int), str(d.get("pollIntervalSec")))

print("\n" + "=" * 88)
print("4. 心跳保活")
print("=" * 88)
ws.send("ping")
pong = None
for _ in range(4):
    m = ws.recv(timeout=6)
    if m and m.get("type") == "pong":
        pong = m
        break
check("ping → pong 正常", pong is not None)

print("\n" + "=" * 88)
print("5. 真实写操作是否触发推送（核心）")
print("=" * 88)
st, nodes, _ = http("GET", "/api/nodes", cookie=cookie)
node = (nodes.get("nodes") or [None])[0]
if not node:
    check("存在可操作设备", False, "无设备")
else:
    nid, orig = node["id"], node["displayName"]
    print(f"      目标设备：{orig}（id={nid}）")

    # 先清空缓冲区里可能残留的事件
    while ws.recv(timeout=0.4) is not None:
        pass

    new_name = f"{orig}-ws{nid}"
    st, r, _ = http("POST", f"/api/nodes/{nid}/rename", {"newName": new_name}, cookie=cookie, csrf=csrf)
    check("通过 API 重命名设备", st == 200, f"HTTP {st}")

    got = None
    deadline = time.time() + 12
    while time.time() < deadline:
        m = ws.recv(timeout=3)
        if m and m.get("type") in ("nodes.changed", "users.changed"):
            got = m
            break
    check("WebSocket 收到变更推送（无需等待轮询周期）", got is not None,
          json.dumps(got, ensure_ascii=False)[:220] if got else "未收到")

    if got:
        check("事件类型正确", got.get("type") == "nodes.changed", str(got.get("type")))
        check("事件带时间戳", bool(got.get("ts")), str(got.get("ts")))
        changed = (got.get("data") or {}).get("changed") or []
        check("推送内容含变化后的设备", isinstance(changed, list) and len(changed) > 0,
              str(changed)[:160] if changed else "空")
        if changed:
            check("推送内容是新名字", changed[0].get("displayName") == new_name,
                  str(changed[0].get("displayName")))

    # 改回原名
    st2, _, _ = http("POST", f"/api/nodes/{nid}/rename", {"newName": orig}, cookie=cookie, csrf=csrf)
    check("恢复原名", st2 == 200)
    while ws.recv(timeout=0.5) is not None:
        pass

print("\n" + "=" * 88)
print("6. 路由变更推送")
print("=" * 88)
# ---- 夹具：确保至少有一条可操作路由 ----
# 不依赖其它脚本先跑过。理由：debug/node 的 routes 参数是装饰性的
# （只写进它返回的 echo 节点，真实节点由 RegistrationData 创建，无路由字段），
# 所以新建的节点天然没有路由，必须显式批准一条。
st, routes, _ = http("GET", "/api/routes", cookie=cookie)
rows = routes.get("routes") or []
if not rows:
    st, nodes, _ = http("GET", "/api/nodes", cookie=cookie)
    cand = next((n for n in (nodes.get("nodes") or []) if (n.get("user") or {}).get("name") == "labadmin"), None)
    if cand:
        http("PUT", f"/api/routes/node/{cand['id']}",
             {"routes": ["192.168.10.0/24"], "confirmUnadvertised": True}, cookie=cookie, csrf=csrf)
        st, routes, _ = http("GET", "/api/routes", cookie=cookie)
        rows = routes.get("routes") or []
        print(f"  （夹具：已为节点 #{cand['id']} 批准一条路由）")

if not rows:
    check("存在可操作路由", False, "无路由（且夹具创建失败）")
else:
    r0 = rows[0]
    while ws.recv(timeout=0.4) is not None:
        pass
    enable = not r0["approved"]
    st, r, _ = http("POST", "/api/routes/toggle",
                    {"nodeId": r0["nodeId"], "route": r0["route"], "enable": enable},
                    cookie=cookie, csrf=csrf)
    check(f"{'启用' if enable else '禁用'}路由", st == 200, f"HTTP {st}")
    got = None
    deadline = time.time() + 12
    while time.time() < deadline:
        m = ws.recv(timeout=3)
        if m and m.get("type") == "routes.changed":
            got = m
            break
    check("WebSocket 收到路由变更推送", got is not None,
          json.dumps(got, ensure_ascii=False)[:200] if got else "未收到")
    # 还原
    http("POST", "/api/routes/toggle",
         {"nodeId": r0["nodeId"], "route": r0["route"], "enable": r0["approved"]},
         cookie=cookie, csrf=csrf)

ws.close()

print("\n" + "=" * 88)
print(f"结果：{len(PASSED)} 通过 / {len(FAILED)} 失败")
if FAILED:
    print("失败项：")
    for f in FAILED:
        print(f"  ✗ {f}")
print("=" * 88)
