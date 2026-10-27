#!/usr/bin/env python3
"""P3 ACL 引擎端到端验证。

设计要点（血泪教训）：
  headscale 的「打标签」是**不可逆**操作——源码 hscontrol/grpcv1.go:326 注释明确：
  "User XOR Tags: nodes are either tagged or user-owned, never both.
   Once tagged, a node cannot be converted back to user-owned."
  且 SetTags([]) 被上游直接拒绝（cannot remove all tags）。

  ⇒ 测试**不能**靠「打标签→清标签」复位共享节点，否则第二次运行必然失败。
  ⇒ 本脚本改为**自建自清**：自己造一台一次性设备，用完删除，全程不污染既有数据。

覆盖：
  1. 策略读写、漂移检测
  2. 本地校验能否拦住各类非法策略（比上游报错更友好）
  3. 高危护栏：全通 ↔ 全禁 必须显式确认
  4. 标签语义（tags-as-identity）与不可逆护栏
  5. 访问检查（headscale 不提供的能力）
  6. 版本历史 / 差异 / 回滚
"""
import json
import os
import sys
import secrets
import string
import urllib.request
import urllib.error

# 本地联调：强制直连，避免 macOS 系统代理把 127.0.0.1 的请求送去代理
# （曾导致「同一 Key 时而 200 时而 401」的间歇性假故障，详见 _local_net.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_hs_key, load_endpoints  # noqa: E402

bypass_proxy_for_local()
_EP = load_endpoints()

BASE = _EP["PANEL_URL"]
HS = _EP["HS_URL"]
DBG = _EP["HS_DEBUG_URL"]
USER = _EP.get("PANEL_ADMIN_USER", "admin")
PASS = _EP.get("PANEL_ADMIN_SECRET", "")
HSKEY = load_hs_key()

PASSED, FAILED = [], []
ALPHABET = string.ascii_letters + string.digits + "-_"
TAGNAME = "tag:prod"


def check(label, ok, detail=""):
    (PASSED if ok else FAILED).append(label)
    print(f"  {'✓' if ok else '✗'} {label}" + (f"   → {detail}" if detail else ""))


def req(method, path, payload=None, cookie=None, csrf=None, base=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(f"{base or BASE}{path}", data=data, method=method)
    r.add_header("Accept", "application/json")
    if data is not None:
        r.add_header("Content-Type", "application/json")
    if cookie:
        r.add_header("Cookie", cookie)
    if csrf:
        r.add_header("X-CSRF-Token", csrf)
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b.strip().startswith(("{", "[")) else b), resp.headers
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b), e.headers
        except Exception:
            return e.code, b, e.headers


# ---------------- headscale 直连（造/删一次性节点、写策略、读编译结果） ----------------

