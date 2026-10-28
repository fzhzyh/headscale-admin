#!/usr/bin/env python3
"""DNS extra-records（P5）后端语义验证。

本套件围绕一个**后果很重**的事实展开：

    headscale 启动时读到非法 JSON 会直接 fatal

实测日志：
    Error: headscale ran into an error and had to shut down:
      setting up extrarecord manager: reading extra records from path:
      unmarshalling records, content: "{ this is not valid json\\n":
      invalid character 't' looking for beginning of object key string

也就是说面板一旦把文件写坏，整个联调环境下次就起不来。所以本套件的
**每一段结束时都断言文件仍是合法 JSON 数组**——这是比"功能对不对"更硬的底线。

另外两条也一并验证：
  · 只支持 A / AAAA，且类型必须与值匹配（A→IPv4，AAAA→IPv6）
  · 应用是全量覆盖；文件里有手改条目时必须先 409 让人确认

跑法：python3 lab/verify_dns.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_endpoints  # noqa: E402

bypass_proxy_for_local()
_EP = load_endpoints()

BASE = _EP["PANEL_URL"]
ADMIN_USER = _EP.get("PANEL_ADMIN_USER", "admin")
ADMIN_PASS = _EP.get("PANEL_ADMIN_SECRET", "")

# 文件在宿主机上的真实路径（与 up.sh 的 STATE_DIR/dns 一致）
HERE = os.path.dirname(os.path.abspath(__file__))
HOST_FILE = os.path.join(HERE, "..", "container", "state", "dns", "extra-records.json")
HOST_FILE = os.path.normpath(HOST_FILE)

PASS, FAIL = [], []
TEST_PREFIX = "t-verify."


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
            raw, code, hdrs = resp.read().decode(), resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        raw, code, hdrs = e.read().decode(), e.code, dict(e.headers)
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


def file_state():
    """直接读宿主机上的文件，返回 (是否合法, 内容)"""
    if not os.path.exists(HOST_FILE):
        return False, None
    try:
        with open(HOST_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return isinstance(data, list), data
    except Exception:
        return False, None


def wait_for(fn, timeout=10.0, interval=0.3):
    """轮询直到 fn() 为真或超时，返回最后一次结果。

    为什么必须轮询：Apple container 的 virtiofs 挂载在宿主与容器之间
    **不是即时一致**的——宿主写完文件后，容器内读到新内容可能有几百 ms 到
    数秒延迟（反向亦然：面板在容器内写完，宿主立刻读可能还是旧内容）。
    测试若假设「写完即可读」，会得到一堆假失败（实测踩过：同一断言
    前一次读失败、几秒后再读通过）。
    """
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


def assert_file_valid(tag):
    ok, _ = file_state()
    check(f"★ [{tag}] 文件仍是合法 JSON 数组（否则 headscale 重启会 fatal）", ok)


cookie, csrf = login()

# 起点：清掉上一轮遗留的测试记录，并应用一次让文件与库对齐
code, body, _ = req("GET", "/api/dns/records", cookie=cookie)
for r in body.get("records", []):
    if r["name"].startswith(TEST_PREFIX):
        req("DELETE", f"/api/dns/records/{r['id']}", cookie=cookie, csrf=csrf)
req("POST", "/api/dns/apply", {"force": True}, cookie, csrf)

# ============================================================
section("1. 权限与状态自检")
check("未登录访问被拒", req("GET", "/api/dns/records")[0] == 401)
code, status, _ = req("GET", "/api/dns/status", cookie=cookie)
check("状态接口可读", code == 200)
check("返回文件路径", bool(status.get("path")), status.get("path"))
check("文件当前合法", status.get("valid") is True, str(status.get("error")))
check("声明只支持 A/AAAA", status.get("constraints", {}).get("onlyAandAAAA") is True)
check(
    "声明非法 JSON 会导致启动失败",
    "启动" in status.get("constraints", {}).get("invalidJsonIsFatal", ""),
    status.get("constraints", {}).get("invalidJsonIsFatal", "")[:40],
)
check(
    "声明写入成功≠已可解析（不假装验证过）",
    "无法证明" in status.get("constraints", {}).get("silentReload", "")
    or "不能证明" in status.get("constraints", {}).get("silentReload", ""),
    status.get("constraints", {}).get("silentReload", "")[:40],
)

# ============================================================
section("2. 校验：类型必须与值匹配，名字必须合法")
cases = [
    ("A 记录配 IPv4 合法", {"name": f"{TEST_PREFIX}a.lab.internal", "type": "A", "value": "100.64.0.9"}, None),
    ("A 记录配 IPv6 应拒绝", {"name": f"{TEST_PREFIX}bad1.lab.internal", "type": "A", "value": "fd7a::1"}, "BAD_VALUE"),
    ("AAAA 记录配 IPv6 合法", {"name": f"{TEST_PREFIX}aaaa.lab.internal", "type": "AAAA", "value": "fd7a:115c:a1e0::99"}, None),
    ("AAAA 记录配 IPv4 应拒绝", {"name": f"{TEST_PREFIX}bad2.lab.internal", "type": "AAAA", "value": "10.0.0.1"}, "BAD_VALUE"),
    ("非法类型应拒绝", {"name": f"{TEST_PREFIX}bad3.lab.internal", "type": "CNAME", "value": "x.y"}, "BAD_INPUT"),
    ("通配符应拒绝", {"name": f"*.{TEST_PREFIX}x.lab.internal", "type": "A", "value": "10.0.0.1"}, "BAD_NAME"),
    ("非法域名应拒绝", {"name": "bad name with space", "type": "A", "value": "10.0.0.1"}, "BAD_NAME"),
]
created = {}
for label, payload, want_err in cases:
    code, body, _ = req("POST", "/api/dns/records", payload, cookie, csrf)
    if want_err is None:
        check(label, code == 201, f"HTTP {code} {body.get('error')}")
        if code == 201:
            created[payload["name"]] = (body.get("record") or {}).get("id")
    else:
        check(label, code == 400 and body.get("error") == want_err, f"HTTP {code} {body.get('error')}")
assert_file_valid("校验阶段")

check("同名同类型重复被拒", req("POST", "/api/dns/records",
      {"name": f"{TEST_PREFIX}a.lab.internal", "type": "A", "value": "1.2.3.4"}, cookie, csrf)[1].get("error") == "DUP_RECORD")

# ============================================================
section("3. 应用：写入文件且内容与库一致")
code, before_status, _ = req("GET", "/api/dns/status", cookie=cookie)
check("应用前文件与库不一致（有新增未应用）", before_status.get("drift") is True,
      f"文件 {before_status.get('fileCount')} / 库 {before_status.get('dbCount')}")

code, res, _ = req("POST", "/api/dns/apply", {}, cookie, csrf)
check("应用成功", code == 200 and res.get("ok") is True, f"HTTP {code} {res.get('error')}")
check("返回写入条数", isinstance(res.get("count"), int), str(res.get("count")))
check("如实说明「无法证明 DNS 已可解析」", "无法证明" in (res.get("note") or "") or "需真实" in (res.get("note") or ""))

ok, content = file_state()
check("★ 文件是合法 JSON 数组", ok)
if ok and content is not None:
    names = {x.get("name") for x in content}
    check("文件里含刚新增的记录", f"{TEST_PREFIX}a.lab.internal" in names)
    check("文件里的记录只有 name/type/value 三个字段", all(set(x.keys()) == {"name", "type", "value"} for x in content),
          str(sorted(content[0].keys()) if content else []))

code, after_status, _ = req("GET", "/api/dns/status", cookie=cookie)
check("应用后文件与库一致", after_status.get("drift") is False,
      f"文件 {after_status.get('fileCount')} / 库 {after_status.get('dbCount')}")
check("mtime 已更新", after_status.get("mtime") is not None)

# ============================================================
section("4. 手改文件：必须拦住，不能悄悄覆盖")
ok, content = file_state()
if ok and isinstance(content, list):
    content.append({"name": f"{TEST_PREFIX}handmade.lab.internal", "type": "A", "value": "192.0.2.77"})
    with open(HOST_FILE, "w", encoding="utf-8") as f:
        json.dump(content, f, indent=2)
    check("已手工往文件里塞一条记录", True)

# virtiofs 有传播延迟：轮询直到面板看到手改内容
status = {}
for _ in range(40):
    code, status, _ = req("GET", "/api/dns/status", cookie=cookie)
    if status.get("drift") is True:
        break
    time.sleep(0.3)
check("状态检测到不一致", status.get("drift") is True,
      f"文件 {status.get('fileCount')} / 库 {status.get('dbCount')}")
check("列出文件独占条目", any("handmade" in x for x in status.get("fileOnly", [])), str(status.get("fileOnly")))

code, body, _ = req("POST", "/api/dns/apply", {}, cookie, csrf)
check("不带 force 被 409 拦住", code == 409 and body.get("error") == "FILE_DRIFT",
      f"HTTP {code} {body.get('error')}")
check("冲突详情列出条目", any("handmade" in x for x in (body.get("fileOnly") or [])))
ok, content2 = file_state()
check("被拦下时文件未被改动", ok and any(
    x.get("name") == f"{TEST_PREFIX}handmade.lab.internal" for x in (content2 or [])), "手改记录仍在")

code, res, _ = req("POST", "/api/dns/apply", {"force": True}, cookie, csrf)
check("带 force 覆盖成功", code == 200 and res.get("ok") is True)
ok, content3 = file_state()
check("覆盖后手改记录已消失",
      ok and not any(x.get("name") == f"{TEST_PREFIX}handmade.lab.internal" for x in (content3 or [])))
assert_file_valid("手改覆盖后")

# ============================================================
section("5. 删除：应用后从文件移除")
code, body, _ = req("GET", "/api/dns/records", cookie=cookie)
target = next((r for r in body["records"] if r["name"] == f"{TEST_PREFIX}aaaa.lab.internal"), None)
check("找到待删记录", target is not None)
if target:
    check("删除成功", req("DELETE", f"/api/dns/records/{target['id']}", cookie=cookie, csrf=csrf)[0] == 200)

    # ★ 回归断言：删完直接 apply 必须成功，不能被 FILE_DRIFT 拦住。
    #   旧实现只看「文件里有、库里没有」就判手改，导致删一条记录后
    #   apply 恒 409（自己的删除被误判成别人手改）。修法是记住上次写入快照。
    code, apply_res, _ = req("POST", "/api/dns/apply", {}, cookie, csrf)
    check("★ 删除后直接应用不被误判为手改（回归）", code == 200,
          f"HTTP {code} {apply_res.get('error')}")

    def gone():
        ok2, c = file_state()
        return (ok2, c) if ok2 and not any(
            x.get("name") == f"{TEST_PREFIX}aaaa.lab.internal" for x in (c or [])) else None

    # 面板在容器内写文件，宿主侧读到新内容有 virtiofs 延迟 → 轮询
    got = wait_for(gone, timeout=10)
    ok, content = file_state()
    check("★ 删除并应用后文件仍合法", ok)
    check("删除的记录已从文件移除", got is not None,
          "依旧存在" if got is None else "已移除")
    code, body, _ = req("GET", "/api/dns/records", cookie=cookie)
    check("列表中已无该记录", all(r["name"] != f"{TEST_PREFIX}aaaa.lab.internal" for r in body["records"]))

# ============================================================
section("6. 清理：确保收尾后文件合法、库中无测试数据")
code, body, _ = req("GET", "/api/dns/records", cookie=cookie)
for r in body.get("records", []):
    if r["name"].startswith(TEST_PREFIX):
        req("DELETE", f"/api/dns/records/{r['id']}", cookie=cookie, csrf=csrf)
req("POST", "/api/dns/apply", {"force": True}, cookie, csrf)

code, body, _ = req("GET", "/api/dns/records", cookie=cookie)
leftover = [r["name"] for r in body.get("records", []) if r["name"].startswith(TEST_PREFIX)]
check("测试记录已清空", leftover == [], str(leftover))
assert_file_valid("收尾")
code, status, _ = req("GET", "/api/dns/status", cookie=cookie)
check("收尾后文件与库一致", status.get("drift") is False,
      f"文件 {status.get('fileCount')} / 库 {status.get('dbCount')}")

print("\n" + "=" * 92)
print(f"结果：{len(PASS)} 通过 / {len(FAIL)} 失败")
if FAIL:
    print("失败项：")
    for f in FAIL:
        print(f"  ✗ {f}")
print("=" * 92)
sys.exit(1 if FAIL else 0)
