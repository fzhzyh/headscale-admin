#!/usr/bin/env python3
"""量化：对 headscale 直连写操作的 401 发生率（判断是否间歇性）。

背景：同一脚本同一 Key，`GET /api/v1/node` 稳定 200，
但 `PUT /api/v1/policy`（带 body 的写操作）间歇性 401。
本探针连续调用并统计失败率，以区分「稳定缺陷」与「间歇故障」。
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_hs_key

bypass_proxy_for_local()

HS = os.environ.get("HS_URL", "http://127.0.0.1:18080")
KEY = load_hs_key()
POLICY = {"acls": [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}]}


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        f"{HS}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, resp.read().decode()[:60]
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:60]
    except Exception as e:  # noqa: BLE001
        return -1, str(e)[:60]


N = 20

print(f"=== 1. PUT /api/v1/policy × {N}（带 body 的写操作）===")
fails = 0
for i in range(N):
    st, body = call("PUT", "/api/v1/policy", {"policy": json.dumps(POLICY)})
    if st != 200:
        fails += 1
        print(f"  #{i+1:02d} HTTP {st}  {body}")
print(f"  → 失败 {fails}/{N}")

print(f"\n=== 2. GET /api/v1/node × {N}（只读对照）===")
gfails = 0
for i in range(N):
    st, body = call("GET", "/api/v1/node")
    if st != 200:
        gfails += 1
        print(f"  #{i+1:02d} HTTP {st}  {body}")
print(f"  → 失败 {gfails}/{N}")

print(f"\n=== 3. POST /api/v1/debug/node × {N}（带 body 的写操作）===")
dfails = 0
for i in range(N):
    st, body = call("POST", "/api/v1/debug/node",
                    {"user": "labadmin", "key": "hskey-authreq-" + "y" * 24, "name": f"diag{i}", "routes": []})
    if st != 200:
        dfails += 1
        print(f"  #{i+1:02d} HTTP {st}  {body}")
print(f"  → 失败 {dfails}/{N}")

print(f"\n=== 汇总 ===")
print(f"  PUT  policy     : {fails}/{N} 失败")
print(f"  GET  node       : {gfails}/{N} 失败")
print(f"  POST debug/node : {dfails}/{N} 失败")
if fails or dfails:
    print("  ⇒ 写操作存在失败，属于稳定缺陷或高概率间歇故障，需继续定位")
else:
    print("  ⇒ 本轮全部成功。说明是间歇性故障（与时间/状态相关），非稳定缺陷")