def hs_call(method, path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        f"{HS}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {HSKEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            b = resp.read().decode()
            return resp.status, (json.loads(b) if b.strip().startswith(("{", "[")) else b)
    except urllib.error.HTTPError as e:
        b = e.read().decode()
        try:
            return e.code, json.loads(b)
        except Exception:
            return e.code, b


def hs_make_node(user, name):
    """造一台一次性设备：debug/node 写注册缓存 → auth/register 落成真实节点。"""
    auth_id = "hskey-authreq-" + "".join(secrets.choice(ALPHABET) for _ in range(24))
    st, _ = hs_call("POST", "/api/v1/debug/node", {"user": user, "key": auth_id, "name": name, "routes": []})
    if st != 200:
        return None
    st, res = hs_call("POST", "/api/v1/auth/register", {"user": user, "authId": auth_id})
    if st != 200 or not isinstance(res, dict):
        return None
    return res.get("node")


def hs_set_policy(policy_obj):
    """直接往 headscale 写策略（模拟带外变更）"""
    body = json.dumps({"policy": json.dumps(policy_obj)}).encode()
    r = urllib.request.Request(
        f"{HS}/api/v1/policy", data=body, method="PUT",
        headers={"Authorization": f"Bearer {HSKEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(r, timeout=15) as resp:
        return resp.status


def hs_filter():
    """读取 headscale 编译后的 filter。

    返回：
      - list / None  正常结果（None 表示全禁）
      - "__DENIED__" debug 端点拒绝访问
      - "__ERR__"    其它错误
    """
    try:
        with urllib.request.urlopen(f"{DBG}/debug/filter", timeout=10) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return "__DENIED__" if e.code == 403 else "__ERR__"
    except Exception:
        return "__ERR__"


# 容器化后 headscale 只监听在容器内，/debug/* 仅限本机回环访问，
# 从宿主/容器网络访问一律 403「debug access denied」；而官方镜像是 distroless
# （连 sh 都没有），无法 `container exec` 进去查。
# 这两项是「与上游编译结果交叉验证」，不是产品功能，因此容器模式下显式跳过。
DEBUG_UNAVAILABLE = False


print("=" * 92)
print("0. 登录")
print("=" * 92)
if not PASS:
    raise SystemExit("需要 PANEL_ADMIN_SECRET")
st, res, hdrs = req("POST", "/api/auth/login", {"username": USER, "password": PASS})
if st != 200 or res.get("need2fa"):
    raise SystemExit(f"登录失败：HTTP {st} {res}")
cookie = hdrs.get("Set-Cookie", "").split(";")[0]
csrf = res.get("csrfToken", "")
check("登录成功", st == 200)

# ---------------- 一次性设备（全程不污染既有数据） ----------------
print(f"\n{'=' * 92}")
print("0.5 自建一次性设备（因打标签不可逆，测试必须自建自清）")
print(f"{'=' * 92}")
TMP_NAME = "lab-acl-tmp-" + "".join(secrets.choice(string.digits) for _ in range(4))
tmp_node = hs_make_node("labadmin", TMP_NAME)
TMP_ID = int(tmp_node["id"]) if tmp_node else 0
check(f"创建一次性设备 {TMP_NAME}（labadmin 所有、无标签）", bool(tmp_node),
      f"id={TMP_ID} ip={(tmp_node or {}).get('ipAddresses')}")

st, res, _ = req("GET", "/api/nodes", cookie=cookie)
all_nodes = res.get("nodes", []) if isinstance(res, dict) else []
tmp_shaped = next((n for n in all_nodes if n["id"] == TMP_ID), None)
check("面板可见该设备且归属 labadmin",
      bool(tmp_shaped) and (tmp_shaped or {}).get("user", {}).get("name") == "labadmin",
      f"user={(tmp_shaped or {}).get('user', {}).get('name')} tags={(tmp_shaped or {}).get('tags')}")

peer_node = next((n for n in all_nodes if (n.get("user") or {}).get("name") == "devops" and not n.get("tags")), None)
check("找到反例设备（devops 的未打标签设备）", peer_node is not None,
      (peer_node or {}).get("displayName", "无"))

print(f"\n{'=' * 92}")
print("1. 读取当前策略 + 漂移检测")
print(f"{'=' * 92}")
st, res, _ = req("GET", "/api/acl/policy", cookie=cookie)
check("GET /api/acl/policy 返回 200", st == 200, f"HTTP {st}")
if st == 200:
    check("返回策略内容", "content" in res)
    check("返回策略模式判定", res.get("interpretation", {}).get("mode") in ("allow-all", "deny-all", "rules"),
          str(res.get("interpretation", {}).get("mode")))
    check("返回校验结果", "validation" in res)
    check("返回漂移检测", "drift" in res)
    check("返回 acl:apply 权限位", "canApply" in res)
    print(f"      模式：{res['interpretation']['mode']} —— {res['interpretation']['explanation'][:60]}…")

print(f"\n{'=' * 92}")
print("2. 本地校验：能否拦住各类非法策略")
print(f"{'=' * 92}")

BAD_CASES = [
    ("action=deny（headscale 不支持）",
     '{"acls":[{"action":"deny","proto":"tcp","src":["*"],"dst":["*:*"]}]}', "action"),
    ("proto=*（headscale 明确拒绝）",
     '{"acls":[{"action":"accept","proto":"*","src":["*"],"dst":["*:*"]}]}', "proto"),
    ("dst 缺端口",
     '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["100.64.0.1"]}]}', "dst"),
    ("引用未定义的 host",
     '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["nohost:22"]}]}', "hosts"),
    ("引用未定义的 group",
     '{"acls":[{"action":"accept","proto":"tcp","src":["group:nope"],"dst":["*:*"]}]}', "groups"),
    ("autogroup:internet 用作 src",
     '{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:internet"],"dst":["*:*"]}]}', "internet"),
    ("autogroup:self 用作 src",
     '{"acls":[{"action":"accept","proto":"tcp","src":["autogroup:self"],"dst":["*:*"]}]}', "self"),
    ("autogroup:self 作为 dst 但源是 tag",
     '{"tagOwners":{"tag:x":["labadmin@"]},"acls":[{"action":"accept","proto":"tcp","src":["tag:x"],"dst":["autogroup:self:22"]}]}', "self"),
    ("tagOwners 归属者是 IP",
     '{"tagOwners":{"tag:x":["100.64.0.1"]}}', "归属者"),
    ("SSH 规则缺 users",
     '{"ssh":[{"action":"accept","src":["*"],"dst":["*"],"users":[]}]}', "users"),
]

for label, content, expect_in in BAD_CASES:
    st, res, _ = req("POST", "/api/acl/validate", {"content": content}, cookie=cookie)
    issues = res.get("issues", []) if isinstance(res, dict) else []
    errs = [i for i in issues if i.get("severity") == "error"]
    hit = any(expect_in in (i.get("path", "") + i.get("message", "")) for i in errs)
    check(f"拦截：{label}", st == 200 and not res.get("ok") and hit,
          f"ok={res.get('ok')} 错误数={len(errs)}" + (f" 首条={errs[0]['message'][:60]}" if errs else ""))

print(f"\n{'=' * 92}")
print("3. 本地校验：合法策略应通过")
print(f"{'=' * 92}")
GOOD_CASES = [
    ("基本放行", '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:*"]}]}'),
    ("按用户与标签端口", '{"tagOwners":{"tag:prod":["labadmin@"]},"acls":[{"action":"accept","proto":"tcp","src":["labadmin@"],"dst":["tag:prod:443"]}]}'),
    ("hosts + groups", '{"groups":{"group:ops":["labadmin@"]},"hosts":{"srv":"100.64.0.3/32"},"acls":[{"action":"accept","proto":"tcp","src":["group:ops"],"dst":["srv:5432"]}]}'),
    ("autogroup:self 正确用法", '{"acls":[{"action":"accept","proto":"tcp","src":["labadmin@"],"dst":["autogroup:self:22"]}]}'),
    ("出口节点", '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["autogroup:internet:443"]}]}'),
    ("SSH 规则", '{"tagOwners":{"tag:srv":["labadmin@"]},"ssh":[{"action":"accept","src":["labadmin@"],"dst":["tag:srv"],"users":["root"]}]}'),
]
for label, content in GOOD_CASES:
    st, res, _ = req("POST", "/api/acl/validate", {"content": content}, cookie=cookie)
    errs = [i for i in res.get("issues", []) if i.get("severity") == "error"] if isinstance(res, dict) else ["?"]
    check(f"通过：{label}", st == 200 and res.get("ok"), f"错误：{[e['message'] for e in errs][:2]}")

print(f"\n{'=' * 92}")
print("4. 上游 check 一致性（本地通过 vs 上游接受）")
print(f"{'=' * 92}")
for label, content in GOOD_CASES:
    st, res, _ = req("POST", "/api/acl/check-upstream", {"content": content}, cookie=cookie)
    check(f"上游接受：{label}", st == 200 and res.get("ok"), str(res.get("message", ""))[:90])

print(f"\n{'=' * 92}")
print("5. 标签语义（tags-as-identity）—— 必须先用 tagOwners 定义标签")
print(f"{'=' * 92}")

st, res, _ = req("PUT", "/api/acl/policy",
                 {"content": json.dumps({"tagOwners": {TAGNAME: ["labadmin@"]},
                                         "acls": [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}]}),
                  "comment": "P3 测试：定义 tagOwners", "acknowledgedImpact": True},
                 cookie=cookie, csrf=csrf)
check("写入含 tagOwners 的策略", st == 200, f"HTTP {st} {str(res)[:90]}")

DRAFT_USER = json.dumps({"acls": [{"action": "accept", "proto": "tcp", "src": ["labadmin@"], "dst": ["*:22"]}]})

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "port": 22, "proto": "tcp",
                  "draftContent": DRAFT_USER}, cookie=cookie)
