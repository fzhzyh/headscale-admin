#!/usr/bin/env python3
"""验证写操作与错误路径的真实行为，用于校准面板的护栏逻辑。"""
import json
import os
import urllib.request
import urllib.error

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
        return e.code, e.read().decode()[:500]


def show(label, st, res):
    s = json.dumps(res, ensure_ascii=False) if isinstance(res, (dict, list)) else str(res)
    print(f"  {label:<46} HTTP {st}  {s[:230]}")


print("=" * 100)
print("一、策略校验的失败语义（判断 check 与 set 的校验强度是否一致）")
print("=" * 100)
for name, pol in [
    ("合法策略", '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}'),
    ("语法错误(缺括号)", '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}'),
    ("语义错误(非法action)", '{"acls":[{"action":"allow","src":["*"],"dst":["*:*"]}]}'),
    ("引用未定义tag", '{"acls":[{"action":"accept","src":["tag:nope"],"dst":["*:*"]}]}'),
    ("引用未定义host", '{"acls":[{"action":"accept","src":["nohost"],"dst":["*:*"]}]}'),
]:
    st, res = call("POST", "/api/v1/policy/check", {"policy": pol})
    show(f"check {name}", st, res)

print("\n" + "=" * 100)
print("二、节点写操作（含错误路径）")
print("=" * 100)
st, res = call("POST", "/api/v1/node/1/rename/lab-alpha-renamed")
show("rename node 1", st, res)
st, res = call("POST", "/api/v1/node/1/rename/lab-alpha")
show("rename back", st, res)

st, res = call("POST", "/api/v1/node/1/tags", {"nodeId": "1", "tags": ["tag:lab", "tag:prod"]})
show("set tags [tag:lab,tag:prod]", st, res)
st, res = call("POST", "/api/v1/node/1/tags", {"nodeId": "1", "tags": ["bad-tag-format"]})
show("set tags 非法格式", st, res)

print("\n--- approve_routes 语义：是否只接受已通告路由 ---")
st, res = call("POST", "/api/v1/node/1/approve_routes", {"nodeId": "1", "routes": ["192.168.10.0/24"]})
show("批准未通告路由 192.168.10.0/24", st, res)
st, res = call("GET", "/api/v1/node/1")
if isinstance(res, dict) and "node" in res:
    show("→ 节点当前 approved/available", 200,
         {"approved": res["node"].get("approvedRoutes"), "available": res["node"].get("availableRoutes"),
          "subnet": res["node"].get("subnetRoutes")})

print("\n--- expire 语义 ---")
st, res = call("POST", "/api/v1/node/2/expire", {"nodeId": "2", "disableExpiry": True})
if isinstance(res, dict) and "node" in res:
    show("disableExpiry=true → expiry", st, {"expiry": res["node"].get("expiry")})
st, res = call("POST", "/api/v1/node/2/expire", {"nodeId": "2", "expiry": "2027-06-01T00:00:00Z"})
if isinstance(res, dict) and "node" in res:
    show("设置具体到期时间 → expiry", st, {"expiry": res["node"].get("expiry")})
st, res = call("POST", "/api/v1/node/2/expire", {"nodeId": "2"})
if isinstance(res, dict) and "node" in res:
    show("不带参数 → expiry", st, {"expiry": res["node"].get("expiry")})

print("\n" + "=" * 100)
print("三、用户写操作")
print("=" * 100)
st, res = call("POST", "/api/v1/user", {"name": "temptest", "displayName": "临时", "email": "t@example.com"})
show("create user temptest", st, res)
new_id = (res.get("user") or {}).get("id") if isinstance(res, dict) else None
st, res = call("POST", "/api/v1/user", {"name": "temptest"})
show("重复创建同名用户", st, res)
if new_id:
    st, res = call("POST", f"/api/v1/user/{new_id}/rename/temptest2")
    show("rename user", st, res)
    st, res = call("DELETE", f"/api/v1/user/{new_id}")
    show("delete user", st, res)
st, res = call("DELETE", "/api/v1/user/1")
show("删除仍有设备的用户(id=1)", st, res)

print("\n" + "=" * 100)
print("四、API Key")
print("=" * 100)
st, res = call("POST", "/api/v1/apikey", {"expiration": "2027-01-01T00:00:00Z"})
show("create apikey", st, res)
st, res = call("GET", "/api/v1/apikey")
show("list apikey", st, res)

print("\n" + "=" * 100)
print("五、认证失败路径")
print("=" * 100)
for label, hdr in [("无 Authorization", None), ("错误前缀", "Token abc"), ("无效 key", "Bearer '" + KEY + "'")]:
    req = urllib.request.Request(f"{BASE}/api/v1/node", method="GET",
                                 headers={"Accept": "application/json"})
    if hdr:
        req.add_header("Authorization", hdr)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            print(f"  {label:<30} HTTP {r.status}  {r.read().decode()[:120]}")
    except urllib.error.HTTPError as e:
        print(f"  {label:<30} HTTP {e.code}  {e.read().decode()[:120]}")

print("\n" + "=" * 100)
print("六、不存在的资源")
print("=" * 100)
st, res = call("GET", "/api/v1/node/99999")
show("GET 不存在的节点", st, res)
st, res = call("DELETE", "/api/v1/node/99999")
show("DELETE 不存在的节点", st, res)
st, res = call("GET", "/api/v1/nonexistent")
show("不存在的端点", st, res)
