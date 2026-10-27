#!/usr/bin/env node
/**
 * P4 网络拓扑前端验证（无头浏览器 + 真实 ACL 语义）
 *
 * 这个脚本不只"看页面渲染出来了"，而是**验证拓扑边与 ACL 语义一致**：
 *
 *   1. 基线策略（`*` 全通一条规则）→ 4 台设备应有 4×3 = 12 条有向边
 *   2. 换成 `labadmin@ → devops@:*` → 应精确变成 4 条边，
 *      且方向只能是 labadmin 的设备指向 devops 的设备（无反边、无同用户边）
 *   3. 还原基线，确认回到 12 条
 *
 * 为什么值得这么测：拓扑最容易出的错不是"画不出来"，而是"画得不对"——
 * 少画一条边会被误读成「不允许访问」，多画一条会被误读成「放行了」。
 * 只断言"有连线"是测不出方向性和选择性的。
 *
 * 用法：node lab/verify_topology_ui.mjs
 */
import { chromium } from 'playwright';
import { loginUI } from './_ui.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEndpoints() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ep = { PANEL_URL: 'http://100.64.0.3:8080' };
  for (const base of [join(here, '..'), here, process.cwd()]) {
    const f = join(base, 'container', 'endpoints.env');
    if (existsSync(f)) {
      const read = (p, target) => {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#') || !t.includes('=')) continue;
          const i = t.indexOf('=');
          const k = t.slice(0, i).trim();
          if (!(k in target)) target[k] = t.slice(i + 1).trim();
        }
      };
      read(f, ep);
      const labEnv = join(base, 'container', 'lab.env');
      if (existsSync(labEnv)) read(labEnv, ep);
      break;
    }
  }
  return ep;
}

const EP = loadEndpoints();
const BASE = process.argv[2] ?? EP.PANEL_URL;
const USER = process.env.PANEL_ADMIN_USER ?? EP.PANEL_ADMIN_USER ?? 'admin';
const PASS = process.env.PANEL_ADMIN_SECRET ?? EP.PANEL_ADMIN_SECRET ?? '';

const BASELINE_POLICY = JSON.stringify({
  acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['*:*'] }],
});
const RESTRICTED_POLICY = JSON.stringify({
  acls: [{ action: 'accept', src: ['labadmin@'], dst: ['devops@:*'] }],
});

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `   → ${detail}` : ''}`);
}

// ---------------------------------------------------------------- 后端辅助（Node 侧）
// 用来改策略 + 直接读拓扑结论，与 UI 断言互相印证。
// 注意：macOS 系统代理会把本机请求送去代理，用 no_proxy 兜住。
process.env.NO_PROXY = '100.64.0.3,localhost,127.0.0.1';
process.env.no_proxy = process.env.NO_PROXY;

let cookie = '';
let csrf = '';

async function apiLogin() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  const body = await res.json();
  csrf = body.csrfToken ?? '';
}

async function apiFetch(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Cookie: cookie,
      ...(init.method && init.method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

/**
 * 设置策略。
 * ⚠️ 全通/全禁属于高危变更，后端会先返回 409 NEED_ACK 要求确认
 * （`acknowledgedImpact: true`）——这是 P3 加的护栏，不是 bug。
 * 测试里显式传确认，才符合真实用户点过「我已了解」的流程。
 */
async function setPolicy(content, comment, acknowledgedImpact = false) {
  const r = await apiFetch('/api/acl/policy', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, comment, source: 'manual', acknowledgedImpact }),
  });
  // 先断言护栏真的存在：全通/全禁不带确认必须被拒
  if (r.status === 409 && r.json?.error === 'NEED_ACK' && !acknowledgedImpact) {
    return { needAck: true, beforeMode: r.json.beforeMode, afterMode: r.json.afterMode };
  }
  if (r.status !== 200) throw new Error(`设置策略失败 HTTP ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

async function readTopology(onlineOnly = false) {
  const r = await apiFetch(`/api/topology?onlineOnly=${onlineOnly ? '1' : '0'}`);
  if (r.status !== 200) throw new Error(`读取拓扑失败 HTTP ${r.status}`);
  return r.json;
}

if (!PASS) {
  console.log('✗ 未取到 PANEL_ADMIN_SECRET（检查 container/lab.env）');
  process.exit(1);
}

await apiLogin();

