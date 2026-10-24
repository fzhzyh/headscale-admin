#!/usr/bin/env python3
"""排查：RenameNode 到底改的是哪个字段？"""
import json
import os
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:18080"
KEY = "'" + os.environ.get("HS_API_KEY","") + "'"


def call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method,
                               headers={"Authorization": f"Bearer {KEY}",
                                        "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def fields(nid):
    st, res = call("GET", f"/api/v1/node/{nid}")
    if isinstance(res, dict) and "node" in res:
        n = res["node"]
        return {k: n.get(k) for k in ("id", "name", "givenName")}
    return f"ERR {st} {res}"


print("改名前:", json.dumps(fields(1), ensure_ascii=False))

st, res = call("POST", "/api/v1/node/1/rename/lab-alpha-RENAMED")
print(f"\nrename → lab-alpha-RENAMED : HTTP {st}")
if isinstance(res, dict) and "node" in res:
    n = res["node"]
    print(f"  响应里的 name={n.get('name')!r}  givenName={n.get('givenName')!r}")
else:
    print(f"  {res}")

print("改名后:", json.dumps(fields(1), ensure_ascii=False))

# 改回
st, res = call("POST", "/api/v1/node/1/rename/lab-alpha")
print(f"\nrename → lab-alpha : HTTP {st}")
if isinstance(res, dict) and "node" in res:
    n = res["node"]
    print(f"  响应里的 name={n.get('name')!r}  givenName={n.get('givenName')!r}")
print("改回后:", json.dumps(fields(1), ensure_ascii=False))

print("\n=== 用 JSON 输出模式看 CLI 怎么显示的 ===")
