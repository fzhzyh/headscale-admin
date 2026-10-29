#!/usr/bin/env python3
"""
为**截图/演示**造一批可读数据（不是测试夹具，测试夹具见 seed_lab.py）。

做三件事：
  1. 写一个真实的 ACL 策略（分组 + hosts + 多规则）→ 拓扑图才有边、ACL 页才有内容
  2. 造若干设备并打标签 → 设备列表不再是一排「—」
  3. 向 InfluxDB 写 24h 历史采样（online 有起伏）→ 趋势图有曲线，而不是一条压线

## 为什么设备只能是「离线」
合成节点（debug/node）没有真实 tailscaled 连接，headscale 判定 offline，
且没有任何 API 能改 lastSeen。所以设备列表的在线状态保持真实离线；
趋势图反映的是**历史**采样（曾经在线），与「当前 0 在线」不矛盾。

## 用法
  python3 lab/seed_demo.py            # 造数据
  python3 lab/seed_demo.py --reset    # 把 ACL 策略恢复为 null（截图完清场）

退出码：0 成功；1 部分失败
"""
from __future__ import annotations

import json
import os
import secrets
import string
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_endpoints, load_hs_key  # noqa: E402

bypass_proxy_for_local()
EP = load_endpoints()
PANEL = EP["PANEL_URL"]
HS = EP["HS_URL"]
HS_KEY = load_hs_key()
PANEL_PASS = EP.get("PANEL_ADMIN_SECRET", "")
INFLUX = EP.get("INFLUX_URL", "")
INFLUX_TOKEN = ""
tok_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "container", "state", "influx-token")
if os.path.isfile(tok_file):
    INFLUX_TOKEN = open(tok_file, encoding="utf-8").read().strip()


def call(base: str, method: str, path: str, payload=None, headers=None):
    data = json.dumps(payload).encode() if payload is not None else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            body = r.read().decode()
            return r.status, (json.loads(body) if body.strip().startswith(("{", "[")) else body), r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300], {}
    except Exception as e:  # noqa: BLE001
        return 0, str(e), {}


def hs(method: str, path: str, payload=None):
    return call(HS, method, path, payload, {"Authorization": f"Bearer {HS_KEY}"})


CSRF = ""


def panel_login() -> str:
    """登录并顺带取 CSRF token。

    面板对写操作强制校验 `X-CSRF-Token`（server/src/auth/guard.ts 的 csrfOk），
    token 在 /api/auth/session 的 csrfToken 字段里。不带会 403 BAD_CSRF。
    """
    global CSRF
    s, b, h = call(PANEL, "POST", "/api/auth/login", {"username": "admin", "password": PANEL_PASS})
    if s != 200:
        raise SystemExit(f"面板登录失败 HTTP {s}: {b}")
    cookies = h.get_all("Set-Cookie") or []
    ck = "; ".join(c.split(";")[0] for c in cookies)
    s2, b2, _ = call(PANEL, "GET", "/api/auth/session", None, {"Cookie": ck})
    if s2 != 200 or not isinstance(b2, dict):
        raise SystemExit(f"取 session 失败 HTTP {s2}: {str(b2)[:150]}")
    CSRF = b2.get("csrfToken", "")
    if not CSRF:
        raise SystemExit("session 里没有 csrfToken")
    return ck


CK = panel_login()


def panel(method: str, path: str, payload=None):
    h = {"Cookie": CK}
    if method != "GET":
        h["X-CSRF-Token"] = CSRF
    return call(PANEL, method, path, payload, h)


