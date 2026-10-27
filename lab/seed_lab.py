#!/usr/bin/env python3
"""把容器化的空 headscale 播成「可跑测试」的状态。

新拉起的 headscale 是一张空网：没有用户、没有设备、没有策略。
测试脚本依赖固定的夹具（labadmin/devops 两个用户、四台设备），
所以需要一个幂等的播种步骤。

幂等：已存在就复用，不重复创建（容器重建但数据卷保留时不会冲突）。

用法：
    python3 lab/seed_lab.py                # 播种
    python3 lab/seed_lab.py --routes       # 额外给一台设备批准一条路由（路由用例需要）
"""
from __future__ import annotations

import json
import os
import secrets
import string
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_endpoints, load_hs_key  # noqa: E402

bypass_proxy_for_local()
EP = load_endpoints()
HS = EP["HS_URL"]
KEY = load_hs_key()
PANEL = EP["PANEL_URL"]

ALPHABET = string.ascii_letters + string.digits + "-_"
USERS = ["labadmin", "devops"]
# (用户, 设备名)；设备名决定测试里按名字动态解析的目标
NODES = [("labadmin", "lab-alpha"), ("labadmin", "lab-gamma"),
         ("devops", "lab-beta"), ("devops", "lab-epsilon")]


def hs(method: str, path: str, payload=None) -> tuple[int, object]:
    data = json.dumps(payload).encode() if payload is not None else None
    r = urllib.request.Request(
        f"{HS}{path}", data=data, method=method,
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
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


def panel_login() -> str:
    """登录面板，返回 cookie jar 用的 Cookie 头。"""
    pw = ""
    for line in (open("container/lab.env", encoding="utf-8").read().splitlines()
                 if os.path.exists("container/lab.env") else []):
        if line.startswith("PANEL_ADMIN_SECRET="):
            pw = line.split("=", 1)[1]
    if not pw:
        return ""
    data = json.dumps({"username": "admin", "password": pw}).encode()
    r = urllib.request.Request(f"{PANEL}/api/auth/login", data=data, method="POST",
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            cookie = resp.headers.get("Set-Cookie", "")
            return cookie.split(";")[0] if cookie else ""
    except urllib.error.HTTPError:
        return ""


def main() -> int:
    print(f"headscale: {HS}")
    print(f"面板:      {PANEL}")

    # ---------- 用户 ----------
    st, res = hs("GET", "/api/v1/user")
    existing = {u["name"] for u in (res.get("users") or [])} if isinstance(res, dict) else set()
    print(f"\n=== 用户（已有 {len(existing)} 个）===")
    for name in USERS:
        if name in existing:
            print(f"  = {name}（已存在）")
            continue
        st, res = hs("POST", "/api/v1/user", {"name": name})
        print(f"  {'+' if st == 200 else '✗'} {name} → HTTP {st}")

    # ---------- 设备 ----------
    st, res = hs("GET", "/api/v1/node")
    nodes = (res.get("nodes") or []) if isinstance(res, dict) else []
    have = {n["name"] for n in nodes}
    print(f"\n=== 设备（已有 {len(nodes)} 台）===")
    for user, name in NODES:
        if name in have:
            print(f"  = {name}（已存在）")
            continue
        auth_id = "hskey-authreq-" + "".join(secrets.choice(ALPHABET) for _ in range(24))
        st1, _ = hs("POST", "/api/v1/debug/node",
                    {"user": user, "key": auth_id, "name": name, "routes": []})
        if st1 != 200:
            print(f"  ✗ {name} debug/node HTTP {st1}")
            continue
        st2, r2 = hs("POST", "/api/v1/auth/register", {"user": user, "authId": auth_id})
        n = (r2 or {}).get("node", {}) if isinstance(r2, dict) else {}
        print(f"  {'+' if st2 == 200 else '✗'} {name}（{user}）→ id={n.get('id')} ip={n.get('ipAddresses')}")

    # ---------- 路由夹具 ----------
    if "--routes" in sys.argv:
        st, res = hs("GET", "/api/v1/node")
        nodes = (res.get("nodes") or []) if isinstance(res, dict) else []
        target = next((n for n in nodes if n["name"] == "lab-gamma"), None)
        cookie = panel_login()
        if target and cookie:
            body = json.dumps({"routes": ["172.16.5.0/24"], "confirmUnadvertised": True}).encode()
            r = urllib.request.Request(
                f"{PANEL}/api/routes/node/{target['id']}", data=body, method="PUT",
                headers={"Content-Type": "application/json", "Cookie": cookie},
            )
            # 写操作要 CSRF
            jar = cookie
            print(f"\n=== 路由夹具 ===")
            print(f"  （需要 CSRF，改用 headscale 直连批准更稳）")
            st2, _ = hs("POST", f"/api/v1/node/{target['id']}/approve_routes",
                        {"routes": ["172.16.5.0/24"]})
            print(f"  {'+' if st2 == 200 else '✗'} 为 lab-gamma 批准 172.16.5.0/24 → HTTP {st2}")
        else:
            print("\n=== 路由夹具 ===\n  ✗ 找不到 lab-gamma 或无法登录面板")

    # ---------- 汇总 ----------
    st, res = hs("GET", "/api/v1/node")
    nodes = (res.get("nodes") or []) if isinstance(res, dict) else []
    print(f"\n=== 最终状态：{len(nodes)} 台设备 ===")
    for n in nodes:
        u = n.get("user") or {}
        print(f"  id={n['id']:<3} {n['name']:<14} user={u.get('name', '—'):<12} "
              f"ip={n.get('ipAddresses')} approved={n.get('approvedRoutes') or []}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