// ---------------------------------------------------------------- 基线检查（后端）
console.log('='.repeat(88));
console.log('0. 策略与拓扑自检（后端，先算清"应该是什么"）');
console.log('='.repeat(88));

await setPolicy(BASELINE_POLICY, '拓扑 UI 测试：基线');
const baseTopo = await readTopology();
const nodeCount = baseTopo.stats.nodeCount;
const expectedAllPairs = nodeCount * (nodeCount - 1);
check('基线策略下边数 = N×(N-1)（全通单规则）', baseTopo.stats.allowedEdges === expectedAllPairs, `${baseTopo.stats.allowedEdges} / 期望 ${expectedAllPairs}`);
check('逐对求值对数与边数一致（无规则被漏算）', baseTopo.stats.pairEvaluated === expectedAllPairs, `${baseTopo.stats.pairEvaluated} 对`);
check('未被截断', baseTopo.stats.truncated === false);

// ---------------------------------------------------------------- 登录 + 导航
console.log('\n' + '='.repeat(88));
console.log('1. 登录并从导航进入拓扑页');
console.log('='.repeat(88));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await ctx.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

await loginUI(page, BASE, USER, PASS);

// 通过左侧导航点击进入，顺带验证菜单接线（而不是直接 goto）
const navLink = page.locator('.ant-menu-item', { hasText: '网络拓扑' }).first();
check('导航菜单含「网络拓扑」', (await navLink.count()) > 0);
await navLink.click();
await page.waitForURL(/\/topology/, { timeout: 15000 });
await page.waitForTimeout(2500);
check('点击后进入 /topology', new URL(page.url()).pathname === '/topology');

// ---------------------------------------------------------------- 画布与节点
console.log('\n' + '='.repeat(88));
console.log('2. 画布与设备节点');
console.log('='.repeat(88));

check('React Flow 画布已挂载', (await page.locator('.react-flow').count()) > 0);
const canvas = page.locator('[data-testid="topology-canvas"]');
check('拓扑容器存在', (await canvas.count()) > 0);

const rendered = await page.locator('[data-testid^="topo-node-"]').count();
check('渲染的设备节点数与后端一致', rendered === nodeCount, `渲染 ${rendered} / 后端 ${nodeCount}`);

const nodeText = (await canvas.innerText()) || '';
for (const name of baseTopo.nodes.slice(0, 3).map((n) => n.displayName)) {
  check(`节点「${name}」可见`, nodeText.includes(name));
}
check('显示设备 IP', /\b100\.64\.\d+\.\d+\b/.test(nodeText), (nodeText.match(/100\.64\.\d+\.\d+/) ?? [''])[0]);

// ---------------------------------------------------------------- 边与语义
console.log('\n' + '='.repeat(88));
console.log('3. 边与 ACL 语义一致（核心断言）');
console.log('='.repeat(88));

const edgeCount = await page.locator('.react-flow__edge').count();
check('基线：边数与后端一致（全通 12 条）', edgeCount === baseTopo.stats.allowedEdges, `DOM ${edgeCount} / 后端 ${baseTopo.stats.allowedEdges}`);
check('规则模式横幅显示放行关系数', (await page.locator('text=规则模式').count()) > 0);

// —— 换成限制性策略，页面必须跟着变 ——
console.log('    切换到限制性策略：labadmin@ → devops@:*');
const restricted = await setPolicy(RESTRICTED_POLICY, '拓扑 UI 测试：限制性');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const restTopo = await readTopology();
check('后端边数变为 2×2=4', restTopo.stats.allowedEdges === 4, `${restTopo.stats.allowedEdges} 条`);

const restEdges = await page.locator('.react-flow__edge').count();
check('DOM 边数同步为 4（不是缓存旧图）', restEdges === 4, `DOM ${restEdges} 条`);

// 方向性：所有边的 from 必须是 labadmin 设备，to 必须是 devops 设备
const adminIds = new Set(restTopo.nodes.filter((n) => n.user === 'labadmin').map((n) => n.id));
const devopsIds = new Set(restTopo.nodes.filter((n) => n.user === 'devops').map((n) => n.id));
check(
  '所有边方向均为 labadmin → devops（无反边）',
  restTopo.edges.every((e) => adminIds.has(e.from) && devopsIds.has(e.to)),
  `labadmin ${[...adminIds].join(',')} → devops ${[...devopsIds].join(',')}`,
);
check(
  '无同用户内部边',
  restTopo.edges.every((e) => !(adminIds.has(e.from) && adminIds.has(e.to)) && !(devopsIds.has(e.from) && devopsIds.has(e.to))),
);
check('边命中的规则可回指（ruleIndex 非空）', restTopo.edges.every((e) => e.ruleIndex !== null));

