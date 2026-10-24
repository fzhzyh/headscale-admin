#!/usr/bin/env python3
"""造联调测试节点：debug/node 写入注册缓存 → auth/register 落成真实节点。

headscale 的 DebugCreateNode 只校验 authID 格式（hskey-authreq- + 24 位），
所以可以自造，无需真实客户端。
"""
import json
import os
import secrets
import string
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:18080"
KEY = "'" + os.environ.get("HS_API_KEY","") + "'"
ALPHABET = string.ascii_letters + string.digits + "-_"

NODES = [
    ("labadmin", "lab-alpha", "192.168.10.0/24"),
    ("devops", "lab-beta", "10.20.0.0/16"),
    ("labadmin", "lab-gamma", "172.16.5.0/24"),
]


def call(path, payload=None, method="POST"):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:400]


def make_authid():
    return "hskey-authreq-" + "".join(secrets.choice(ALPHABET) for _ in range(24))


for user, name, route in NODES:
    auth_id = make_authid()
    print(f"\n=== {name} (user={user}, route={route})")
    print(f"  authId: {auth_id}")

    st, res = call("/api/v1/debug/node", {"user": user, "key": auth_id, "name": name, "routes": [route]})
    print(f"  debug/node  → HTTP {st}: {json.dumps(res, ensure_ascii=False)[:200]}")

    st, res = call("/api/v1/auth/register", {"user": user, "authId": auth_id})
    if isinstance(res, dict) and "node" in res:
        n = res["node"]
        print(f"  auth/register → HTTP {st}: id={n.get('id')} name={n.get('name')} "
              f"ips={n.get('ipAddresses')} online={n.get('online')} routes={n.get('availableRoutes')}")
    else:
        print(f"  auth/register → HTTP {st}: {res}")

st, res = call("/api/v1/node", method="GET")
print(f"\n=== 最终节点列表 HTTP {st} ===")
nodes = res.get("nodes", []) if isinstance(res, dict) else []
print(f"共 {len(nodes)} 台")
for n in nodes:
    print(f"  id={n.get('id')} name={n.get('name')} user={(n.get('user') or {}).get('name')} "
          f"ips={n.get('ipAddresses')} online={n.get('online')} "
          f"avail={n.get('availableRoutes')} approved={n.get('approvedRoutes')} tags={n.get('tags')}")

# 完整打印一个节点，用于核对前端字段映射
if nodes:
    print("\n=== 单个节点完整结构（字段映射核对）===")
    print(json.dumps(nodes[0], indent=2, ensure_ascii=False))
