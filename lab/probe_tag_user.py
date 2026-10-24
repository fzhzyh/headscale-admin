#!/usr/bin/env python3
"""探针：标签设备的 user 字段在「列表」与「单节点」接口上的差异。

背景：ACL 引擎依赖 `node.user.name` 判断设备归属。实测发现
headscale 对已打标签的设备在**两个接口上返回不同的 user 值**：
  - GET /api/v1/node        → user = {name: "tagged-devices", id: 2147455555}
  - GET /api/v1/node/{id}   → user = null
这会影响面板的 shapeNode 与审计日志里记录归属的代码，必须查清并统一处理。

用法：HS_API_KEY=... python3 lab/probe_tag_user.py
"""
import json
import os
import sys
import urllib.request
import urllib.error

# 本地联调：强制直连，避免 macOS 系统代理把 127.0.0.1 的请求送去代理
# （曾导致「同一 Key 时而 200 时而 401」的间歇性假故障，详见 _local_net.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_hs_key  # noqa: E402

bypass_proxy_for_local()

HS = os.environ.get("HS_URL", "http://127.0.0.1:18080")
KEY = load_hs_key()
if not KEY:
    raise SystemExit("需要 HS_API_KEY")


def g(path):
    r = urllib.request.Request(f"{HS}{path}", headers={"Authorization": f"Bearer {KEY}"})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:200]


st, res = g("/api/v1/node")
nodes = res.get("nodes", []) if isinstance(res, dict) else []
print(f"列表接口 HTTP {st}，共 {len(nodes)} 台\n")

# 若当前没有已打标签的设备，自造一台用于对比（用完删除，不留痕）
MADE_ID = None
PRISTINE = [n for n in nodes if not n.get("tags")]
if not [n for n in nodes if n.get("tags")] and len(PRISTINE) >= 1:
    import secrets
    import string
    TMP = "probe-tag-" + "".join(secrets.choice(string.digits) for _ in range(4))
    A = string.ascii_letters + string.digits + "-_"

    def post(path, payload):
        r = urllib.request.Request(
            f"{HS}{path}", data=json.dumps(payload).encode(), method="POST",
            headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(r, timeout=15) as resp:
            return json.loads(resp.read().decode())

    aid = "hskey-authreq-" + "".join(secrets.choice(A) for _ in range(24))
    post("/api/v1/debug/node", {"user": "labadmin", "key": aid, "name": TMP, "routes": []})
    r = post("/api/v1/auth/register", {"user": "labadmin", "authId": aid})
    nid = r.get("node", {}).get("id")
    print(f"（自造一次性设备 {TMP} id={nid} 用于对比）")
    # 先确保 tagOwners 已定义，否则打标签会被拒
    st_p, cur = g("/api/v1/policy")
    pol = json.loads(cur.get("policy") or "{}")
    pol.setdefault("tagOwners", {})["tag:probe"] = ["labadmin@"]
    pol.setdefault("acls", [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}])
    rq = urllib.request.Request(
        f"{HS}/api/v1/policy", data=json.dumps({"policy": json.dumps(pol)}).encode(), method="PUT",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    urllib.request.urlopen(rq, timeout=15)
    try:
        post(f"/api/v1/node/{nid}/tags", {"nodeId": str(nid), "tags": ["tag:probe"]})
        MADE_ID = int(nid)
    except urllib.error.HTTPError as e:
        print(f"  打标签失败：{e.read().decode()[:160]}")
    st, res = g("/api/v1/node")
    nodes = res.get("nodes", []) if isinstance(res, dict) else []
    print()

print("=== 列表接口 GET /api/v1/node ===")
for n in nodes:
    u = n.get("user")
    print(f"  id={n['id']:<3} {n['name']:<22} tags={str(n.get('tags') or []):<16} "
          f"user={json.dumps(u, ensure_ascii=False) if u else u}")

print("\n=== 单节点接口 GET /api/v1/node/{id} ===")
for n in nodes:
    st2, r2 = g(f"/api/v1/node/{n['id']}")
    s = (r2 or {}).get("node") or {} if isinstance(r2, dict) else {}
    u = s.get("user")
    print(f"  id={s.get('id')} {str(s.get('name')):<22} tags={str(s.get('tags') or []):<16} "
          f"user键={'有' if 'user' in s else '无'} user={json.dumps(u, ensure_ascii=False) if u else u}")

print("\n=== 结论判定 ===")
tagged = [n for n in nodes if n.get("tags")]
if not tagged:
    print("  当前没有已打标签的设备，无法对比。请先用 E2E 或面板给某台设备打标签。")
else:
    n0 = tagged[0]
    st2, r2 = g(f"/api/v1/node/{n0['id']}")
    s = (r2 or {}).get("node") or {}
    list_user = (n0.get("user") or {}).get("name")
    single_user = (s.get("user") or {}).get("name")
    print(f"  以 id={n0['id']}（tags={n0['tags']}）为例：")
    print(f"    列表接口   user.name = {list_user!r}")
    print(f"    单节点接口 user.name = {single_user!r}")
    if list_user != single_user:
        print("  ⇒ 两接口不一致：面板必须以「列表接口」为准判断归属，")
        print("    单节点接口的 user 为 null 不能当作「无归属」处理。")
    else:
        print("  ⇒ 两接口一致。")

# ---------------- 清理 ----------------
if MADE_ID:
    try:
        rq = urllib.request.Request(
            f"{HS}/api/v1/node/{MADE_ID}", method="DELETE",
            headers={"Authorization": f"Bearer {KEY}"},
        )
        urllib.request.urlopen(rq, timeout=15)
        print(f"\n（已删除一次性设备 id={MADE_ID}）")
    except urllib.error.HTTPError as e:
        print(f"\n（清理失败 id={MADE_ID}：{e.code}）")
