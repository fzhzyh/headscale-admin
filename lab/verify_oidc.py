#!/usr/bin/env python3
"""内置 OIDC Provider（P5）端到端验证。

这套件覆盖的是**安全边界**，不是"端点能不能访问"：

  1. 发现文档 / JWKS 必须**无会话可访问**（下游 headscale 不会带面板 Cookie）
  2. **管理端点必须需要会话**——早期实现用 `startsWith('/api/oidc/')` 放行，
     等于客户端管理完全裸奔（任何人可增删客户端、轮换签名密钥）
  3. **redirect_uri 必须精确匹配**——开放重定向是 OIDC 最经典的漏洞
  4. **授权码一次性**——重放同一个 code 必须被拒
  5. **PKCE 校验**——verifier 不对换不到 token
  6. **secret 只显示一次**——列表接口绝不能回显明文
  7. **完整授权码流转**：authorize → code → token → 验签 ID Token → userinfo

跑法：python3 lab/verify_oidc.py
"""
import base64
import hashlib
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_endpoints  # noqa: E402

bypass_proxy_for_local()
_EP = load_endpoints()

BASE = _EP["PANEL_URL"]
ADMIN_USER = _EP.get("PANEL_ADMIN_USER", "admin")
ADMIN_PASS = _EP.get("PANEL_ADMIN_SECRET", "")

PASS, FAIL = [], []
TEST_NAME = "t-verify-oidc"


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    print(f"  {'✓' if ok else '✗'} {label}{f'   → {detail}' if detail else ''}")


def eq(label, actual, expected):
    a = json.dumps(actual, ensure_ascii=False, sort_keys=True)
    e = json.dumps(expected, ensure_ascii=False, sort_keys=True)
    check(label, a == e, "" if a == e else f"实际 {a} / 期望 {e}")


def section(title):
    print("\n" + "=" * 92)
    print(title)
    print("=" * 92)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **kw):
        return None