check("打标签前：user@ 命中未打标签的设备", st == 200 and res.get("allowed") is True, f"reason={res.get('reason')}")

st, res, _ = req("POST", f"/api/nodes/{TMP_ID}/tags", {"tags": [TAGNAME]}, cookie=cookie, csrf=csrf)
check(f"给一次性设备打上 {TAGNAME}", st == 200 and TAGNAME in ((res.get("node") or {}).get("tags") or []),
      f"HTTP {st} tags={(res.get('node') or {}).get('tags')}")
check("返回不可逆标记（irreversible）", res.get("irreversible") is True, str(res.get("irreversible")))
check("返回不可逆警告文案", "不可逆" in str(res.get("warning", "")), str(res.get("warning", ""))[:80])

# 列表接口：已打标签设备的 user 被重写为虚拟用户 tagged-devices
st, res_l, _ = req("GET", "/api/nodes", cookie=cookie)
n_l = next((x for x in (res_l.get("nodes", []) if isinstance(res_l, dict) else []) if x["id"] == TMP_ID), {})
check("面板列表显示归属为 tagged-devices",
      (n_l.get("user") or {}).get("name") == "tagged-devices",
      f"user={(n_l.get('user') or {}).get('name')}")
check("面板标记该设备为标签身份（taggedIdentity）", n_l.get("taggedIdentity") is True,
      str(n_l.get("taggedIdentity")))

