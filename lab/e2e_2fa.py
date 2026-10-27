#!/usr/bin/env python3
"""2FA（TOTP）端到端验证 —— 补齐 P1 未覆盖的安全关键路径。

自实现 RFC 6238 TOTP，不依赖第三方库，确保校验是独立的。
"""
import base64
import hashlib
import hmac
import json
import os
import sys
import re
import time
import struct
import time
import urllib.request
import urllib.error

# 本地联调：强制直连，避免 macOS 系统代理把 127.0.0.1 的请求送去代理
# （曾导致「同一 Key 时而 200 时而 401」的间歇性假故障，详见 _local_net.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_hs_key, load_endpoints  # noqa: E402

bypass_proxy_for_local()
_EP = load_endpoints()

BASE = _EP["PANEL_URL"]
ADMIN_USER = _EP.get("PANEL_ADMIN_USER", "admin")
ADMIN_PASS = _EP.get("PANEL_ADMIN_SECRET", "")

PASS = []
FAIL = []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(f"  {'✓' if cond else '✗'} {label}" + (f"   → {detail}" if detail else ""))


def req(method, path, payload=None, cookie=None, csrf=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    r.add_header("Accept", "application/json")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    if csrf:
        r.add_header("X-CSRF-Token", csrf)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b.strip().startswith(("{", "[")) else b), resp.headers
    except urllib.error.HTTPError as e:
        return e.code, _parse(e.read().decode()), e.headers


def _parse(b):
    try:
        return json.loads(b)
    except Exception:
        return b


# 登录接口有 20 次/5 分钟的限流（安全设计，必须保留）。整套回归连着跑会触发 429，
# 那会让后续步骤连锁失败（例如 2FA setup 被打断 → 启用时报 NO_SETUP）。
# 所以这里对 429 做「按上游提示等待后重试」，而不是把限流调松。
def req_rl(method, path, payload=None, cookie=None, csrf=None, max_attempts=4):
    for attempt in range(max_attempts):
        st, res, hdrs = req(method, path, payload, cookie, csrf)
        if st != 429:
            return st, res, hdrs
        msg = res.get("message", "") if isinstance(res, dict) else str(res)
        m = re.search(r"retry in (\d+)", msg)
        wait = int(m.group(1)) * 60 + 5 if m else 30
        if attempt == max_attempts - 1:
            return st, res, hdrs
        print(f"      （触发登录限流，等待 {wait}s 后重试 {attempt + 1}/{max_attempts - 1}）")
        time.sleep(wait)
    return st, res, hdrs


# ---------------- TOTP (RFC 6238) ----------------
def totp(secret_b32: str, t: int | None = None, digits: int = 6, period: int = 30) -> str:
    key = base64.b32decode(secret_b32.upper() + "=" * ((8 - len(secret_b32) % 8) % 8))
    counter = int((t if t is not None else time.time()) // period)
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, hashlib.sha1).digest()
    off = h[-1] & 0x0F
    code = (struct.unpack(">I", h[off:off + 4])[0] & 0x7FFFFFFF) % (10 ** digits)
    return str(code).zfill(digits)


def login(user, pwd):
    return req_rl("POST", "/api/auth/login", {"username": user, "password": pwd})


print("=" * 92)
print("1. 建立管理员会话")
print("=" * 92)
if not ADMIN_PASS:
    print("  ✗ 未设置 PANEL_ADMIN_SECRET 环境变量，无法继续")
    raise SystemExit(1)
st, res, hdrs = login(ADMIN_USER, ADMIN_PASS)
if st != 200:
    print(f"  ✗ 登录失败 HTTP {st} {res}（若管理员已开启 2FA，本脚本无法继续）")
    raise SystemExit(1)
cookie = hdrs.get("Set-Cookie", "").split(";")[0]
csrf = res.get("csrfToken", "")
check("管理员登录成功（当前未启用 2FA）", st == 200, f"need2fa={res.get('need2fa')}")

print("\n" + "=" * 92)
print("2. 获取 TOTP 密钥（otplib 运行时验证）")
print("=" * 92)
st, res, _ = req_rl("POST", "/api/auth/2fa/setup", {}, cookie=cookie, csrf=csrf)
check("setup 返回 200", st == 200, f"HTTP {st} {res if st != 200 else ''}")
secret = res.get("secret", "") if isinstance(res, dict) else ""
uri = res.get("otpauthUrl", "") if isinstance(res, dict) else ""
check("返回 base32 密钥（otplib generateSecret 正常）", len(secret) >= 16 and secret.isalnum(),
      f"secret 长度={len(secret)}")
check("返回 otpauth:// 协议串（供二维码）", uri.startswith("otpauth://totp/"), uri[:80])
check("otpauth 串含 issuer 与账号",
      "headscale-admin" in uri and ADMIN_USER in uri)

print("\n" + "=" * 92)
print("3. 错误动态码必须被拒")
print("=" * 92)
st, res, _ = req_rl("POST", "/api/auth/2fa/enable", {"code": "000000"}, cookie=cookie, csrf=csrf)
check("错误动态码被拒（不泄露密钥）", st == 400 and res.get("error") == "BAD_2FA", f"HTTP {st} {res}")
st, res, _ = req_rl("POST", "/api/auth/2fa/enable", {"code": "12345"}, cookie=cookie, csrf=csrf)
check("格式非法的动态码被拒", st == 400, f"HTTP {st}")

