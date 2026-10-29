/**
 * 截取面板 UI 截图（用于 README 展示）
 *
 * ## 为什么用 API 拿 Cookie 而不是走登录页
 * 登录页有 2FA 分支与限流，脚本化登录容易受干扰；直接用 /api/auth/login
 * 拿会话 Cookie 注入浏览器，稳定且快。登录页本身单独截一张（需要未登录态）。
 *
 * ## 为什么要等图表渲染
 * Recharts 是客户端渲染，`networkidle` 时 SVG 还可能没画完。
 * 统一等待 `.recharts-surface` 或超时兜底，避免截到空白图区。
 *
 * 用法：node lab/shot.mjs [输出目录]
 */

import { chromium } from 'playwright';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = process.argv[2] || join(ROOT, 'docs', 'images');
mkdirSync(OUT, { recursive: true });

// ---------- 读端点与口令 ----------
function readEnvFile(p) {
  if (!existsSync(p)) return {};
  const o = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    o[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return o;
}
const ep = { ...readEnvFile(join(ROOT, 'container', 'endpoints.env')),
             ...readEnvFile(join(ROOT, 'container', 'lab.env')) };
const BASE = ep.PANEL_URL;
const USER = ep.PANEL_ADMIN_USER || 'admin';
const PASS = ep.PANEL_ADMIN_SECRET;
if (!BASE || !PASS) {
  console.error('缺少 PANEL_URL 或 PANEL_ADMIN_SECRET（检查 container/endpoints.env 与 lab.env）');
  process.exit(2);
}
console.log(`  目标 ${BASE}  用户 ${USER}`);

// ---------- 登录拿 Cookie ----------
const loginRes = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
if (!loginRes.ok) {
  console.error(`  登录失败 HTTP ${loginRes.status}: ${(await loginRes.text()).slice(0, 200)}`);
  process.exit(1);
}
const setCookie = loginRes.headers.getSetCookie?.() ?? [];
const cookies = setCookie.map((c) => {
  const [pair] = c.split(';');
  const i = pair.indexOf('=');
  return { name: pair.slice(0, i), value: pair.slice(i + 1), domain: new URL(BASE).hostname, path: '/' };
});
console.log(`  ✓ 登录成功，注入 ${cookies.length} 个 Cookie`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,               // 高清（Retina），README 里不虚
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
  colorScheme: 'light',
});
await ctx.addCookies(cookies);
const page = await ctx.newPage();

// 屏蔽噪声：不让页面报错打断截图
page.on('pageerror', () => {});

async function shot(name, path, { waitChart = false, fullPage = false, settle = 1200 } = {}) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 等 SPA 挂载 + 数据请求回来
  await page.waitForTimeout(settle);
  if (waitChart) {
    try {
      await page.waitForSelector('.recharts-surface', { timeout: 12000 });
      await page.waitForTimeout(900);   // 让动画走完
    } catch { /* 没有图表就跳过 */ }
  }
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  const size = (await import('node:fs')).statSync(file).size;
  console.log(`  ✓ ${name}.png  ${(size / 1024).toFixed(0)} KB${fullPage ? '（整页）' : ''}`);
}

// ---------- 逐页截图 ----------
const want = process.env.SHOTS ? process.env.SHOTS.split(',') : null;
const pages = [
  ['dashboard',  '/dashboard',  { waitChart: true, settle: 2500 }],
  ['nodes',      '/nodes',      { settle: 1800 }],
  ['acl',        '/acl',        { settle: 2000 }],
  ['topology',   '/topology',   { settle: 3000 }],
  ['resources',  '/resources',  { settle: 1800 }],
  ['dns',        '/dns',        { settle: 1800 }],
  ['oidc',       '/oidc',       { settle: 1800 }],
  ['settings',   '/settings',   { settle: 1800 }],
  ['connect',    '/connect',    { settle: 1500 }],
];

for (const [name, path, opt] of pages) {
  if (want && !want.includes(name)) continue;
  try {
    await shot(name, path, opt);
  } catch (e) {
    console.log(`  ✗ ${name}: ${String(e.message).slice(0, 120)}`);
  }
}

// ---------- 登录页（需未登录态，单独一个 context）----------
if (!want || want.includes('login')) {
  const anon = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: 'light',
  });
  const p2 = await anon.newPage();
  await p2.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1500);
  const f = join(OUT, 'login.png');
  await p2.screenshot({ path: f });
  const { statSync } = await import('node:fs');
  console.log(`  ✓ login.png  ${(statSync(f).size / 1024).toFixed(0)} KB`);
  await anon.close();
}

await browser.close();
console.log(`\n输出目录：${OUT}`);