# headscale 上游：列表接口给 tagged-devices，单节点接口给 null（上游自身不一致）
st_h, res_h = hs_call("GET", f"/api/v1/node/{TMP_ID}")
_node = ((res_h or {}).get("node") or {}) if isinstance(res_h, dict) else {}
hs_user = (_node.get("user") or {}).get("name")
check("headscale 单节点接口对标签设备返回 user=null（上游 quark，面板已归一化）",
      hs_user is None, f"user={hs_user!r}")

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "port": 22, "proto": "tcp",
                  "draftContent": DRAFT_USER}, cookie=cookie)
check("打标签后：user@ 不再命中该设备（tags-as-identity）",
      st == 200 and res.get("allowed") is False, f"reason={res.get('reason')}")
check("轨迹说明「脱离用户归属」",
      any("脱离用户归属" in t for t in res.get("trace", [])),
      next((t for t in res.get("trace", []) if "脱离用户归属" in t), "未提示")[:78])

DRAFT_TAG = json.dumps({"tagOwners": {TAGNAME: ["labadmin@"]},
                        "acls": [{"action": "accept", "proto": "tcp", "src": [TAGNAME], "dst": [f"{TAGNAME}:443"]}]})
st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "port": 443, "proto": "tcp",
                  "draftContent": DRAFT_TAG}, cookie=cookie)
check("tag: 规则命中（tag:prod → tag:prod:443）", st == 200 and res.get("allowed") is True, f"reason={res.get('reason')}")
check("返回命中规则明细", len(res.get("matched", [])) > 0,
      str(res.get("matched", [{}])[0].get("rule"))[:70] if res.get("matched") else "无")
check("返回求值轨迹", len(res.get("trace", [])) >= 5, f"{len(res.get('trace', []))} 步")

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "port": 80, "proto": "tcp",
                  "draftContent": DRAFT_TAG}, cookie=cookie)
check("端口不匹配：拒绝", st == 200 and res.get("allowed") is False, f"reason={res.get('reason')}")

if peer_node:
    st, res, _ = req("POST", "/api/acl/check",
                     {"from": {"nodeId": peer_node["id"]}, "to": {"nodeId": TMP_ID}, "port": 443, "proto": "tcp",
                      "draftContent": DRAFT_TAG}, cookie=cookie)
    check(f"其它用户设备（{peer_node['displayName']}）→ 拒绝", st == 200 and res.get("allowed") is False,
          f"reason={res.get('reason')}")
    check("说明「未命中即拒绝」", "未命中" in res.get("explanation", ""), res.get("explanation", "")[:70])

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "port": 443, "proto": "tcp",
                  "draftContent": json.dumps({"tagOwners": {TAGNAME: ["labadmin@"]},
                                              "acls": [{"action": "accept", "proto": "tcp", "src": ["autogroup:tagged"], "dst": [f"{TAGNAME}:443"]}]})},
                 cookie=cookie)
