#!/usr/bin/env node
/**
 * 树状拓扑 UI 真机验证（Playwright + 真实 headscale v0.29.7）
 *
 * 前置：面板跑在 127.0.0.1:3900，上游有 3 台真实在线的 WireGuard 节点。
 */
import { chromium } from 'playwright';

const BASE = process.env.PANEL_URL ?? 'http://127.0.0.1:3900';
const USER = process.env.PANEL_ADMIN_USER ?? 'admin';
const PASS = process.env.PANEL_ADMIN_SECRET ?? 'DevAdmin-Pass-2026!';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `   → ${detail}` : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1050 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

// ---------- 登录 ----------
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[placeholder*="用户名"], input#username, input[type="text"]', USER);
await page.fill('input[type="password"]', PASS);
await page.keyboard.press('Enter');
await page.waitForURL(/\/dashboard/, { timeout: 20000 });
check('登录成功并进入控制台', true);

// ---------- 进入拓扑页 ----------
await page.goto(`${BASE}/topology`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

check('React Flow 画布挂载', (await page.locator('.react-flow').count()) > 0);
check('VPC 根节点存在（第一层）', (await page.locator('[data-testid="topo-vpc"]').count()) === 1);
const devCount = await page.locator('[data-testid^="topo-node-"]').count();
check('设备节点渲染数 = 3（第二层）', devCount === 3, `渲染 ${devCount}`);

// 树状结构：所有边都从 vpc 出发，设备之间没有连线
const edgeCount = await page.locator('.react-flow__edge').count();
check('边数 = 设备数（根→设备，无设备间连线）', edgeCount === 3, `DOM ${edgeCount} 条`);
const edgeSources = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.react-flow__edge')).map((e) => e.getAttribute('data-testid') || e.id),
);
check('所有连线都是 vpc→device 形式', edgeSources.every((id) => /vpc/i.test(id)), edgeSources.slice(0, 3).join(', '));

// ---------- 绿色状态（全通规则） ----------
const statuses = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid^="topo-node-"]')).map((n) => ({
    id: n.getAttribute('data-testid'),
    status: n.getAttribute('data-status'),
  })),
);
check('全通规则下全部设备为 ok（绿）', statuses.every((s) => s.status === 'ok'), JSON.stringify(statuses));
await page.screenshot({ path: '/tmp/swit/topo-green.png' });

// ---------- 橙色状态：应用限制性策略 ----------
const csrf = await page.evaluate(async () => {
  const r = await fetch('/api/auth/session', { credentials: 'same-origin' });
  return (await r.json()).csrfToken;
});
const restricted = JSON.stringify({
  acls: [{ action: 'accept', src: ['labadmin@'], dst: ['devops@:*'] }],
});
const putRes = await page.evaluate(
  async ({ csrf, content }) => {
    const r = await fetch('/api/acl/policy', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify({ content, comment: 'ui: 限制性', source: 'manual', acknowledgedImpact: true }),
    });
    return { status: r.status, body: await r.json() };
  },
  { csrf, content: restricted },
);
check('通过 UI 会话写入限制性策略', putRes.status === 200, `HTTP ${putRes.status}`);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const statuses2 = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid^="topo-node-"]')).map((n) => ({
    id: n.getAttribute('data-testid'),
    status: n.getAttribute('data-status'),
  })),
);
check('限制性策略下在线设备变橙(partial)', statuses2.every((s) => s.status === 'partial'), JSON.stringify(statuses2));

// 悬停橙色设备 → 应出现「不可互通」详情卡片
const firstNode = page.locator('[data-testid^="topo-node-"]').first();
await firstNode.hover();
await page.waitForTimeout(600);
const detailVisible = (await page.locator('text=无法与下列在线设备互通').count()) > 0;
check('悬停橙色设备出现「无法互通」详情', detailVisible);
await page.screenshot({ path: '/tmp/swit/topo-orange-hover.png' });

// ---------- 图例与语义说明 ----------
const body = await page.locator('body').innerText();
check('图例区分绿/橙/灰三态', body.includes('与全部在线设备互通') && body.includes('存在无法互通的在线设备') && body.includes('离线（不参与判定）'));
check('说明连线含义（接入同一张虚拟网络，非专属链路）', body.includes('接入这张虚拟网络') || body.includes('所有设备都接入同一个 VPC'));
check('明确否认「有数据流量经过」', body.includes('不代表有数据流量经过'));
check('标注策略来源', body.includes('策略来源'));
check('无前端运行时错误', errors.filter((e) => !e.includes('favicon')).length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(70));
console.log(`结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) failed.forEach((f) => console.log(`  ✗ ${f.label}  ${f.detail}`));
process.exit(failed.length ? 1 : 0);
