#!/usr/bin/env python3
"""
全量回归运行器（串行、结果强校验）

为什么需要它 —— 一个真实的编排缺陷：
─────────────────────────────────────────────────────────────
早期用 shell 一行跑全部套件：

    for t in "python3 lab/e2e_panel.py" ...; do
      printf "%-28s " "$(basename)"; $t 2>&1 | grep -E "^结果：" | head -1
    done

这个写法有个致命问题：**套件没输出「结果：」行时，grep 什么都不打印，
而整条命令的退出码仍是 0** —— 于是「三个套件连结果都没打出来」
在日志里看起来和「一切正常」没有区别。实测踩到过：三个 Python 套件
一行结果都没有，编排却显示成功。

本脚本把「必须有结果行」当成硬性断言：
  · 缺结果行 → 判为 FAIL（不是 skip、不是静默通过）
  · 逐套件捕获 stdout+stderr 到文件，失败时打印尾部
  · 解析出「N 通过 / M 失败」，统计总数
  · 任一失败或缺失 → 退出码 1

另外两条设计取舍：
1. **串行执行**。并行会让多个套件同时动同一套夹具（设备/策略/标签），
   互相污染。宁可慢，也要结果可信。
2. **不重试**。失败就是失败，靠重试掩盖的 flaky 在 CI 里会以更贵的
   形式复发。要治的是根因（见 docs/dev-gotchas.md）。
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server"
LAB = ROOT / "lab"
LOG_DIR = Path(os.environ.get("REGRESSION_LOG_DIR", "/tmp/regression"))

ResultLine = re.compile(r"结果：\s*(\d+)\s*通过\s*/\s*(\d+)\s*失败")


@dataclass
class Suite:
    name: str
    kind: str  # "python" | "node" | "tsx"
    path: str
    # 套件允许整体 SKIP（打印「⊘ SKIP」并 exit 0），此时不要求结果行
    allow_skip: bool = False
    cwd: Path = ROOT
    outcome: str = "未运行"
    passed: int = 0
    failed: int = 0
    skipped: int = 0
    detail: str = ""
    logfile: Path | None = field(default=None)


def suites() -> list[Suite]:
    return [
        # —— 单元测试：不依赖运行中的服务 ——
        Suite("认证原语单元", "tsx", "src/auth/secrets.test.ts", cwd=SERVER),
        Suite("ACL 求值引擎单元", "tsx", "src/acl/evaluator.test.ts", cwd=SERVER),
        Suite("时序层单元", "tsx", "src/timeseries/influx.test.ts", cwd=SERVER),
        Suite("控制面指标单元", "tsx", "src/services/metrics.test.ts", cwd=SERVER),
        # —— 端到端：依赖容器化环境 ——
        Suite("P1 面板后端 e2e", "python", "e2e_panel.py"),
        Suite("P1 2FA e2e", "python", "e2e_2fa.py"),
        Suite("P2 WebSocket", "python", "verify_ws.py"),
        Suite("ACL 后端 e2e", "python", "e2e_acl.py"),
        # 上游交叉验证依赖 /debug/filter（仅本机回环），容器模式下整体 SKIP
        Suite("上游语义交叉验证", "python", "verify_acl_semantics.py", allow_skip=True),
        # —— 前端 DOM 断言 ——
        Suite("P2 前端", "node", "verify_web.mjs"),
        Suite("P4 统计前端", "node", "verify_stats_ui.mjs"),
        Suite("P4 拓扑前端", "node", "verify_topology_ui.mjs"),
        Suite("P5 资源中心后端", "python", "verify_resources.py"),
        Suite("P3 ACL 前端", "node", "verify_acl_ui.mjs"),
    ]


def run_suite(s: Suite) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logfile = LOG_DIR / f"{s.name.replace(' ', '_').replace('/', '_')}.log"
    s.logfile = logfile

    if s.kind == "python":
        cmd = ["python3", str(LAB / s.path)]
        cwd = ROOT
    elif s.kind == "node":
        cmd = ["node", str(LAB / s.path)]
        cwd = ROOT
    else:  # tsx
        cmd = ["npx", "tsx", s.path]
        cwd = s.cwd

    started = time.time()
    env = dict(os.environ)
    # 清掉外部注入的地址/密钥，让脚本自证「能自己取到」
    for k in ("HS_API_KEY", "PANEL_ADMIN_SECRET", "PANEL_URL", "HS_URL", "HS_DEBUG_URL", "INFLUX_URL"):
        env.pop(k, None)

    try:
        cp = subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=600,
            env=env,
        )
        out = (cp.stdout or "") + (cp.stderr or "")
        code = cp.returncode
    except subprocess.TimeoutExpired as e:
        out = f"超时（600s）\n{(e.stdout or '') if isinstance(e.stdout, str) else ''}"
        code = -1
    elapsed = time.time() - started

    logfile.write_text(out, encoding="utf-8")

    m = ResultLine.search(out)
    if m:
        s.passed = int(m.group(1))
        s.failed = int(m.group(2))
        s.skipped = out.count("⊘ SKIP")
        if s.failed > 0 or code != 0:
            s.outcome = f"失败（{s.failed} 项）"
        else:
            s.outcome = "通过"
    elif s.allow_skip and ("⊘ SKIP" in out or "SKIP" in out.upper()):
        s.skipped = max(1, out.count("⊘ SKIP"))
        s.outcome = f"SKIP（{s.skipped} 项）"
    else:
        # ⚠️ 关键断言：没有结果行 = 失败。
        # 这正是旧 shell 编排漏掉的情形——进程退出 0 但根本没跑到底。
        s.outcome = "无结果行（判为失败）"
        s.failed = -1

    s.detail = f"{elapsed:.1f}s"


def main() -> int:
    print("=" * 78)
    print("全量回归（串行，结果行强校验）")
    print("=" * 78)

    if LOG_DIR.exists():
        for old in LOG_DIR.glob("*.log"):
            old.unlink(missing_ok=True)

    all_suites = suites()
    for i, s in enumerate(all_suites, 1):
        print(f"\n[{i}/{len(all_suites)}] {s.name} …", flush=True)
        run_suite(s)
        icon = {"通过": "✓"}.get(s.outcome, "✗" if "失败" in s.outcome else "⊘")
        extra = f"{s.passed} 通过 / {s.failed} 失败" if s.failed >= 0 else "无结果行"
        print(f"  {icon} {s.outcome:26s} {extra:20s} {s.detail}", flush=True)

    # ---------------- 汇总 ----------------
    total_pass = sum(s.passed for s in all_suites if s.passed > 0)
    total_fail = sum(s.failed for s in all_suites if s.failed > 0)
    broken = [s for s in all_suites if s.failed < 0]
    failed = [s for s in all_suites if s.failed > 0]
    skipped = sum(s.skipped for s in all_suites)

    print("\n" + "=" * 78)
    print(f"{'套件':<24} {'结果':<12} {'通过':>5} {'失败':>5}  备注")
    print("-" * 78)
    for s in all_suites:
        p = s.passed if s.passed > 0 else 0
        f = s.failed if s.failed > 0 else 0
        note = s.detail
        if s.failed < 0:
            note = f"见 {s.logfile}"
        elif s.skipped:
            note = f"{s.detail}，{s.skipped} 项 SKIP"
        print(f"{s.name:<24} {s.outcome:<12} {p:>5} {f:>5}  {note}")
    print("-" * 78)
    print(f"合计：{total_pass} 通过 / {total_fail} 失败 / {skipped} SKIP")

    if broken:
        print(f"\n✗ {len(broken)} 个套件未产出结果行（按失败处理）：")
        for s in broken:
            print(f"  - {s.name} → {s.logfile}")
            tail = s.logfile.read_text(encoding="utf-8").strip().splitlines()[-6:] if s.logfile else []
            for line in tail:
                print(f"      {line[:150]}")
    if failed:
        print(f"\n✗ {len(failed)} 个套件存在失败项：")
        for s in failed:
            print(f"  - {s.name}（{s.failed} 项）→ {s.logfile}")

    ok = not failed and not broken
    print("\n" + ("✓ 全绿" if ok else "✗ 有失败"))
    print("=" * 78)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
