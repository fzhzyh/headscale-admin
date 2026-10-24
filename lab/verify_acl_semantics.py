#!/usr/bin/env python3
"""交叉验证：面板的策略模式判定 vs 真实 headscale 编译结果。

这是求值引擎最硬的证据 —— 不是自证，而是拿 headscale 自己的
/debug/filter 输出（编译后的 tailcfg.FilterRule）来对拍：

    策略 {}          → filter = [SrcIPs:["*"], 0-65535]  → 面板应判 allow-all
    策略 {acls:[]}   → filter = null                     → 面板应判 deny-all
    策略 {hosts:{}}  → filter = [SrcIPs:["*"], 0-65535]  → 面板应判 allow-all
    策略 {acls:[..]} → filter = [具体规则]                → 面板应判 rules

需要：联调 headscale 实例（HS_URL）+ 可访问的 debug 端口（HS_DEBUG_URL）。
"""
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error

# 本地联调：强制直连，避免 macOS 系统代理把 127.0.0.1 的请求送去代理
# （曾导致「同一 Key 时而 200 时而 401」的间歇性假故障，详见 _local_net.py）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _local_net import bypass_proxy_for_local, load_hs_key  # noqa: E402

bypass_proxy_for_local()

HS = os.environ.get("HS_URL", "http://127.0.0.1:18080")
DBG = os.environ.get("HS_DEBUG_URL", "http://127.0.0.1:19090")
KEY = load_hs_key()
SERVER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")

if not KEY:
    print("需要 HS_API_KEY")
    sys.exit(1)

PASSED, FAILED = [], []


def check(label, ok, detail=""):
    (PASSED if ok else FAILED).append(label)
    print(f"  {'✓' if ok else '✗'} {label}" + (f"   → {detail}" if detail else ""))


def set_policy(policy_obj):
    body = json.dumps({"policy": json.dumps(policy_obj)}).encode()
    req = urllib.request.Request(
        f"{HS}/api/v1/policy", data=body, method="PUT",
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status


def get_filter():
    try:
        with urllib.request.urlopen(f"{DBG}/debug/filter", timeout=10) as r:
            return r.read().decode()
    except Exception as e:
        return f"__ERR__ {e}"


def panel_mode(policy_obj):
    """调用面板的求值引擎判定策略模式。

    用独立 .mjs 探针 + stdin 传参：node -e 的 argv 与 --input-type 组合
    在不同 Node 版本下行为不一致，写入临时文件最稳。
    """
    probe = os.path.join(tempfile.gettempdir(), "acl_mode_probe.mjs")
    with open(probe, "w") as f:
        f.write(
            "import { interpretPolicy } from " + json.dumps(os.path.join(SERVER_DIR, "src/acl/model.ts")) + ";\n"
            "let raw='';process.stdin.setEncoding('utf8');\n"
            "process.stdin.on('data',c=>{raw+=c});\n"
            "process.stdin.on('end',()=>{console.log(interpretPolicy(JSON.parse(raw)).mode)});\n"
        )
    r = subprocess.run(
        ["node", "--import", "tsx", probe],
        cwd=SERVER_DIR, input=json.dumps(policy_obj), capture_output=True, text=True, timeout=120,
    )
    out = r.stdout.strip()
    return out if out else f"__ERR__ {r.stderr.strip()[:200]}"


CASES = [
    ("{}  —— 无 acls/grants 键", {}, "allow-all"),
    ('{"acls":[]} —— 空规则列表', {"acls": []}, "deny-all"),
    ('{"hosts":{...}} —— 只有 hosts', {"hosts": {"h1": "100.64.0.9"}}, "allow-all"),
    ('{"tagOwners":{...}} —— 只有 tagOwners', {"tagOwners": {"tag:x": ["labadmin@"]}}, "allow-all"),
    ('{"grants":[]} —— 空 grants', {"grants": []}, "deny-all"),
    (
        '{"acls":[accept *]} —— 一条规则',
        {"acls": [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}]},
        "rules",
    ),
]

print("=" * 88)
print("交叉验证：面板判定 vs headscale 编译结果")
print("=" * 88)
print(f"headscale: {HS}")
print(f"debug    : {DBG}")
print()

for label, policy, expect_mode in CASES:
    print(f"### {label}")
    st = set_policy(policy)
    raw = get_filter()
    if raw.startswith("__ERR__"):
        check(f"{label} 取 filter", False, raw)
        continue

    try:
        filt = json.loads(raw)
    except Exception:
        check(f"{label} 解析 filter", False, raw[:120])
        continue

    # headscale 的两种编译结果
    is_allow_all = (
        isinstance(filt, list)
        and len(filt) == 1
        and filt[0].get("SrcIPs") == ["*"]
        and len(filt[0].get("DstPorts", [])) == 1
        and filt[0]["DstPorts"][0].get("IP") == "*"
    )
    is_deny_all = filt is None

    hs_mode = "allow-all" if is_allow_all else ("deny-all" if is_deny_all else "rules")

    mode = panel_mode(policy)
    print(f"      headscale filter: {'null（全禁）' if is_deny_all else ('[*]（全通）' if is_allow_all else '具体规则')}")
    print(f"      headscale 判定: {hs_mode}   面板判定: {mode}")

    check(f"面板判定与 headscale 一致（期望 {expect_mode}）", mode == expect_mode and hs_mode == expect_mode,
          f"panel={mode} hs={hs_mode}")

# 还原联调实例
print()
set_policy({"acls": [{"action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"]}]})
print("已还原联调实例策略")

print()
print("=" * 88)
print(f"结果：{len(PASSED)} 通过 / {len(FAILED)} 失败")
if FAILED:
    print("失败项：")
    for f in FAILED:
        print(f"  ✗ {f}")
print("=" * 88)
sys.exit(1 if FAILED else 0)
