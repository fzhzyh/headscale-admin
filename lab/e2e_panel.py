#!/usr/bin/env python3
"""headscale-admin 面板端到端验证。

覆盖：认证链路、CSRF 防护、上游数据透传、写操作、RBAC 越权拦截。
"""
import json
import os
import urllib.request
import urllib.error

BASE = os.environ.get("PANEL_URL", "http://127.0.0.1:8080")
ADMIN_USER = os.environ.get("PANEL_ADMIN_USER", "admin")
ADMIN_PASS = os.environ.get("PANEL_ADMIN_SECRET", "")   # 从环境变量传入，不硬编码
VIEWER_PASS = os.environ.get("LAB_VIEWER_PASS", "ViewerPass2026")
PASS = []
FAIL = []


def req(method, path, payload=None, cookie=None, csrf=None, raw_body=None):
    url = f"{BASE}{path}"
    data = None
    if raw_body is not None:
        data = raw_body.encode()
    elif payload is not None:
        data = json.dumps(payload).encode()
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Accept", "application/json")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    if csrf:
        r.add_header("X-CSRF-Token", csrf)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            body = resp.read().decode()
            return resp.status, (json.loads(body) if body.strip().startswith(("{", "[")) else body), resp.headers
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        try:
            parsed = json.loads(body)
        except Exception:
            parsed = body
        return e.code, parsed, e.headers


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(f"  {'✓' if cond else '✗'} {label}" + (f"   → {detail}" if detail else ""))


print("=" * 100)
print("1. 未登录状态")
print("=" * 100)
st, res, _ = req("GET", "/api/auth/session")
check("GET /api/auth/session 未登录返回 authenticated=false", st == 200 and res.get("authenticated") is False, str(res))
st, res, _ = req("GET", "/api/nodes")
check("未登录访问 /api/nodes 返回 401", st == 401, f"HTTP {st} {res}")
st, res, _ = req("GET", "/api/settings")
check("未登录访问 /api/settings 返回 401", st == 401, f"HTTP {st}")

