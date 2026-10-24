#!/usr/bin/env python3
"""联调环境整理：删除测试用的临时设备，把策略恢复到安全的基线状态。

为什么需要：headscale 的打标签不可逆，测试崩溃或中断时会留下
「已打标签的孤儿设备」（永远挂在 tagged-devices 名下无法还原）。
每次跑 E2E 前先清理，保证用例可重复。

用法：
    HS_API_KEY=... python3 lab/reset_lab.py            # 只清理
    HS_API_KEY=... python3 lab/reset_lab.py --baseline # 清理并把策略重置为「规则」模式
"""
import json
import os
import sys
import urllib.request
import urllib.error

# 本地联调：强制直连，避免 macOS 系统代理把 127.0.0.1 的请求送去代理
# （曾导致「同一 Key 时而 200 时而 401」的间歇性假故障，详见 _local_net.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local  # noqa: E402

bypass_proxy_for_local()

HS = os.environ.get("HS_URL", "http://127.0.0.1:18080")
KEY = os.environ.get("HS_API_KEY", "")
TMP_PREFIXES = ("lab-acl-tmp-",)
BASELINE = {"acls": [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}]}

if not KEY:
    raise SystemExit("需要 HS_API_KEY")


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        f"{HS}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b.strip().startswith(("{", "[")) else b)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


print("=== 1. 删除临时设备 ===")
st, res = call("GET", "/api/v1/node")
nodes = res.get("nodes", []) if isinstance(res, dict) else []
removed = 0
for n in nodes:
    if any(n["name"].startswith(p) for p in TMP_PREFIXES):
        st2, _ = call("DELETE", f"/api/v1/node/{n['id']}")
        print(f"  删除 {n['name']} (id={n['id']}) → HTTP {st2}")
        removed += 1
print(f"  共删除 {removed} 台" if removed else "  无需清理")

print("\n=== 2. 节点现状 ===")
st, res = call("GET", "/api/v1/node")
for n in (res.get("nodes", []) if isinstance(res, dict) else []):
    u = n.get("user") or {}
    print(f"  id={n['id']:<3} {n['name']:<18} user={u.get('name', '—'):<18} tags={n.get('tags') or '[]'}")

if "--baseline" in sys.argv:
    print("\n=== 3. 策略重置为基线（规则模式）===")
    st, _ = call("PUT", "/api/v1/policy", {"policy": json.dumps(BASELINE)})
    print(f"  PUT /api/v1/policy → HTTP {st}")
    st, res = call("GET", "/api/v1/policy")
    print(f"  当前策略：{str((res or {}).get('policy', res))[:120]}")