def req(method, path, payload=None, cookie=None, csrf=None, headers=None, follow=False):
    url = f"{BASE}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Accept", "application/json")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    if csrf:
        r.add_header("X-CSRF-Token", csrf)
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    try:
        with opener.open(r, timeout=25) as resp:
            return resp.status, resp.read().decode(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(), dict(e.headers)


def jbody(raw):
    try:
        return json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return {"_raw": raw[:300]}


def login():
    code, raw, hdrs = req("POST", "/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    if code != 200:
        print(f"✗ 登录失败 HTTP {code}: {raw}")
        sys.exit(1)
    cookie = (hdrs.get("Set-Cookie") or hdrs.get("set-cookie") or "").split(";")[0]
    return cookie, jbody(raw).get("csrfToken", "")


cookie, csrf = login()

# 清理上一轮遗留的测试客户端
code, raw, _ = req("GET", "/api/oidc/clients", cookie=cookie)
for c in jbody(raw).get("clients", []):
    if c["name"].startswith(TEST_NAME):
        req("DELETE", f"/api/oidc/clients/{c['id']}", cookie=cookie, csrf=csrf)

# ============================================================
section("1. 公开端点：无会话必须可访问（下游不带 Cookie）")
code, raw, _ = req("GET", "/.well-known/openid-configuration")
check("发现文档无会话可读", code == 200, f"HTTP {code}")
disc = jbody(raw)
check("issuer 存在", bool(disc.get("issuer")), disc.get("issuer"))
for field in ("authorization_endpoint", "token_endpoint", "jwks_uri", "userinfo_endpoint"):
    check(f"{field} 存在", bool(disc.get(field)), disc.get(field))
eq("仅支持 code 流", disc.get("response_types_supported"), ["code"])
eq("签名算法 RS256", disc.get("id_token_signing_alg_values_supported"), ["RS256"])
check("支持 S256 PKCE", "S256" in (disc.get("code_challenge_methods_supported") or []))

code, raw, _ = req("GET", "/oidc/jwks")
check("JWKS 无会话可读", code == 200, f"HTTP {code}")
jwks = jbody(raw)
check("JWKS 有公钥", len(jwks.get("keys", [])) >= 1, f"{len(jwks.get('keys', []))} 把")
k0 = (jwks.get("keys") or [{}])[0]
eq("kty=RSA", k0.get("kty"), "RSA")
eq("alg=RS256", k0.get("alg"), "RS256")
eq("use=sig", k0.get("use"), "sig")
# 最关键的断言：JWKS 不能泄露私钥参数
for secret_field in ("d", "p", "q", "dp", "dq", "qi"):
    check(f"JWKS 不含私钥字段 {secret_field}", k0.get(secret_field) is None)

# ============================================================
section("2. 管理端点：必须需要会话（早期实现此处是漏洞）")
for path in ("/api/oidc/clients", "/api/oidc/keys"):
    code, _, _ = req("GET", path)
    check(f"{path} 未登录被拒", code == 401, f"HTTP {code}")

code, _, _ = req("POST", "/api/oidc/keys/rotate", {"retireOld": False})
check("轮换密钥未登录被拒", code in (401, 403), f"HTTP {code}")

code, _, _ = req("POST", "/api/oidc/clients", {"name": "x", "redirectUris": ["https://x/cb"]})
check("创建客户端未登录被拒", code in (401, 403), f"HTTP {code}")

# ============================================================
section("3. 创建 confidential 客户端")
code, raw, _ = req("POST", "/api/oidc/clients", {
    "name": f"{TEST_NAME}-conf",
    "redirectUris": ["http://127.0.0.1:9999/callback"],
    "isPublic": False,
    "requirePkce": True,
}, cookie, csrf)
check("创建成功", code == 201, f"HTTP {code} {jbody(raw).get('error')}")
created = jbody(raw)
conf = created.get("client") or {}
client_id = conf.get("clientId", "")
client_secret = created.get("clientSecret")
check("返回 client_id", bool(client_id), client_id)
check("★ 创建时返回一次明文 secret", bool(client_secret), (client_secret or "")[:12] + "…")
check("secret 有前缀标识", str(client_secret).startswith("oidcs_"), str(client_secret)[:10])
check("client 记录里只存前缀", str(conf.get("secretPrefix", "")).endswith("…"), conf.get("secretPrefix"))
check("secretPrefix 不等于明文", conf.get("secretPrefix") != client_secret)

code, raw, _ = req("GET", "/api/oidc/clients", cookie=cookie)
listed = [c for c in jbody(raw).get("clients", []) if c["clientId"] == client_id]
check("列表里能查到", len(listed) == 1)
if listed:
    check("★ 列表不返回 secret 明文",
          "clientSecret" not in listed[0] and "client_secret" not in listed[0],
          str([k for k in listed[0].keys() if "secret" in k.lower()]))

# ============================================================
section("4. redirect_uri 必须精确匹配（防开放重定向）")
qs = urlencode({
    "response_type": "code", "client_id": client_id,
    "redirect_uri": "https://evil.example/steal", "scope": "openid",
})
code, raw, _ = req("GET", f"/oidc/authorize?{qs}", cookie=cookie)
check("未登记的 redirect_uri 被拒", code == 400, f"HTTP {code}")
check("错误码为 invalid_request", jbody(raw).get("error") == "invalid_request", str(jbody(raw).get("error")))

# 已登录但未带 PKCE：该客户端 requirePkce=true，应被拒
qs2 = urlencode({
    "response_type": "code", "client_id": client_id,
    "redirect_uri": "http://127.0.0.1:9999/callback", "scope": "openid",
})
code, raw, _ = req("GET", f"/oidc/authorize?{qs2}", cookie=cookie)
check("强制 PKCE 的客户端缺 code_challenge 被拒", code == 400, f"HTTP {code}")
check("提示与 PKCE 相关", "PKCE" in raw, raw[:80])

# ============================================================
section("5. 未登录访问 authorize → 跳登录页（不是裸 401）")
code, raw, hdrs = req("GET", f"/oidc/authorize?{qs2}")
check("返回 302", code == 302, f"HTTP {code}")
loc = hdrs.get("Location") or hdrs.get("location") or ""
check("跳转到 /login 并带 next 回跳", "/login" in loc and "next=" in loc, loc[:90])

# ============================================================
section("6. 完整授权码流转（PKCE S256）")
verifier = secrets.token_urlsafe(48)
challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
state = secrets.token_urlsafe(12)
nonce = secrets.token_urlsafe(12)

qs3 = urlencode({
    "response_type": "code", "client_id": client_id,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "scope": "openid profile email groups", "state": state, "nonce": nonce,
    "code_challenge": challenge, "code_challenge_method": "S256",
})
code, raw, hdrs = req("GET", f"/oidc/authorize?{qs3}", cookie=cookie)
check("授权返回 302", code == 302, f"HTTP {code} {raw[:120]}")
loc = hdrs.get("Location") or hdrs.get("location") or ""
q = parse_qs(urlparse(loc).query)
auth_code = (q.get("code") or [""])[0]
check("回调带 code", bool(auth_code), (auth_code or "")[:16] + "…")
eq("state 原样回传（防 CSRF）", (q.get("state") or [""])[0], state)
check("回调地址正确", loc.startswith("http://127.0.0.1:9999/callback"), loc[:60])

# —— 换 token ——
code, raw, _ = req("POST", "/oidc/token", {
    "grant_type": "authorization_code",
    "code": auth_code,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "client_id": client_id,
    "client_secret": client_secret,
    "code_verifier": verifier,
})
check("换 token 成功", code == 200, f"HTTP {code} {jbody(raw).get('error')}")
tok = jbody(raw)
id_token = tok.get("id_token", "")
check("返回 id_token", bool(id_token), f"{len(id_token)} 字符")
check("返回 refresh_token", bool(tok.get("refresh_token")))
eq("token_type 为 Bearer", tok.get("token_type"), "Bearer")

# —— 解 ID Token 校验 claims ——
if id_token:
    parts = id_token.split(".")
    eq("ID Token 三段式", len(parts), 3)
    payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    header = json.loads(base64.urlsafe_b64decode(parts[0] + "=" * (-len(parts[0]) % 4)))
    eq("header alg=RS256", header.get("alg"), "RS256")
    check("header 带 kid", bool(header.get("kid")), str(header.get("kid")))
    eq("iss 为面板地址", payload.get("iss"), disc.get("issuer"))
    eq("aud 为 client_id", payload.get("aud"), client_id)
    check("sub 存在", bool(payload.get("sub")), str(payload.get("sub")))
    eq("preferred_username（headscale 用它建网络用户）", payload.get("preferred_username"), ADMIN_USER)
    eq("nonce 原样回传（防重放）", payload.get("nonce"), nonce)
    check("auth_time 存在", isinstance(payload.get("auth_time"), int), str(payload.get("auth_time")))
    check("exp 在将来", payload.get("exp", 0) > 0)
    check("groups 已透传", isinstance(payload.get("groups"), list), str(payload.get("groups")))

    # —— 用 JWKS 公钥真实验签 ——
    try:
        from jose import jwt  # type: ignore
        have_jose = True
    except ImportError:
        have_jose = False
    if have_jose:
        # 只取 kid 匹配的公钥
        kid = header.get("kid")
        jwk = next((k for k in jwks["keys"] if k.get("kid") == kid), None)
        if jwk:
            claims = jwt.decode(id_token, jwk, algorithms=["RS256"], audience=client_id,
                                issuer=disc.get("issuer"))
            check("★ 用 JWKS 公钥真实验签通过", claims.get("sub") == payload.get("sub"))
        else:
            check("★ 用 JWKS 公钥真实验签通过", False, "JWKS 里找不到对应 kid")
    else:
        print("      （跳过独立验签：本机未装 python-jose）")

# ============================================================
section("7. 授权码一次性（重放必须被拒）")
code, raw, _ = req("POST", "/oidc/token", {
    "grant_type": "authorization_code", "code": auth_code,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "client_id": client_id, "client_secret": client_secret, "code_verifier": verifier,
})
check("★ 重放同一 code 被拒", code == 400, f"HTTP {code}")
check("错误码 invalid_grant", jbody(raw).get("error") == "invalid_grant", str(jbody(raw).get("error")))
check("提示已被使用", "已" in str(jbody(raw).get("error_description")), str(jbody(raw).get("error_description")))

# ============================================================
section("8. PKCE verifier 不对 → 换不到 token")
qs4 = urlencode({
    "response_type": "code", "client_id": client_id,
    "redirect_uri": "http://127.0.0.1:9999/callback", "scope": "openid",
    "code_challenge": challenge, "code_challenge_method": "S256",
})
code, raw, hdrs = req("GET", f"/oidc/authorize?{qs4}", cookie=cookie)
code2 = (parse_qs(urlparse(hdrs.get("Location") or hdrs.get("location") or "").query).get("code") or [""])[0]
code, raw, _ = req("POST", "/oidc/token", {
    "grant_type": "authorization_code", "code": code2,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "client_id": client_id, "client_secret": client_secret,
    "code_verifier": "wrong-verifier-value",
})
check("★ 错误的 code_verifier 被拒", code == 400, f"HTTP {code}")
check("提示 verifier 不匹配", "verifier" in raw.lower(), raw[:80])

# ============================================================
section("9. client_secret 错误 / 缺失 → 换不到 token")
code, raw, hdrs = req("GET", f"/oidc/authorize?{qs4}", cookie=cookie)
code3 = (parse_qs(urlparse(hdrs.get("Location") or hdrs.get("location") or "").query).get("code") or [""])[0]
code, raw, _ = req("POST", "/oidc/token", {
    "grant_type": "authorization_code", "code": code3,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "client_id": client_id, "client_secret": "wrong-secret", "code_verifier": verifier,
})
check("★ 错误 secret 被拒", code == 401, f"HTTP {code}")
code, raw, _ = req("POST", "/oidc/token", {
    "grant_type": "authorization_code", "code": code3,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "client_id": client_id, "code_verifier": verifier,
})
check("★ 缺 secret 被拒", code == 401, f"HTTP {code}")

# ============================================================
section("10. refresh_token 换新 ID Token")
code, raw, hdrs = req("GET", f"/oidc/authorize?{qs4}", cookie=cookie)
code4 = (parse_qs(urlparse(hdrs.get("Location") or hdrs.get("location") or "").query).get("code") or [""])[0]
code, raw, _ = req("POST", "/oidc/token", {
    "grant_type": "authorization_code", "code": code4,
    "redirect_uri": "http://127.0.0.1:9999/callback",
    "client_id": client_id, "client_secret": client_secret, "code_verifier": verifier,
})
rt = jbody(raw).get("refresh_token")
check("拿到 refresh_token", bool(rt))

if rt:
    code, raw, _ = req("POST", "/oidc/token", {
        "grant_type": "refresh_token", "refresh_token": rt,
        "client_id": client_id, "client_secret": client_secret,
    })
    check("refresh 换 token 成功", code == 200, f"HTTP {code} {jbody(raw).get('error')}")
    refreshed = jbody(raw).get("id_token", "")
    check("返回新的 id_token", bool(refreshed) and refreshed != id_token)

    # userinfo
    code, raw, _ = req("GET", "/oidc/userinfo", headers={"Authorization": f"Bearer {rt}"})
    check("userinfo 可读", code == 200, f"HTTP {code}")
    ui = jbody(raw)
    eq("userinfo 的 preferred_username", ui.get("preferred_username"), ADMIN_USER)
    check("userinfo 带 sub", bool(ui.get("sub")))

# ============================================================
section("11. 签名密钥轮换")
code, raw, _ = req("GET", "/api/oidc/keys", cookie=cookie)
check("密钥列表可读", code == 200)
before = jbody(raw)
before_kids = [k["kid"] for k in before.get("keys", []) if k["retiredAt"] is None]

code, raw, _ = req("POST", "/api/oidc/keys/rotate", {"retireOld": False}, cookie, csrf)
check("轮换成功", code == 200, f"HTTP {code}")
rot = jbody(raw)
new_kid = rot.get("kid")
check("返回新 kid", bool(new_kid), str(new_kid))
check("未退役旧密钥", rot.get("retired") == [], str(rot.get("retired")))

code, raw, _ = req("GET", "/oidc/jwks")
after_kids = [k.get("kid") for k in jbody(raw).get("keys", [])]
for kid in before_kids:
    check(f"★ 旧密钥 {str(kid)[-10:]} 仍在 JWKS（旧 token 可继续验签）", kid in after_kids)
check("新密钥已进 JWKS", new_kid in after_kids)

# ============================================================
section("12. 清理")
code, raw, _ = req("GET", "/api/oidc/clients", cookie=cookie)
for c in jbody(raw).get("clients", []):
    if c["name"].startswith(TEST_NAME):
        req("DELETE", f"/api/oidc/clients/{c['id']}", cookie=cookie, csrf=csrf)
code, raw, _ = req("GET", "/api/oidc/clients", cookie=cookie)
leftover = [c["name"] for c in jbody(raw).get("clients", []) if c["name"].startswith(TEST_NAME)]
check("测试客户端已清空", leftover == [], str(leftover))
code, raw, _ = req("GET", "/.well-known/openid-configuration")
check("发现文档仍正常", code == 200)

print("\n" + "=" * 92)
print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print(f"  ✗ {f}")
print("=" * 92)
sys.exit(1 if FAIL else 0)
