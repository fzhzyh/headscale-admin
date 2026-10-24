#!/usr/bin/env python3
"""定位：为何内联 python 能连 headscale，而 e2e_acl.py 报 401。

对比维度：
  1. 两者读到的 HS_API_KEY 是否一致（长度 / 指纹）
  2. _local_net 的代理禁用是否真正生效（打印生效后的 proxies）
  3. 实际发出的请求头
"""
import hashlib
import json
import os
import sys
import urllib.request
import urllib.error

print("=== A. 未经 _local_net 处理 ===")
print(f"  HS_API_KEY 长度={len(os.environ.get('HS_API_KEY',''))} "
      f"指纹={hashlib.sha256(os.environ.get('HS_API_KEY','').encode()).hexdigest()[:8]}")
print(f"  urllib 解析到的代理: {urllib.request.getproxies() or '无'}")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local

bypass_proxy_for_local()

print("\n=== B. _local_net 处理后 ===")
print(f"  HS_API_KEY 长度={len(os.environ.get('HS_API_KEY',''))} "
      f"指纹={hashlib.sha256(os.environ.get('HS_API_KEY','').encode()).hexdigest()[:8]}")
print(f"  urllib 解析到的代理: {urllib.request.getproxies() or '无'}")
for v in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY"):
    print(f"    {v} = {os.environ.get(v)!r}")

print("\n=== C. 用与 e2e_acl.py 完全相同的方式请求 ===")
HS = os.environ.get("HS_URL", "http://127.0.0.1:18080")
HSKEY = os.environ.get("HS_API_KEY", "")


def hs_call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        f"{HS}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {HSKEY}", "Content-Type": "application/json"},
    )
    print(f"  → {method} {HS}{path}")
    print(f"    Authorization: Bearer {HSKEY[:14]}…{HSKEY[-6:]}（长度 {len(HSKEY)}）")
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b.strip().startswith(("{", "[")) else b)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


for m, p, d in [
    ("GET", "/api/v1/node", None),
    ("GET", "/api/v1/policy", None),
    ("POST", "/api/v1/debug/node", {"user": "labadmin", "key": "hskey-authreq-" + "x" * 24, "name": "diag", "routes": []}),
]:
    st, body = hs_call(m, p, d)
    print(f"    ← HTTP {st}  {str(body)[:110]}")