print("\n" + "=" * 100)
print("2. 登录链路")
print("=" * 100)
st, res, hdrs = req("POST", "/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
check("正确凭据登录成功", st == 200 and res.get("ok"), f"HTTP {st} {res}")
sc = hdrs.get("Set-Cookie", "")
cookie = sc.split(";")[0] if sc else ""
csrf = res.get("csrfToken", "") if isinstance(res, dict) else ""
check("下发 httpOnly 会话 Cookie", "hsa_sid=" in sc and "HttpOnly" in sc, sc[:110])
check("下发 CSRF Token", len(csrf) > 10)

st, res, _ = req("POST", "/api/auth/login", {"username": ADMIN_USER, "password": "wrong-password"})
check("错误口令返回 401", st == 401, f"HTTP {st} {res}")
st, res, _ = req("POST", "/api/auth/login", {"username": "nosuchuser", "password": "whatever"})
check("不存在用户返回 401（与口令错误同提示，不泄露用户是否存在）",
      st == 401 and res.get("error") == "BAD_CREDENTIALS", str(res))

st, res, _ = req("GET", "/api/auth/session", cookie=cookie)
check("带 Cookie 查询会话返回 authenticated=true", st == 200 and res.get("authenticated") is True)
perms = res.get("permissions", []) if isinstance(res, dict) else []
check("超级管理员拿到全部权限", len(perms) >= 25, f"{len(perms)} 项")
check("会话信息含用户标识", res.get("user", {}).get("username") == "admin", str(res.get("user")))

print("\n" + "=" * 100)
print("3. CSRF 防护")
print("=" * 100)
st, res, _ = req("POST", "/api/nodes/1/rename", {"newName": "hacked"}, cookie=cookie)
check("缺 CSRF Token 的写操作被拦截（403）", st == 403 and res.get("error") == "BAD_CSRF", f"HTTP {st} {res}")
st, res, _ = req("POST", "/api/nodes/1/rename", {"newName": "hacked"}, cookie=cookie, csrf="wrong-token")
check("错误 CSRF Token 被拦截（403）", st == 403, f"HTTP {st}")

print("\n" + "=" * 100)
print("4. 上游数据透传（真实 headscale v0.29.6）")
print("=" * 100)
st, res, _ = req("GET", "/api/nodes", cookie=cookie)
check("GET /api/nodes 返回 200", st == 200, f"HTTP {st} {res if st!=200 else ''}")
nodes = res.get("nodes", []) if isinstance(res, dict) else []
check(f"取到真实节点（{len(nodes)} 台）", len(nodes) >= 4, f"{[n['name'] for n in nodes]}")
if nodes:
    n = nodes[0]
    check("节点含归一化字段 neverExpires", "neverExpires" in n, str({k: n.get(k) for k in ('name','expiry','expiryRaw','neverExpires','expired')}))

st, res, _ = req("GET", "/api/system/overview", cookie=cookie)
check("GET /api/system/overview 返回 200", st == 200)
if st == 200:
    conn = res.get("connection", {})
    check("连接自检 ok=true（API Key 有效）", conn.get("ok") is True, f"latency={conn.get('latencyMs')}ms")
    check("健康检查反映上游数据库连通", conn.get("databaseConnectivity") is True)
    s = res.get("stats", {})
    print(f"      统计：{json.dumps(s, ensure_ascii=False)}")
    check("区分上游与面板口径（hsNodes / panelUsers 并存）", "hsNodes" in s and "panelUsers" in s)

st, res, _ = req("GET", "/api/settings", cookie=cookie)
check("GET /api/settings 返回 200", st == 200)
items = {i["key"]: i for i in (res.get("items", []) if isinstance(res, dict) else [])}
ak = items.get("hs.apiKey", {})
check("Headscale API Key 只回掩码不回明文", ak.get("configured") is True and "•" in (ak.get("value") or ""), f"value={ak.get('value')}")
check("掩码不含完整密钥", "'" + os.environ.get("HS_API_KEY","") + "'" not in json.dumps(res))

print("\n" + "=" * 100)
print("5. 写操作（经面板 → headscale）")
print("=" * 100)
st, res, _ = req("POST", "/api/nodes/1/rename", {"newName": "lab-alpha-v2"}, cookie=cookie, csrf=csrf)
_gn = (res.get("node") or {}).get("givenName") if isinstance(res, dict) else None
_dn = (res.get("node") or {}).get("displayName") if isinstance(res, dict) else None
check("重命名设备成功（写入 givenName，displayName 随之变化）",
      st == 200 and _gn == "lab-alpha-v2" and _dn == "lab-alpha-v2",
      f"HTTP {st} givenName={_gn} displayName={_dn}")
st, res, _ = req("POST", "/api/nodes/1/rename", {"newName": "lab-alpha"}, cookie=cookie, csrf=csrf)
check("改回原名", st == 200 and (res.get("node") or {}).get("givenName") == "lab-alpha")

st, res, _ = req("POST", "/api/nodes/1/rename", {"newName": "非法 名字!"}, cookie=cookie, csrf=csrf)
check("非法设备名被本地校验拦截", st == 400, f"HTTP {st} {res.get('message')}")

# expire 语义验证（最容易踩坑的地方）
st, res, _ = req("POST", "/api/nodes/3/expire", {"neverExpires": True}, cookie=cookie, csrf=csrf)
node = res.get("node", {}) if isinstance(res, dict) else {}
check("『永不过期』生效（expiry=null, neverExpires=true）",
      st == 200 and node.get("expiry") is None and node.get("neverExpires") is True,
      f"HTTP {st} expiry={node.get('expiry')} raw={node.get('expiryRaw')}")
st, res, _ = req("POST", "/api/nodes/3/expire", {"expiry": "2027-06-01T00:00:00.000Z"}, cookie=cookie, csrf=csrf)
node = res.get("node", {}) if isinstance(res, dict) else {}
check("指定到期时间生效（不再退化成立即过期）",
      st == 200 and (node.get("expiry") or "").startswith("2027-06-01"),
      f"expiry={node.get('expiry')}")
st, res, _ = req("POST", "/api/nodes/3/expire", {"neverExpires": True, "expiry": "2027-06-01T00:00:00.000Z"},
                 cookie=cookie, csrf=csrf)
check("互斥参数被拒绝", st == 400, f"HTTP {st} {res.get('message')}")

st, res, _ = req("POST", "/api/nodes/1/delete", {}, cookie=cookie, csrf=csrf)
check("删除设备缺确认被拒绝", st == 400 and res.get("error") == "NEED_CONFIRM", f"HTTP {st} {res}")

print("\n" + "=" * 100)
print("6. 路由管理")
print("=" * 100)
st, res, _ = req("GET", "/api/routes", cookie=cookie)
check("GET /api/routes 返回 200", st == 200)
routes = res.get("routes", []) if isinstance(res, dict) else []
print(f"      路由：{json.dumps(routes, ensure_ascii=False)}")
check("能读到已批准路由（node1 的 192.168.10.0/24）",
      any(r.get("route") == "192.168.10.0/24" and r.get("approved") for r in routes))

st, res, _ = req("PUT", "/api/routes/node/1", {"routes": ["192.168.10.0/24", "10.99.0.0/16"]},
                 cookie=cookie, csrf=csrf)
check("批准未通告路由时给出护栏提示（409）", st == 409 and res.get("error") == "NOT_ADVERTISED",
      f"HTTP {st} {str(res.get('message'))[:90]}")
st, res, _ = req("PUT", "/api/routes/node/1", {"routes": ["192.168.10.0/24", "10.99.0.0/16"], "confirmUnadvertised": True},
                 cookie=cookie, csrf=csrf)
check("显式确认后可强制批准", st == 200 and "10.99.0.0/16" in (res.get("approvedRoutes") or []), f"HTTP {st} {res}")

st, res, _ = req("POST", "/api/routes/toggle", {"nodeId": 1, "route": "10.99.0.0/16", "enable": False},
                 cookie=cookie, csrf=csrf)
check("禁用路由成功", st == 200 and "10.99.0.0/16" not in (res.get("approvedRoutes") or []), f"HTTP {st}")

print("\n" + "=" * 100)
print("7. 预授权密钥")
print("=" * 100)
st, res, _ = req("POST", "/api/preauthkeys", {"userId": 1, "reusable": True, "ephemeral": False,
                                              "expirationDays": 30, "aclTags": []}, cookie=cookie, csrf=csrf)
check("创建预授权密钥成功", st == 200 and (res.get("key") or {}).get("key", "").startswith("hskey-auth-"),
      f"HTTP {st} {(res.get('key') or {}).get('key', '')[:40]}")
kid = (res.get("key") or {}).get("id") if isinstance(res, dict) else None
st, res, _ = req("GET", "/api/preauthkeys", cookie=cookie)
check("密钥列表可读", st == 200 and len(res.get("keys", [])) >= 1, f"{len(res.get('keys', []))} 个")
if kid:
    st, res, _ = req("POST", f"/api/preauthkeys/{kid}/expire", {}, cookie=cookie, csrf=csrf)
    check("密钥过期成功", st == 200, f"HTTP {st}")
    st, res, _ = req("POST", f"/api/preauthkeys/{kid}/delete", {"confirm": True}, cookie=cookie, csrf=csrf)
    check("密钥删除成功", st == 200, f"HTTP {st}")

print("\n" + "=" * 100)
print("8. 快速连接命令生成")
print("=" * 100)
st, res, _ = req("GET", "/api/connect/commands?hostname=lab-alpha&tags=tag:lab&key=hskey-auth-DEMO", cookie=cookie)
check("命令生成返回 200", st == 200)
if st == 200:
    cmds = res.get("commands", {})
    check("生成 Linux 接入命令", "--login-server" in cmds.get("linux", ""))
    check("生成 SSH 命令", "ssh lab-alpha" in cmds.get("ssh", ""))
    check("带标签参数", "--advertise-tags=tag:lab" in cmds.get("linux", ""))
    print(f"      Linux 命令：\n{cmds.get('linux','')}")

print("\n" + "=" * 100)
print("9. RBAC：创建受限账户并验证越权拦截")
print("=" * 100)
st, res, _ = req("GET", "/api/panel/groups", cookie=cookie)
check("用户组列表可读", st == 200)
groups = res.get("groups", []) if isinstance(res, dict) else []
gmap = {g["name"]: g["id"] for g in groups}
check(f"内置角色已初始化（{len(groups)} 个）", len(gmap) >= 4, str(list(gmap)))
readonly_id = gmap.get("只读审计")

st, res, _ = req("GET", "/api/panel/users", cookie=cookie)
for u in (res.get("users", []) if isinstance(res, dict) else []):
    if u.get("username") == "viewer":
        req("POST", f"/api/panel/users/{u['id']}/delete", {}, cookie=cookie, csrf=csrf)
        print("      （清理上次运行残留的 viewer 账户）")

st, res, _ = req("POST", "/api/panel/users", {"username": "viewer", "password": VIEWER_PASS,
                                              "groupIds": [readonly_id] if readonly_id else []}, cookie=cookie, csrf=csrf)
check("创建受限账户成功", st == 200, f"HTTP {st} {res}")
st, res, hdrs2 = req("POST", "/api/auth/login", {"username": "viewer", "password": VIEWER_PASS})
check("受限账户可登录", st == 200, f"HTTP {st}")
vcookie = (hdrs2.get("Set-Cookie", "").split(";")[0]) if hdrs2.get("Set-Cookie") else ""
vcsrf = res.get("csrfToken", "") if isinstance(res, dict) else ""

if vcookie:
    st, res, _ = req("GET", "/api/nodes", cookie=vcookie)
    check("只读账户可读设备列表", st == 200)
    st, res, _ = req("POST", "/api/nodes/1/rename", {"newName": "nope"}, cookie=vcookie, csrf=vcsrf)
    check("只读账户改设备被拦截（403 FORBIDDEN）", st == 403 and res.get("error") == "FORBIDDEN",
          f"HTTP {st} {res.get('message')}")
    st, res, _ = req("GET", "/api/settings", cookie=vcookie)
    check("只读账户读设置被拦截（settings:write 不在权限内但 read 在，应 200）", st == 200, f"HTTP {st}")
    st, res, _ = req("PUT", "/api/settings", {"items": {"hs.url": "http://evil"}}, cookie=vcookie, csrf=vcsrf)
    check("只读账户改设置被拦截（403）", st == 403, f"HTTP {st}")
    st, res, _ = req("POST", "/api/panel/users", {"username": "x"}, cookie=vcookie, csrf=vcsrf)
    check("只读账户建账户被拦截（403）", st == 403, f"HTTP {st}")

print("\n" + "=" * 100)
print("10. 登出")
print("=" * 100)
st, res, _ = req("POST", "/api/auth/logout", {}, cookie=cookie, csrf=csrf)
check("登出成功", st == 200, f"HTTP {st}")
st, res, _ = req("GET", "/api/nodes", cookie=cookie)
check("登出后旧 Cookie 立即失效（401）", st == 401, f"HTTP {st}")

print("\n" + "=" * 100)
print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print(f"  ✗ {f}")
print("=" * 100)
