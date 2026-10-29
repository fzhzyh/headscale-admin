#!/usr/bin/env python3
"""联调脚本的本地网络前置处理。

⚠️ 踩过的坑（导致过大量「间歇性 401」的假故障）：
macOS 上 `urllib.request` 会通过 `getproxies_macosx_sysconf()` **读取系统代理设置**。
本机存在代理（实测 127.0.0.1:7897）时，发往 127.0.0.1:8080 / :18080 的请求会被
**送去代理**，于是：

  - 同一个 API Key，`curl` 走直连返回 200，同一 shell 里的 Python urllib 返回 401
  - 更糟的是**时好时坏**——代理正常时 200，异常时 401，
    被误判成「Key 失效」「面板鉴权坏了」，浪费大量排查时间

修法：让联调脚本对本地回环地址**强制直连**（不用代理）。
这是测试脚本的职责，不该改系统代理设置。

用法（放在脚本 import 之后、发请求之前）：

    from _local_net import bypass_proxy_for_local
    bypass_proxy_for_local()
"""
import os
import re
import pathlib
import urllib.request

#: headscale API Key 的正确总长度（`hskey-api-` + 13 位前缀 + `_` + 64 位密钥）
HS_KEY_LEN = 87
HS_KEY_RE = re.compile(r"^hskey-api-[A-Za-z0-9_-]+$")


def bypass_proxy_for_local() -> None:
    """让本进程内所有 urllib 请求不走代理（本地联调场景的正确做法）。"""
    # 1) 装一个「无代理」的全局 opener —— 这是决定性的，不依赖环境变量解析
    urllib.request.install_opener(
        urllib.request.build_opener(urllib.request.ProxyHandler({}))
    )

    # 2) 同时把 no_proxy 设上：有些库不走 urllib 的全局 opener，
    #    而是自己读环境变量（如 requests / httpx 默认行为）
    for var in ("no_proxy", "NO_PROXY"):
        cur = os.environ.get(var, "")
        wanted = ["127.0.0.1", "localhost", "::1", "0.0.0.0"]
        parts = [p for p in cur.split(",") if p]
        for w in wanted:
            if w not in parts:
                parts.append(w)
        os.environ[var] = ",".join(parts)

    # 3) 顺手清掉常见的代理变量，避免子进程（如 curl）行为不一致
    for var in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        os.environ.pop(var, None)


def load_hs_key(env_file: str | pathlib.Path = "server/.env") -> str:
    """取得 headscale API Key。

    ⚠️ 为什么不能只读环境变量：
    把密钥**字面写进命令字符串**再执行时，工具链的密钥脱敏层会**间歇性地**
    多插入一个字符（实测症状：headscale 报
    `failed to parse ApiKey: length mismatch, expected 64 chars, got 65` → 401）。
    同一 Key 有时 87 位正常、有时 88 位被拒，表现为「时好时坏」的假故障，
    极易被误判为「Key 失效」「面板鉴权坏了」「headscale 有 bug」。

    因此：**以文件为准**（`server/.env`，也就是面板自己用的那份），
    环境变量只在文件不可用时作为回退，且无论来源都要过格式与长度校验。

    参数 `env_file` 相对仓库根目录解析。
    """
    candidates: list[tuple[str, str]] = []

    env_val = os.environ.get("HS_API_KEY", "")
    if env_val:
        candidates.append(("环境变量 HS_API_KEY", env_val.strip()))

    here = pathlib.Path(__file__).resolve().parent
    repo = here.parent

    # 容器化环境：密钥由 container/up.sh 写入 state/hs-api-key（headscale 重建后仍有效）
    container_key = repo / "container" / "state" / "hs-api-key"
    if container_key.is_file():
        candidates.append((str(container_key), container_key.read_text(encoding="utf-8").strip()))

    # 从仓库根或脚本目录向上找 .env（容器化之前的裸进程环境）
    for base in (repo, here, pathlib.Path.cwd()):
        p = base / env_file
        if p.is_file():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("HS_API_KEY="):
                    candidates.append((str(p), line.split("=", 1)[1].strip()))
                    break
            break

    problems: list[str] = []
    for source, key in candidates:
        if not HS_KEY_RE.match(key):
            problems.append(f"{source}: 格式不符（{key[:14]}…）")
            continue
        if len(key) != HS_KEY_LEN:
            problems.append(f"{source}: 长度 {len(key)}，应为 {HS_KEY_LEN}（疑似被篡改）")
            continue
        return key

    detail = "\n".join(f"    - {p}" for p in problems) or "    - 未找到任何来源"
    raise SystemExit(
        "无法取得有效的 headscale API Key：\n"
        f"{detail}\n"
        f"  请把 Key 写入 {env_file}（形如 HS_API_KEY=hskey-api-…，共 {HS_KEY_LEN} 位），\n"
        "  不要把密钥直接写在命令行里——那会被脱敏层间歇性篡改。"
    )


def load_endpoints(env_file: str | pathlib.Path = "container/endpoints.env") -> dict[str, str]:
    """取得联调环境各服务的**对外地址**。

    统一约定：测试一律访问**对外 IP**（本机 Tailscale IP），不直接写 127.0.0.1。
    原因有两个：
      1. 容器化后服务不再跑在宿主回环上，127.0.0.1 根本连不到
      2. 对外地址就是真实使用者的访问路径，拿它做测试才能同时验证
         「发布是否真的通」——只测 127.0.0.1 会漏掉一整类问题

    地址由 `container/up.sh` 写入 `container/endpoints.env`。
    """
    # 兜底地址：优先用 PUBLIC_IP（与 container/up.sh 同一个变量），
    # 都没有时留空 —— 让缺失显式暴露，而不是静默连一个猜出来的地址。
    # 正常情况下这些值会被下面读到的 container/endpoints.env 覆盖。
    public_ip = os.environ.get("PUBLIC_IP", "")
    _mk = (lambda port: f"http://{public_ip}:{port}") if public_ip else (lambda port: "")
    defaults = {
        "PANEL_URL": _mk(8080),
        "HS_URL": _mk(18080),
        "HS_DEBUG_URL": _mk(19090),
    }
    here = pathlib.Path(__file__).resolve().parent
    for base in (here.parent, here, pathlib.Path.cwd()):
        p = base / env_file
        if p.is_file():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                defaults[k.strip()] = v.strip()
            break
    # 合并 container/lab.env（面板管理员口令等），省得每个脚本各自解析
    for base in (here.parent, here, pathlib.Path.cwd()):
        p = base / "container" / "lab.env"
        if p.is_file():
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                defaults.setdefault(k.strip(), v.strip())
            break

    # 显式环境变量优先级最高（便于临时指向别处）
    for k in list(defaults):
        if os.environ.get(k):
            defaults[k] = os.environ[k]
    return defaults


def assert_local_reachable(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    """自检：确认本地服务真的能直连到（把网络问题与业务问题分开）。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return True, f"HTTP {r.status}"
    except Exception as e:  # noqa: BLE001 — 自检只关心「通不通」
        return False, str(e)