# ============================================================ ACL 策略
# 设计要点：让拓扑图能画出**有方向的多条边**，同时覆盖分组/hosts/tag 三类语法。
DEMO_POLICY = {
    "groups": {
        "group:eng": ["labadmin@"],
        "group:ops": ["devops@"],
    },
    "hosts": {
        "db-primary": "100.64.0.11/32",
        "db-replica": "100.64.0.12/32",
        "cache-01": "100.64.0.13/32",
    },
    "tagOwners": {
        "tag:server": ["group:ops"],
        "tag:db": ["group:ops"],
    },
    "acls": [
        {"action": "accept", "src": ["group:eng"], "dst": ["group:eng:*"]},
        {"action": "accept", "src": ["group:ops"], "dst": ["group:eng:*"]},
        {"action": "accept", "src": ["group:ops"], "dst": ["group:ops:*"]},
        {"action": "accept", "src": ["group:eng"], "dst": ["db-primary:5432"]},
        {"action": "accept", "src": ["group:eng"], "dst": ["db-replica:5432"]},
        {"action": "accept", "src": ["group:ops"], "dst": ["cache-01:6379"]},
        {"action": "accept", "src": ["group:ops"], "dst": ["tag:server:22"]},
        {"action": "accept", "src": ["group:eng"], "dst": ["tag:db:5432"]},
    ],
}

# ============================================================ 设备
# (名字, headscale 用户, 标签)
DEMO_NODES = [
    ("web-01", "labadmin", []),
    ("web-02", "labadmin", []),
    ("ci-runner", "labadmin", []),
    ("db-primary", "devops", ["tag:db"]),
    ("db-replica", "devops", ["tag:db"]),
    ("cache-01", "devops", ["tag:server"]),
    ("bastion", "devops", ["tag:server"]),
    ("monitoring", "devops", []),
]


def ensure_user(name: str) -> int | None:
    s, b, _ = hs("GET", "/api/v1/user")
    users = b.get("users") if isinstance(b, dict) else []
    for u in users or []:
        if u.get("name") == name:
            return u.get("id")
    s, b, _ = hs("POST", "/api/v1/user", {"name": name})
    if s in (200, 201) and isinstance(b, dict):
        return (b.get("user") or {}).get("id")
    print(f"  ⚠️ 建用户 {name} 失败 HTTP {s}: {str(b)[:120]}")
    return None


def make_node(name: str, user: str) -> bool:
    """走 debug/node + auth/register 造一个合成节点（不存在的真实客户端）。"""
    auth_id = "hskey-authreq-" + "".join(
        secrets.choice(string.ascii_letters + string.digits + "-_") for _ in range(24)
    )
    s, b, _ = hs("POST", "/api/v1/debug/node", {"user": user, "key": auth_id, "name": name})
    if s not in (200, 201):
        print(f"  ✗ {name} debug/node HTTP {s}: {str(b)[:120]}")
        return False
    s, b, _ = hs("POST", "/api/v1/auth/register", {"user": user, "authId": auth_id})
    if s not in (200, 201):
        print(f"  ✗ {name} register HTTP {s}: {str(b)[:120]}")
        return False
    return True


def node_id_by_name(name: str) -> int | None:
    s, b, _ = hs("GET", "/api/v1/node")
    nodes = b.get("nodes") if isinstance(b, dict) else []
    for n in nodes or []:
        if n.get("givenName") == name or n.get("name") == name:
            return n.get("id")
    return None