check("autogroup:tagged 可命中已打标签设备", st == 200 and res.get("allowed") is True, f"reason={res.get('reason')}")

st, res, _ = req("POST", f"/api/nodes/{TMP_ID}/tags", {"tags": []}, cookie=cookie, csrf=csrf)
check("清空全部标签被拦截（400）", st == 400, f"HTTP {st}")
check("给出可读的不可逆说明",
      res.get("error") == "CANNOT_CLEAR_TAGS" and "无法退回用户归属" in str(res.get("message", "")),
      f"{res.get('error')}：{str(res.get('message'))[:70]}")
check("给出恢复路径提示（只能删除重注册）", "删除该设备后重新注册" in str(res.get("hint", "")), str(res.get("hint"))[:60])

st, res, _ = req("PUT", "/api/acl/policy",
                 {"content": '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:*"]}]}',
                  "comment": "移除 tagOwners", "acknowledgedImpact": True}, cookie=cookie, csrf=csrf)
check("移除 tagOwners 的策略可写入", st == 200, f"HTTP {st}")
tgt = peer_node["id"] if peer_node else TMP_ID
st, res, _ = req("POST", f"/api/nodes/{tgt}/tags", {"tags": ["tag:undefined-x"]}, cookie=cookie, csrf=csrf)
check("未在 tagOwners 定义的标签被拒",
      st == 400 and res.get("error") in ("TAG_NOT_OWNED", "BAD_INPUT"),
      f"{res.get('error')}：{str(res.get('message'))[:80]}")

print(f"\n{'=' * 92}")
print("6. 高危护栏：全通 ↔ 全禁 必须显式确认")
print(f"{'=' * 92}")

st, res, _ = req("PUT", "/api/acl/policy",
                 {"content": '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:*"]}]}',
                  "comment": "P3 测试基线", "acknowledgedImpact": True}, cookie=cookie, csrf=csrf)
check("建立测试基线（rules 模式）", st == 200, f"HTTP {st} {str(res)[:100]}")

st, res, _ = req("PUT", "/api/acl/policy", {"content": '{"acls":[]}'}, cookie=cookie, csrf=csrf)
check("全禁未确认 → 被拦截（409）", st == 409 and res.get("error") == "NEED_ACK",
      f"HTTP {st} {str(res.get('message', ''))[:70]}")
if st == 409:
    check("提示说明会中断互访", "全禁" in res.get("message", "") and "中断" in res.get("message", ""),
          res.get("message", "")[:80])

st, res, _ = req("PUT", "/api/acl/policy", {"content": '{"acls":[]}', "acknowledgedImpact": True},
                 cookie=cookie, csrf=csrf)
check("全禁带确认 → 放行", st == 200, f"HTTP {st} {str(res)[:110]}")
if st == 200:
    check("返回新模式为 deny-all", res.get("mode") == "deny-all", str(res.get("mode")))

filt = hs_filter()
if filt == "__DENIED__":
    DEBUG_UNAVAILABLE = True
    print("  ⊘ SKIP headscale 编译结果确为全禁 —— /debug/filter 仅限本机回环，容器化后不可达")
else:
    check("headscale 编译结果确为全禁（filter=null）", filt is None, f"filter={str(filt)[:60]}")

st, res, _ = req("PUT", "/api/acl/policy", {"content": '{}', "acknowledgedImpact": True}, cookie=cookie, csrf=csrf)
check("切到全通（带确认）", st == 200, f"HTTP {st}")
filt = hs_filter()
if filt == "__DENIED__":
    print("  ⊘ SKIP headscale 编译结果确为全通 —— /debug/filter 仅限本机回环，容器化后不可达")
else:
    is_allow_all = isinstance(filt, list) and len(filt) == 1 and filt[0].get("SrcIPs") == ["*"]
    check("headscale 编译结果确为全通", is_allow_all, f"filter={str(filt)[:60]}")

st, res, _ = req("PUT", "/api/acl/policy",
                 {"content": '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:*"]}]}',
                  "comment": "恢复", "acknowledgedImpact": True}, cookie=cookie, csrf=csrf)
check("恢复 rules 模式", st == 200, f"HTTP {st}")

