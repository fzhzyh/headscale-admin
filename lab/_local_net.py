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
import urllib.request


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


def assert_local_reachable(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    """自检：确认本地服务真的能直连到（把网络问题与业务问题分开）。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return True, f"HTTP {r.status}"
    except Exception as e:  # noqa: BLE001 — 自检只关心「通不通」
        return False, str(e)