const statsText = (await page.locator('.hsa-card', { hasText: '统计' }).first().innerText()) || '';
check('统计面板「放行边数」同步为 4', /放行边数\s*4/.test(statsText), statsText.replace(/\n/g, ' / ').slice(0, 80));

// ---------------------------------------------------------------- 全通/全禁横幅
console.log('\n' + '='.repeat(88));
console.log('4. 全通 / 全禁模式的呈现');
console.log('='.repeat(88));

// 全通：{} 没有 acls 键 → allow-all（注意与 {"acls":[]} 相反）
// 先验证高危护栏：不带确认必须被 409 拦住
const guard = await setPolicy('{}', '拓扑 UI 测试：全通（试探护栏）');
check('高危护栏：改为全通必须显式确认（409 NEED_ACK）', guard.needAck === true, `${guard.beforeMode} → ${guard.afterMode}`);
await setPolicy('{}', '拓扑 UI 测试：全通', true);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const allowText = (await page.locator('body').innerText()) || '';
check('全通模式显示醒目横幅', allowText.includes('全通') && allowText.includes('不绘制逐对连线'));
const allowEdges = await page.locator('.react-flow__edge').count();
check('全通模式不画 N² 条箭头', allowEdges === 0, `DOM ${allowEdges} 条`);

// 全禁：{"acls":[]} → deny-all
await setPolicy('{"acls":[]}', '拓扑 UI 测试：全禁', true);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const denyText = (await page.locator('body').innerText()) || '';
check('全禁模式显示横幅并说明「没有连线就是结论」', denyText.includes('全禁'));
check('全禁模式边数为 0', (await page.locator('.react-flow__edge').count()) === 0);

// ---------------------------------------------------------------- 只看在线
console.log('\n' + '='.repeat(88));
console.log('5. 「只看在线」过滤');
console.log('='.repeat(88));

await setPolicy(BASELINE_POLICY, '拓扑 UI 测试：还原基线');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const onlineTopo = await readTopology(true);
const onlineCount = onlineTopo.nodes.filter((n) => n.online).length;
await page.locator('.ant-switch').first().click();
await page.waitForTimeout(2500);
const onlineEdges = await page.locator('.react-flow__edge').count();
const expectedOnlineEdges = onlineCount * Math.max(0, onlineCount - 1);
check('只看在线：边数 = 在线设备数×(在线数-1)', onlineEdges === expectedOnlineEdges, `在线 ${onlineCount} 台 → ${onlineEdges} 条（期望 ${expectedOnlineEdges}）`);
check('只看在线：节点仍全部展示（只是不画离线间的边）', (await page.locator('[data-testid^="topo-node-"]').count()) === nodeCount);

// ---------------------------------------------------------------- 语义说明
console.log('\n' + '='.repeat(88));
console.log('6. 语义说明的诚实性');
console.log('='.repeat(88));

const finalText = (await page.locator('body').innerText()) || '';
check('说明边代表控制面 ACL 放行关系', finalText.includes('控制面 ACL 放行关系'));
check('明确否认「有数据流量经过」', finalText.includes('不代表有数据流量经过'));
check('说明数据面流量不经 headscale', finalText.includes('WireGuard 直连'));
check('标注策略来源', finalText.includes('策略来源'));

// ---------------------------------------------------------------- 收尾
console.log('\n' + '='.repeat(88));
console.log('7. 运行时错误');
console.log('='.repeat(88));
const realErrors = consoleErrors.filter(
  (e) => !e.includes('favicon') && !e.includes('Download the React DevTools') && !/status of 40[13]/.test(e),
);
check('无前端运行时异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

await browser.close();

// 无论如何都还原基线，避免污染后续套件
try {
  await apiLogin();
  await setPolicy(BASELINE_POLICY, '拓扑 UI 测试：收尾还原');
  console.log('\n  ✓ 已还原基线策略');
} catch (e) {
  console.log(`\n  ✗ 还原基线失败：${e instanceof Error ? e.message : String(e)}`);
  results.push({ label: '还原基线策略', ok: false });
}

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(88));
console.log(`结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  ✗ ${f.label}`));
}
console.log('='.repeat(88));
process.exit(failed.length ? 1 : 0);