print(f"\n{'=' * 92}")
print("7. 版本历史")
print(f"{'=' * 92}")
st, res, _ = req("GET", "/api/acl/versions?limit=200", cookie=cookie)
check("GET /api/acl/versions 返回 200", st == 200)
versions = res.get("versions", []) if isinstance(res, dict) else []
check(f"版本记录已累积（{len(versions)} 条）", len(versions) >= 6,
      f"total={res.get('total') if isinstance(res, dict) else '?'}")
if versions:
    v0 = versions[0]
    check("最新版本含摘要统计", "summary" in v0, json.dumps(v0.get("summary", {}), ensure_ascii=False))
    check("最新版本标记为已应用", v0.get("applied") is True)
    check("存在多条已应用版本", len([v for v in versions if v.get("applied")]) >= 3,
          f"{len([v for v in versions if v.get('applied')])} 条")
    check("版本记录了 headscale 的 updatedAt", any(v.get("hsUpdatedAt") for v in versions))

print(f"\n{'=' * 92}")
print("8. 版本差异对比")
print(f"{'=' * 92}")
deny_v = next((v for v in versions if '"acls":[]' in v["content"].replace(" ", "")), None)
allow_v = next((v for v in versions if v["content"].strip() in ("{}", "{\n}")), None)
if deny_v and allow_v:
    st, res, _ = req("GET", f"/api/acl/diff?from={allow_v['id']}&to={deny_v['id']}", cookie=cookie)
    check("GET /api/acl/diff 返回 200", st == 200, f"HTTP {st}")
    lines = res.get("lines", []) if isinstance(res, dict) else []
    nonsame = [x for x in lines if x["type"] != "same"]
    check("差异结果含增删行", len(nonsame) > 0, f"{len(lines)} 行，非 same {len(nonsame)} 行")
else:
    check("找到内容不同的两个版本用于 diff", False, f"deny={bool(deny_v)} allow={bool(allow_v)}")

print(f"\n{'=' * 92}")
print("9. 访问检查：默认语义与边界")
print(f"{'=' * 92}")

# 用真实存在的两台设备（一次性设备与反例设备），避免硬编码已失效的 ID
A_ID, B_ID = TMP_ID, (peer_node["id"] if peer_node else TMP_ID)

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": A_ID}, "to": {"nodeId": B_ID}, "port": 22, "proto": "tcp",
                  "draftContent": "{}"}, cookie=cookie)
check("全通模式：允许", st == 200 and res.get("allowed") is True,
      f"reason={res.get('reason')} err={res.get('error')}")
check("全通模式理由正确", res.get("reason") == "allow-all-default", str(res.get("reason")))
check("全通模式解释说明「未配置规则即全通」",
      "全通" in str(res.get("explanation", "")), str(res.get("explanation", ""))[:70])

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": A_ID}, "to": {"nodeId": B_ID}, "port": 22, "proto": "tcp",
                  "draftContent": '{"acls":[]}'}, cookie=cookie)
check("全禁模式：拒绝", st == 200 and res.get("allowed") is False, f"reason={res.get('reason')}")
check("全禁模式理由正确", res.get("reason") == "deny-all-default", str(res.get("reason")))

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"cidr": "100.64.0.0/24"}, "to": {"nodeId": TMP_ID}, "port": 443, "proto": "tcp",
                  "draftContent": DRAFT_TAG}, cookie=cookie)
check("按 CIDR 作为源可命中", st == 200 and res.get("allowed") is True, f"reason={res.get('reason')}")

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "port": 0, "proto": "tcp",
                  "draftContent": '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:0-65535"]}]}'},
                 cookie=cookie)
check("端口区间 0-65535 覆盖任意端口", st == 200 and res.get("allowed") is True, f"reason={res.get('reason')}")

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": TMP_ID}, "to": {"nodeId": TMP_ID}, "proto": "*",
                  "draftContent": '{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:*"]}]}'},
                 cookie=cookie)
check("proto=* 给出明确错误", st == 200 and res.get("error") is not None, str(res.get("error"))[:70])

st, res, _ = req("POST", "/api/acl/check",
                 {"from": {"nodeId": 99999}, "to": {"nodeId": 1}, "draftContent": "{}"}, cookie=cookie)
check("不存在的节点给出明确错误", st == 200 and res.get("error") is not None, str(res.get("error"))[:60])

