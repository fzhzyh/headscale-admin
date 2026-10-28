#!/usr/bin/env python3
"""资源中心（P5）后端语义验证。

重点验证三件**容易做错且代价大**的事：

  1. **同步只写 hosts，绝不动 acls**
     策略里「无 acls 键」= 全通、「acls 为空数组」= 全禁。
     同步逻辑若顺手补一个空 acls 数组，会把全网从全通静默翻成全禁。
     这里每次同步后都断言 acls 的内容与条数**逐字节未变**。

  2. **冲突必须拦住，不能悄悄覆盖**
     策略里可能有人手写维护的 hosts 别名。资源同步遇到同名不同值时
     必须先 409 + 列出冲突，只有显式 overwrite 才改。

  3. **hosts 与端口的职责分离**
     ACL hosts 语法只承载 IP/CIDR，端口只能出现在规则 dst 里。
     资源对象的 dstForms 应该是 `name:port`，而 hosts 里只有 IP。

跑法：python3 lab/verify_resources.py
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_endpoints  # noqa: E402

bypass_proxy_for_local()
_EP = load_endpoints()

BASE = _EP["PANEL_URL"]
ADMIN_USER = _EP.get("PANEL_ADMIN_USER", "admin")
ADMIN_PASS = _EP.get("PANEL_ADMIN_SECRET", "")

PASS, FAIL = [], []


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


def req(method, path, payload=None, cookie=None, csrf=None):
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
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            raw, code = resp.read().decode(), resp.status
            hdrs = dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw, code = e.read().decode(), e.code
        hdrs = dict(e.headers)
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        body = {"_raw": raw}
    return code, body, hdrs


def login():
    code, body, hdrs = req("POST", "/api/auth/login", {"username": ADMIN_USER, "password": ADMIN_PASS})
    if code != 200:
        print(f"✗ 登录失败 HTTP {code}: {body}")
        sys.exit(1)
    cookie = (hdrs.get("Set-Cookie") or hdrs.get("set-cookie") or "").split(";")[0]
    return cookie, body.get("csrfToken", "")


def get_policy(cookie):
    code, body, _ = req("GET", "/api/acl/policy", cookie=cookie)
    assert code == 200, f"读策略失败 {code} {body}"
    return body


BASELINE_ACL = [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}]


def put_policy(cookie, csrf, hosts=None):
    pol = {"acls": BASELINE_ACL}
    if hosts is not None:
        pol["hosts"] = hosts
    content = json.dumps(pol)
    code, body, _ = req("PUT", "/api/acl/policy", {"content": content, "comment": "资源中心测试准备", "source": "manual"}, cookie, csrf)
    assert code == 200, f"设置策略失败 {code} {body}"


TEST_PREFIX = "t-"


def cleanup(cookie, csrf, names=frozenset()):
    """删掉测试资源。

    按 `t-` 前缀清理而不是只按固定集合：手工探测留下的同名资源会让
    「改名成冲突名」这类用例莫名失败（实测踩过——之前手工建的 legacy-svc
    污染了环境，导致改名撞 NAME_TAKEN）。测试夹具统一用 t- 前缀，
    就能保证每次从干净状态开始。
    """
    code, body, _ = req("GET", "/api/resources", cookie=cookie)
    for r in body.get("resources", []):
        if r["name"] in names or r["name"].startswith(TEST_PREFIX):
            req("DELETE", f"/api/resources/{r['id']}?removeFromHosts=1", cookie=cookie, csrf=csrf)


cookie, csrf = login()

# 清掉上一轮可能残留的测试资源，并把策略恢复成干净基线
TEST_NAMES = {"t-db", "t-legacy", "t-conflict", "t-ports", "t-group"}
cleanup(cookie, csrf, TEST_NAMES)
put_policy(cookie, csrf)

# ============================================================
section("1. 初始状态与权限")
code, body, _ = req("GET", "/api/resources", cookie=cookie)
check("资源列表可读", code == 200)
check("列表结构完整（resources + stats）", "resources" in body and "stats" in body)
check("未登录被拒", req("GET", "/api/resources")[0] == 401)

# ============================================================
section("2. 校验：挡掉会破坏 ACL 语义的输入")
cases = [
    ("资源名撞 ACL 身份语法 tag:", {"name": "tag:evil", "ip": "10.0.0.1"}, "BAD_NAME"),
    ("资源名撞 user@ 形式", {"name": "user@host", "ip": "10.0.0.1"}, "BAD_NAME"),
    ("资源名以数字开头也允许（合法）", {"name": "9svc", "ip": "10.0.0.1"}, None),
    ("非法 IPv4", {"name": "bad1", "ip": "999.1.1.1"}, "BAD_IP"),
    ("非法 IPv6", {"name": "bad2", "ip": "gggg::1"}, "BAD_IP"),
    ("IPv4 前缀越界", {"name": "bad3", "ip": "10.0.0.0/33"}, "BAD_IP"),
    ("端口越界", {"name": "bad4", "ip": "10.0.0.1", "ports": "70000"}, "BAD_PORTS"),
    ("端口区间起止颠倒", {"name": "bad5", "ip": "10.0.0.1", "ports": "9000-8000"}, "BAD_PORTS"),
]
created = []
for label, payload, want_err in cases:
    code, body, _ = req("POST", "/api/resources", payload, cookie, csrf)
    if want_err is None:
        check(label, code in (201, 409), f"HTTP {code}")
        if code == 201:
            created.append(payload["name"])
    else:
        check(label, code == 400 and body.get("error") == want_err, f"HTTP {code} {body.get('error')}")
for n in created:
    code, body, _ = req("GET", "/api/resources", cookie=cookie)
    for r in body.get("resources", []):
        if r["name"] == n:
            req("DELETE", f"/api/resources/{r['id']}", cookie=cookie, csrf=csrf)

check("合法 CIDR 可创建", req("POST", "/api/resources", {"name": "t-db", "ip": "10.20.30.0/24"}, cookie, csrf)[0] == 201)
check("重名被拒", req("POST", "/api/resources", {"name": "t-db", "ip": "1.2.3.4"}, cookie, csrf)[1].get("error") == "NAME_TAKEN")

code, body, _ = req("GET", "/api/resources", cookie=cookie)
t_db = next((r for r in body["resources"] if r["name"] == "t-db"), None)
check("资源被读回", t_db is not None)
check("未指定端口时 dstForms 用 name:*", t_db and t_db["dstForms"] == ["t-db:*"], str(t_db and t_db["dstForms"]))

# ============================================================
section("3. 端口与 hosts 的职责分离（关键语义）")
code, body, _ = req(
    "PUT", f"/api/resources/{t_db['id']}",
    {"name": "t-ports", "ip": "10.20.30.40", "ports": "5432,8000-8010"}, cookie, csrf,
)
check("带端口更新成功", code == 200)
r = body.get("resource") or {}
eq("端口被解析成数组", r.get("ports"), ["5432", "8000-8010"])
eq("dstForms 展开为 name:port（端口只进规则，不进 hosts）", r.get("dstForms"), ["t-ports:5432", "t-ports:8000-8010"])
check("改名后提示需重新同步", body.get("needResync") is True)

# ============================================================
section("4. 同步：只写 hosts，绝不动 acls")
code, prev, _ = req("GET", "/api/acl/policy", cookie=cookie)
acls_before = json.dumps(prev["parsed"].get("acls"), sort_keys=True)

code, preview, _ = req("GET", "/api/resources/sync/preview", cookie=cookie)
check("预览可读", code == 200)
check("预览报告策略模式", preview.get("policy", {}).get("mode") == "rules", str(preview.get("policy", {}).get("mode")))
check("rules 模式下 hosts 生效", preview["policy"]["hostsEffective"] is True)
check("预览列出待新增 hosts", any(a["name"] == "t-ports" for a in preview["hostDiff"]["adds"]),
      str([a["name"] for a in preview["hostDiff"]["adds"]]))

code, res, _ = req("POST", "/api/resources/sync", {"overwrite": False}, cookie, csrf)
check("同步成功", code == 200 and res.get("ok") is True, f"HTTP {code} {res.get('error')}")
check("同步结果声明 acls 未动", res.get("aclsUntouched") is True)
check("写入版本记录", isinstance(res.get("versionId"), int))

code, after, _ = req("GET", "/api/acl/policy", cookie=cookie)
acls_after = json.dumps(after["parsed"].get("acls"), sort_keys=True)
eq("★ acls 逐字节未变", acls_after, acls_before)
eq("hosts 写入了资源名 → IP", after["parsed"].get("hosts", {}).get("t-ports"), "10.20.30.40")
check("hosts 值里不含端口（语法只承载 IP/CIDR）",
      ":" not in str(after["parsed"].get("hosts", {}).get("t-ports", "")),
      str(after["parsed"].get("hosts", {}).get("t-ports")))

code, body, _ = req("GET", "/api/resources", cookie=cookie)
synced = next((r for r in body["resources"] if r["name"] == "t-ports"), None)
check("synced_at 已回填", synced and synced.get("syncedAt"))

# ============================================================
section("5. 冲突：别人手写的 hosts 不能被悄悄覆盖")
MANUAL_HOST = "t-manual-host"
put_policy(cookie, csrf, hosts={MANUAL_HOST: "10.9.9.9"})
check("手写 hosts 已就位", get_policy(cookie)["parsed"].get("hosts", {}).get(MANUAL_HOST) == "10.9.9.9")

# 直接建一个与手写 host 同名的资源；它从未同步过（synced_at 为空），
# 所以同步时必须判定为「冲突」而不是「更新」
code, body, _ = req("POST", "/api/resources", {"name": MANUAL_HOST, "ip": "10.0.0.99"}, cookie, csrf)
t_legacy = (body.get("resource") or {}).get("id")
check("同名资源创建成功（策略里已有同名 host）", code == 201, f"HTTP {code} {body.get('error')}")

code, preview, _ = req("GET", "/api/resources/sync/preview", cookie=cookie)
check("预览识别为冲突（不是普通更新）", preview["stats"]["conflicts"] >= 1,
      f"冲突 {preview['stats']['conflicts']} / 更新 {preview['stats']['toUpdate']}")

code, body, _ = req("POST", "/api/resources/sync", {"overwrite": False}, cookie, csrf)
check("不带 overwrite 被 409 拦住", code == 409 and body.get("error") == "HOSTS_CONFLICT",
      f"HTTP {code} {body.get('error')}")
check("冲突详情列出名字", MANUAL_HOST in (body.get("conflicts") or []), str(body.get("conflicts")))
eq("被拦下时 hosts 未被改动", get_policy(cookie)["parsed"].get("hosts", {}).get(MANUAL_HOST), "10.9.9.9")

code, res, _ = req("POST", "/api/resources/sync", {"overwrite": True}, cookie, csrf)
check("带 overwrite 同步成功", code == 200 and res.get("ok") is True)
eq("覆盖后 hosts 变为资源定义值", get_policy(cookie)["parsed"].get("hosts", {}).get(MANUAL_HOST), "10.0.0.99")

# ============================================================
section("6. 权限控制：组 → 网络身份推导（不自动改连通性）")
code, body, _ = req("GET", "/api/panel/groups", cookie=cookie)
groups = [g["name"] for g in body.get("groups", [])]
check("可读面板组", code == 200 and len(groups) > 0, str(groups[:3]))

if groups:
    gname = groups[0]
    code, body, _ = req("PUT", f"/api/resources/{t_db['id']}", {"ownerGroup": gname}, cookie, csrf)
    check("可设置归属组", code == 200)
    code, preview, _ = req("GET", "/api/resources/sync/preview", cookie=cookie)
    rule = next((r for r in preview["referenceRules"] if r["resource"] == "t-ports"), None)
    check("参考规则出现在预览里", rule is not None)
    if rule:
        check("参考规则按 ownerGroup 标注", rule["ownerGroup"] == gname, rule["ownerGroup"])
        check("参考规则 dst 为 name:port 形式", all(":" in d for d in rule["dst"]), str(rule["dst"]))
        # 组内成员若未绑定网络身份，src 为空且明确说明原因——不编造
        if not rule["executable"]:
            check("组内无绑定身份时如实标注不可执行", rule["src"] == [] and "绑定" in rule["note"], rule["note"])
        else:
            check("组内有绑定身份时给出 src", len(rule["src"]) > 0, str(rule["src"]))
    check("参考规则不会自动写进策略（acls 仍为基线）",
          json.dumps(get_policy(cookie)["parsed"].get("acls"), sort_keys=True) == acls_before)

# ============================================================
section("7. 删除：可选同时清理 hosts，且不动 acls")
acls_pre_del = json.dumps(get_policy(cookie)["parsed"].get("acls"), sort_keys=True)
code, body, _ = req("GET", "/api/resources", cookie=cookie)
legacy = next((r for r in body["resources"] if r["name"] == MANUAL_HOST), None)
check("找到待删资源", legacy is not None)

if legacy:
    code, res, _ = req("DELETE", f"/api/resources/{legacy['id']}?removeFromHosts=1", cookie=cookie, csrf=csrf)
    check("删除成功", code == 200)
    check("同时移除了 hosts 条目", res.get("hostRemoved") is True)
    hosts_now = get_policy(cookie)["parsed"].get("hosts", {})
    check("hosts 里已无该键", MANUAL_HOST not in hosts_now, str(list(hosts_now.keys())))
    eq("★ 删除也未改动 acls", json.dumps(get_policy(cookie)["parsed"].get("acls"), sort_keys=True), acls_pre_del)

code, body, _ = req("GET", "/api/resources", cookie=cookie)
check("删除后列表已无该资源", all(r["name"] != MANUAL_HOST for r in body["resources"]))

# ============================================================
section("8. 清理与还原")
cleanup(cookie, csrf, TEST_NAMES)
put_policy(cookie, csrf)
code, body, _ = req("GET", "/api/resources", cookie=cookie)
leftover = [r["name"] for r in body.get("resources", []) if r["name"] in TEST_NAMES]
check("测试资源已清空", leftover == [], str(leftover))
check("策略已还原为干净基线", json.dumps(get_policy(cookie)["parsed"].get("acls"), sort_keys=True) == json.dumps(BASELINE_ACL, sort_keys=True))
check("hosts 已清空", not get_policy(cookie)["parsed"].get("hosts"))

print("\n" + "=" * 92)
print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print(f"  ✗ {f}")
print("=" * 92)
sys.exit(1 if FAIL else 0)