print("\n" + "=" * 92)
print("4. 用真实算法生成动态码并启用 2FA")
print("=" * 92)
code = totp(secret)
st, res, _ = req_rl("POST", "/api/auth/2fa/enable", {"code": code}, cookie=cookie, csrf=csrf)
check(f"正确动态码 {code} 启用成功（otplib verify 正常）", st == 200 and res.get("ok") is True,
      f"HTTP {st} {res if st != 200 else ''}")
recovery = res.get("recoveryCodes", []) if isinstance(res, dict) else []
check(f"下发 {len(recovery)} 个恢复码", len(recovery) == 8, str(recovery[:2]))

st, res, _ = req("GET", "/api/auth/session", cookie=cookie)
check("会话反映 2FA 已启用", res.get("user", {}).get("totpEnabled") is True, str(res.get("user")))

print("\n" + "=" * 92)
print("5. 登录链路：口令通过后必须过 2FA")
print("=" * 92)
st, res, hdrs2 = login(ADMIN_USER, ADMIN_PASS)
check("仅凭口令不再直接下发会话（返回 need2fa）",
      st == 200 and res.get("need2fa") is True, f"HTTP {st} {res}")
check("此时未下发会话 Cookie", "hsa_sid=" not in (hdrs2.get("Set-Cookie") or ""),
      f"Set-Cookie={hdrs2.get('Set-Cookie')}")
challenge = res.get("challengeId", "") if isinstance(res, dict) else ""
check("返回 challengeId", len(challenge) > 10, challenge)

st, res, _ = req("POST", "/api/auth/2fa", {"challengeId": challenge, "code": "000000"})
check("错误动态码登录被拒", st == 401 and res.get("error") == "BAD_2FA", f"HTTP {st} {res}")

st, res, _ = req("POST", "/api/auth/2fa", {"challengeId": "c_bogus_challenge_id_xx", "code": totp(secret)})
check("伪造 challengeId 被拒", st == 400 and res.get("error") == "CHALLENGE_EXPIRED", f"HTTP {st} {res}")

code2 = totp(secret)
st, res, hdrs3 = req("POST", "/api/auth/2fa", {"challengeId": challenge, "code": code2})
check(f"正确动态码 {code2} 登录成功", st == 200 and res.get("ok") is True, f"HTTP {st} {res if st != 200 else ''}")
cookie2 = (hdrs3.get("Set-Cookie") or "").split(";")[0]
csrf2 = res.get("csrfToken", "") if isinstance(res, dict) else ""
check("下发新会话 Cookie", "hsa_sid=" in (hdrs3.get("Set-Cookie") or ""))

st, res, _ = req("GET", "/api/nodes", cookie=cookie2)
check("新会话可正常访问业务接口", st == 200, f"HTTP {st}")

print("\n" + "=" * 92)
print("6. 恢复码（一次性）")
print("=" * 92)
rc = recovery[0]
st, res, hdrs4 = login(ADMIN_USER, ADMIN_PASS)
chal2 = res.get("challengeId", "") if isinstance(res, dict) else ""
st, res, _ = req("POST", "/api/auth/2fa", {"challengeId": chal2, "code": rc})
check(f"恢复码 {rc} 可登录", st == 200 and res.get("ok") is True, f"HTTP {st} {res if st != 200 else ''}")
check("提示已使用恢复码并给出剩余数量", "warn" in res if isinstance(res, dict) else False,
      str(res.get("warn") if isinstance(res, dict) else None))

st, res, hdrs5 = login(ADMIN_USER, ADMIN_PASS)
chal3 = res.get("challengeId", "") if isinstance(res, dict) else ""
st, res, _ = req("POST", "/api/auth/2fa", {"challengeId": chal3, "code": rc})
check("同一恢复码不能重复使用（一次性）", st == 401, f"HTTP {st} {res}")

st, res, hdrs6 = login(ADMIN_USER, ADMIN_PASS)
chal4 = res.get("challengeId", "") if isinstance(res, dict) else ""
st, res, _ = req("POST", "/api/auth/2fa", {"challengeId": chal4, "code": recovery[1]})
check("另一个恢复码仍然可用", st == 200, f"HTTP {st}")

print("\n" + "=" * 92)
print("7. 关闭 2FA（需口令确认）")
print("=" * 92)
st, res, hdrs7 = login(ADMIN_USER, ADMIN_PASS)
chal5 = res.get("challengeId", "") if isinstance(res, dict) else ""
st, res, hdrs8 = req("POST", "/api/auth/2fa", {"challengeId": chal5, "code": totp(secret)})
ck = (hdrs8.get("Set-Cookie") or "").split(";")[0]
cs = res.get("csrfToken", "") if isinstance(res, dict) else ""

st, res, _ = req("POST", "/api/auth/2fa/disable", {"password": "wrong"}, cookie=ck, csrf=cs)
check("错误口令无法关闭 2FA", st == 401, f"HTTP {st} {res}")
st, res, _ = req("POST", "/api/auth/2fa/disable", {"password": ADMIN_PASS}, cookie=ck, csrf=cs)
check("正确口令可关闭 2FA", st == 200 and res.get("ok") is True, f"HTTP {st} {res}")

st, res, _ = login(ADMIN_USER, ADMIN_PASS)
check("关闭后仅凭口令即可登录（链路回滚正常）", st == 200 and res.get("need2fa") is not True,
      f"HTTP {st} {res}")

print("\n" + "=" * 92)
print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print(f"  ✗ {f}")
print("=" * 92)