print(f"\n{'=' * 92}")
print("10. 带外变更检测（headscale 侧被直接改动）")
print(f"{'=' * 92}")
st, res, _ = req("GET", "/api/acl/policy", cookie=cookie)
print(f"      改动前 drifted={res.get('drift', {}).get('drifted')}")

hs_set_policy({"tagOwners": {TAGNAME: ["labadmin@"]},
               "acls": [{"action": "accept", "proto": "tcp", "src": ["labadmin@"], "dst": [f"{TAGNAME}:22"]}]})

st, res, _ = req("GET", "/api/acl/policy", cookie=cookie)
drift = res.get("drift", {}) if isinstance(res, dict) else {}
check("检测到带外变更", drift.get("drifted") is True, f"drifted={drift.get('drifted')}")
check("给出解释", bool(drift.get("explanation")), str(drift.get("explanation"))[:88])

print(f"\n{'=' * 92}")
print("11. 回滚")
print(f"{'=' * 92}")
st, res, _ = req("GET", "/api/acl/versions?limit=200", cookie=cookie)
versions = res.get("versions", []) if isinstance(res, dict) else []
target = next((v for v in versions if v.get("applied") and v["summary"]["acls"] == 1 and "tagOwners" not in v["content"]), None)
if target:
    print(f"      回滚目标：版本 #{target['id']}（{target['summary']['acls']} 条规则，无 tagOwners）")
    st, res, _ = req("POST", f"/api/acl/versions/{target['id']}/rollback",
                     {"acknowledgedImpact": True}, cookie=cookie, csrf=csrf)
    check("回滚成功", st == 200, f"HTTP {st} {str(res)[:100]}")

    st, res, _ = req("GET", "/api/acl/policy", cookie=cookie)
    check("回滚后不再有漂移", res.get("drift", {}).get("drifted") is False,
          str(res.get("drift", {}).get("explanation"))[:78])

    st, res, _ = req("GET", "/api/acl/versions?limit=5", cookie=cookie)
    latest = res.get("versions", [{}])[0] if isinstance(res, dict) else {}
    check("回滚也记录为新版本（保留完整轨迹）", latest.get("source") == "rollback",
          f"source={latest.get('source')} comment={latest.get('comment')}")
else:
    check("找到可回滚的版本", False, "版本库中没有合适的回滚目标")

print(f"\n{'=' * 92}")
print("12. 编辑器上下文")
print(f"{'=' * 92}")
st, res, _ = req("GET", "/api/acl/context", cookie=cookie)
check("GET /api/acl/context 返回 200", st == 200)
if st == 200:
    check("返回用户清单（含 user@ 形式）", len(res.get("users", [])) > 0,
          str([u["token"] for u in res.get("users", [])]))
    check("返回设备清单", len(res.get("nodes", [])) > 0, f"{len(res.get('nodes', []))} 台")
    check("返回 autogroup 白名单（区分 src/dst）",
          "src" in res.get("autogroups", {}) and "dst" in res.get("autogroups", {}),
          f"src={res.get('autogroups', {}).get('src')}")
    check("返回协议清单", "tcp" in res.get("protocols", []))

print(f"\n{'=' * 92}")
print("13. 权限校验")
print(f"{'=' * 92}")
st, res, _ = req("GET", "/api/acl/policy")
check("未登录访问被拒（401）", st == 401, f"HTTP {st}")

# ---------------- 清理 ----------------
print(f"\n{'=' * 92}")
print("14. 清理")
print(f"{'=' * 92}")
if TMP_ID:
    st, res, _ = req("POST", f"/api/nodes/{TMP_ID}/delete", {"confirm": True}, cookie=cookie, csrf=csrf)
    check("删除一次性设备", st == 200, f"HTTP {st}")
    st, _ = hs_call("GET", f"/api/v1/node/{TMP_ID}")
    check("headscale 侧确认已删除", st != 200, f"HTTP {st}")

print(f"\n{'=' * 92}")
print(f"结果：{len(PASSED)} 通过 / {len(FAILED)} 失败" + ("（含 2 项 SKIP：/debug/filter 容器内不可达）" if DEBUG_UNAVAILABLE else ""))
if FAILED:
    print("失败项：")
    for f in FAILED:
        print(f"  ✗ {f}")
print("=" * 92)