def main() -> int:
    if "--reset" in sys.argv:
        print("=== 恢复 ACL 策略为 null ===")
        # 清空策略 = 传一个空的 HuJSON 对象；传 null 会让 parsePolicy 失败
        s, b, _ = panel("PUT", "/api/acl/policy",
                        {"content": "{}", "comment": "重置为空策略（全通模式）",
                         "source": "manual", "acknowledgedImpact": True})
        print(f"  HTTP {s} {str(b)[:120]}")
        return 0

    fails = 0

    # ---------- 1. ACL 策略（必须先于打标签）----------
    #
    # 顺序有依赖：headscale 打标签时会校验 tagOwners，策略里没定义 tag:db /
    # tag:server 就返回 400 TAG_NOT_OWNED。所以先应用策略，再打标签。
    print("=== 1. ACL 策略 ===")
    # content 是 HuJSON **文本**（z.string()），不是对象 —— 传对象会 BAD_INPUT: Required
    content = json.dumps(DEMO_POLICY, ensure_ascii=False, indent=2)
    s, b, _ = panel("PUT", "/api/acl/policy",
                    {"content": content, "comment": "演示数据（截图用）",
                     "source": "manual", "acknowledgedImpact": True})
    if s == 200:
        print(f"  ✓ 已应用（{len(DEMO_POLICY['acls'])} 条规则 / {len(DEMO_POLICY['groups'])} 个分组 / "
              f"{len(DEMO_POLICY['tagOwners'])} 个标签归属）")
    else:
        print(f"  ✗ HTTP {s}: {str(b)[:250]}")
        fails += 1

    # ---------- 2. 设备 ----------
    print("\n=== 2. 演示设备 ===")
    for name, user, tags in DEMO_NODES:
        uid = ensure_user(user)
        if uid is None:
            fails += 1
            continue
        nid = node_id_by_name(name)
        if nid is None:
            if not make_node(name, user):
                fails += 1
                continue
            nid = node_id_by_name(name)
            print(f"  ✓ 新建 {name:12} user={user:10} id={nid}")
        else:
            print(f"  = 已存在 {name:12} user={user:10} id={nid}")
        if tags and nid:
            s, b, _ = panel("POST", f"/api/nodes/{nid}/tags", {"tags": tags})
            if s == 200:
                print(f"      标签 → {tags}")
            else:
                print(f"      ⚠️ 打标签失败 HTTP {s}: {str(b)[:100]}")

    # ---------- 3. InfluxDB 历史采样 ----------
    print("\n=== 3. InfluxDB 24h 历史采样 ===")
    if not (INFLUX and INFLUX_TOKEN):
        print("  ⚠️ 时序库未配置，跳过（趋势图会保持平线）")
    else:
        s, b, _ = panel("GET", "/api/nodes")
        nodes = b.get("nodes") if isinstance(b, dict) else []
        total = len(nodes or [])
        now = int(time.time())
        step = 900            # 15 分钟一个点，24h = 96 点
        lines = []
        for i in range(96, -1, -1):
            ts = now - i * step
            # 用正弦波模拟在线起伏：白天高、夜间低，加一点噪声
            import math
            phase = (i / 96.0) * 2 * math.pi
            ratio = 0.45 + 0.35 * math.sin(phase - 1.2)
            online = max(0, min(total, round(total * ratio)))
            lines.append(
                f"cluster nodes_total={total},nodes_online={online},"
                f"nodes_offline={total - online},online_ratio={round(online / total, 3) if total else 0},"
                f"routes_available=3,routes_approved=2 {ts}"
            )
            # 每台设备的 node_status
            for idx, n in enumerate(nodes or [], start=1):
                nid = str(n.get("id"))
                nm = (n.get("displayName") or n.get("name") or "").replace(" ", "\\ ")
                on = 1 if idx <= online else 0
                lines.append(
                    f"node_status,node_id={nid},name={nm} online={on},"
                    f"online_streak_sec={step if on else 0},last_seen_age_sec={5 if on else 1800},"
                    f"routes_available=1,routes_approved=1 {ts}"
                )
        payload = "\n".join(lines).encode()
        req = urllib.request.Request(
            f"{INFLUX}/api/v3/write_lp?db=headscale_admin&precision=second",
            data=payload, method="POST",
            headers={"Authorization": f"Bearer {INFLUX_TOKEN}",
                     "Content-Type": "text/plain; charset=utf-8"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                print(f"  ✓ 写入 {len(lines)} 行（HTTP {r.status}），覆盖 24h / 96 个点")
        except urllib.error.HTTPError as e:
            print(f"  ✗ HTTP {e.code}: {e.read().decode()[:200]}")
            fails += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ {e}")
            fails += 1

    print("\n完成" + ("" if fails == 0 else f"，{fails} 项失败"))
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
