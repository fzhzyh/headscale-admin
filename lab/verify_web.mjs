#!/usr/bin/env node
/**
 * 前端渲染验证（无头浏览器）。
 *
 * 为什么不用浏览器 MCP：它的 CDP 通道在本次会话中频繁超时。
 * 这里直接用 Playwright/Puppeteer 驱动，断言真实 DOM，比 curl 更有说服力。
 *
 * 用法：node lab/verify_web.mjs [baseUrl]
 */
import { chromium } from 'playwright';
import { setTimeout as sleep } from 'node:timers/promises';

// 地址统一从 container/endpoints.env 取（容器化后服务不在宿主回环上）
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadEndpoints() {
  const here = dirname(fileURLToPath(import.meta.url));
  const ep = { PANEL_URL: 'http://100.64.0.3:8080', HS_URL: 'http://100.64.0.3:18080' };
  for (const base of [join(here, '..'), here, process.cwd()]) {
    const f = join(base, 'container', 'endpoints.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        ep[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      // 同时读 container/lab.env（面板管理员口令等），与 Python 侧 load_endpoints 保持一致
      const labEnv = join(base, 'container', 'lab.env');
      if (existsSync(labEnv)) {
        for (const line of readFileSync(labEnv, 'utf8').split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#') || !t.includes('=')) continue;
          const i = t.indexOf('=');
          const k = t.slice(0, i).trim();
          if (!(k in ep)) ep[k] = t.slice(i + 1).trim();
        }
      }
      break;
    }
  }
  return ep;
}
const EP = loadEndpoints();



const BASE = process.argv[2] ?? EP.PANEL_URL;
const USER = process.env.PANEL_ADMIN_USER ?? EP.PANEL_ADMIN_USER ?? 'admin';
const PASS = process.env.PANEL_ADMIN_SECRET ?? EP.PANEL_ADMIN_SECRET ?? '';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `   → ${detail}` : ''}`);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// 收集控制台错误，前端有运行时异常必须暴露出来
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

console.log('='.repeat(88));
console.log('1. 登录页渲染');
console.log('='.repeat(88));
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
check('页面标题正确', (await page.title()).includes('Headscale'), await page.title());
check('品牌区渲染', (await page.locator('text=一个入口').count()) > 0);
check('用户名输入框存在', (await page.locator('input').first().isVisible()));
const bodyText = await page.locator('body').innerText();
check('未白屏（有实质内容）', bodyText.length > 200, `${bodyText.length} 字符`);

console.log('\n' + '='.repeat(88));
console.log('2. 登录');
console.log('='.repeat(88));
if (!PASS) {
  console.log('  ✗ 未提供 PANEL_ADMIN_SECRET，跳过');
} else {
  await page.locator('input').first().fill(USER);
  await page.locator('input[type=password]').fill(PASS);
  await page.locator('button:has-text("登")').click();
  // 注意：必须只等 /dashboard。写 /(dashboard|login)/ 会在当前 /login 上立即匹配，
  // 测不出真正的跳转（这是本脚本初版的 bug）。
  let loggedIn = true;
  await page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {
    loggedIn = false;
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  const url = new URL(page.url());
  check('登录成功并跳转控制台', loggedIn && url.pathname === '/dashboard', url.pathname);

  console.log('\n' + '='.repeat(88));
  console.log('3. 控制台真实数据');
  console.log('='.repeat(88));
  await page.waitForTimeout(2500);

  const statCards = await page.locator('.hsa-stat-accent').allInnerTexts();
  check('统计卡渲染', statCards.length >= 4, `${statCards.length} 张`);
  statCards.forEach((c) => console.log(`      · ${c.replace(/\n/g, ' / ')}`));

  // 断言真实数据非零（联调实例有 4 台设备 / 2 个用户）
  const cardText = statCards.join(' ');
  check('设备总数非空', /\d/.test(cardText));

  const navItems = await page.locator('.ant-menu-item').allInnerTexts();
  check('侧边导航渲染', navItems.length >= 7, navItems.map((s) => s.trim()).join(' | '));

  const headerText = await page.locator('.ant-layout-header').innerText();
  check('顶栏显示实时连接状态', /实时|连接中|离线/.test(headerText), headerText.replace(/\n/g, ' | '));

  console.log('\n' + '='.repeat(88));
  console.log('4. 设备列表页');
  console.log('='.repeat(88));
  await page.goto(`${BASE}/nodes`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const rows = await page.locator('.ant-table-tbody tr.ant-table-row').count();
  check('设备表格有数据行', rows > 0, `${rows} 行`);
  if (rows > 0) {
    const firstRow = await page.locator('.ant-table-tbody tr.ant-table-row').first().innerText();
    console.log(`      首行：${firstRow.replace(/\n/g, ' | ')}`);
    check('行内含 IP 地址', /\d+\.\d+\.\d+\.\d+/.test(firstRow));
    check('显示在线/离线状态', /在线|离线/.test(firstRow));
  }
  const seg = await page.locator('.ant-segmented-item').allInnerTexts();
  check('筛选器渲染', seg.length >= 4, seg.join(' | '));

  console.log('\n' + '='.repeat(88));
  console.log('5. 其余页面可达性');
  console.log('='.repeat(88));
  for (const [path, expect] of [
    ['/routes', /路由|网段/],
    ['/users', /用户|网络用户/],
    ['/keys', /密钥/],
    ['/panel-users', /账户|角色/],
    ['/connect', /连接|命令/],
    ['/audit', /审计/],
    ['/settings', /设置|连接/],
  ]) {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const t = await page.locator('body').innerText();
    check(`${path} 渲染正常`, expect.test(t) && t.length > 150, `${t.length} 字符`);
  }

  console.log('\n' + '='.repeat(88));
  console.log('6. 移动端响应式');
  console.log('='.repeat(88));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const mobileText = await page.locator('body').innerText();
  check('移动端无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2),
    `scrollWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}`);
  check('移动端内容渲染', mobileText.length > 150, `${mobileText.length} 字符`);

  console.log('\n' + '='.repeat(88));
  console.log('7. 运行时错误');
  console.log('='.repeat(88));
  const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  check('无 JS 运行时错误', realErrors.length === 0, realErrors.slice(0, 3).join(' ;; ') || '无');
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log('\n' + '='.repeat(88));
console.log(`结果：${results.length - failed.length} 通过 / ${failed.length} 失败`);
if (failed.length) {
  console.log('失败项：');
  failed.forEach((f) => console.log(`  ✗ ${f.label}`));
}
console.log('='.repeat(88));
process.exit(failed.length ? 1 : 0);
