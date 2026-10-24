#!/usr/bin/env python3
"""确认无 body 绑定的端点：字段必须走查询参数，body 会被静默忽略。"""
import json
import os
import urllib.request
import urllib.error
import urllib.parse

BASE = "http://127.0.0.1:18080"
KEY = load_hs_key()


def call(method, path, payload=None):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            b = r.read().decode()
            return r.status, (json.loads(b) if b else {})
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def expiry_of(node_id):
    st, res = call("GET", f"/api/v1/node/{node_id}")
    if isinstance(res, dict) and "node" in res:
        e = res["node"].get("expiry")
        return e if e else None
    return f"ERR{st}"


print("=" * 100)
print("A. ExpireNode —— body 是否被忽略？（node 2）")
print("=" * 100)
print(f"  基线 expiry = {expiry_of(2)}")

st, res = call("POST", "/api/v1/node/2/expire", {"disableExpiry": True})
print(f"  body 传 disableExpiry=true                 HTTP {st} → expiry={expiry_of(2)}")

st, res = call("POST", "/api/v1/node/2/expire?disable_expiry=true")
print(f"  query 传 disable_expiry=true               HTTP {st} → expiry={expiry_of(2)}")

st, res = call("POST", "/api/v1/node/2/expire?disableExpiry=true")
print(f"  query 传 disableExpiry=true (camelCase)    HTTP {st} → expiry={expiry_of(2)}")

st, res = call("POST", "/api/v1/node/2/expire?expiry=2027-06-01T00:00:00Z")
print(f"  query 传 expiry=2027-06-01                 HTTP {st} → expiry={expiry_of(2)}")

st, res = call("POST", "/api/v1/node/2/expire")
print(f"  不带任何参数（立即过期）                     HTTP {st} → expiry={expiry_of(2)}")

print("\n" + "=" * 100)
print("B. RegisterNode —— body 还是 query？（user=devops）")
print("=" * 100)
import secrets, string
ALPHABET = string.ascii_letters + string.digits + "-_"


def mk_authid():
    return "hskey-authreq-" + "".join(secrets.choice(ALPHABET) for _ in range(24))


aid = mk_authid()
call("POST", "/api/v1/debug/node", {"user": "devops", "key": aid, "name": "lab-delta"})
st, res = call("POST", "/api/v1/node/register", {"user": "devops", "key": aid})
print(f"  body 传 {{user,key}}                        HTTP {st}  {json.dumps(res)[:180] if isinstance(res,dict) else res}")

aid2 = mk_authid()
call("POST", "/api/v1/debug/node", {"user": "devops", "key": aid2, "name": "lab-epsilon"})
qs = urllib.parse.urlencode({"user": "devops", "key": aid2})
st, res = call("POST", f"/api/v1/node/register?{qs}")
if isinstance(res, dict) and "node" in res:
    n = res["node"]
    print(f"  query 传 ?user=&key=                       HTTP {st}  → id={n.get('id')} name={n.get('name')} ips={n.get('ipAddresses')}")
else:
    print(f"  query 传 ?user=&key=                       HTTP {st}  {res}")

print("\n" + "=" * 100)
print("C. DeletePreAuthKey —— id 怎么传？")
print("=" * 100)
st, res = call("POST", "/api/v1/preauthkey", {"user": "1", "reusable": False, "ephemeral": False,
                                              "expiration": "2027-01-01T00:00:00Z", "aclTags": []})
kid = (res.get("preAuthKey") or {}).get("id") if isinstance(res, dict) else None
print(f"  新建 preauthkey id={kid}")

st, res = call("DELETE", "/api/v1/preauthkey", {"id": kid})
print(f"  DELETE + body{{id}}                         HTTP {st}  {json.dumps(res)[:120] if isinstance(res,dict) else res}")
st, res = call("DELETE", f"/api/v1/preauthkey?id={kid}")
print(f"  DELETE ?id={kid}                            HTTP {st}  {json.dumps(res)[:120] if isinstance(res,dict) else res}")

st, res = call("GET", "/api/v1/preauthkey")
keys = res.get("preAuthKeys", []) if isinstance(res, dict) else []
print(f"  剩余 preauthkey: {[k.get('id') for k in keys]}")

print("\n" + "=" * 100)
print("D. 最终节点清单")
print("=" * 100)
st, res = call("GET", "/api/v1/node")
for n in (res.get("nodes", []) if isinstance(res, dict) else []):
    print(f"  id={n.get('id')} {n.get('name'):<16} user={(n.get('user') or {}).get('name'):<10} "
          f"expiry={n.get('expiry')} approved={n.get('approvedRoutes')}")
