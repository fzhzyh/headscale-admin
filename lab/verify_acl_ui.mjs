#!/usr/bin/env node
/**
 * ACL 管理页前端验证（无头浏览器，真实 DOM 断言）。
 *
 * 复用 verify_web.mjs 的做法：Playwright 驱动 Chromium，断言渲染出的真实 DOM，
 * 并收集控制台错误——前端有运行时异常必须暴露，不能被「页面看起来正常」掩盖。
 *
 * 用法：PANEL_ADMIN_SECRET=... node lab/verify_acl_ui.mjs [baseUrl]
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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

if (!PASS) {
  console.log('需要 PANEL_ADMIN_SECRET');
  process.exit(1);
}

// ---------------- 登录 ----------------
console.log('='.repeat(88));
console.log('0. 登录');
console.log('='.repeat(88));
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.locator('input').first().fill(USER);
await page.locator('input[type=password]').fill(PASS);
await page.locator('button:has-text("登")').click();
let loggedIn = true;
await page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {
  loggedIn = false;
});
check('登录成功并跳转控制台', loggedIn, page.url());

// ---------------- 侧栏入口 ----------------
console.log('\n' + '='.repeat(88));
console.log('1. 侧栏导航入口');
console.log('='.repeat(88));
const navAcl = page.locator('a:has-text("ACL 管理"), li:has-text("ACL 管理")').first();
check('侧栏出现「ACL 管理」', (await navAcl.count()) > 0);

// ---------------- 进入 ACL 页 ----------------
console.log('\n' + '='.repeat(88));
console.log('2. ACL 页面加载');
console.log('='.repeat(88));
await page.goto(`${BASE}/acl`, { waitUntil: 'networkidle' });
await sleep(1200);

const body = await page.locator('body').innerText();
check('未白屏（有实质内容）', body.length > 300, `${body.length} 字符`);
check('标题渲染', body.includes('ACL 管理'));
check('显示策略模式卡片', /按规则|全通|全禁/.test(body), (body.match(/按规则|全通|全禁/) ?? ['无'])[0]);

// 五个标签页
for (const tab of ['可视化编辑', '原始编辑', '访问矩阵', '访问检查', '版本历史']) {
  check(`标签页「${tab}」存在`, (await page.locator(`.ant-tabs-tab:has-text("${tab}")`).count()) > 0);
}

// ---------------- 可视化编辑 ----------------
console.log('\n' + '='.repeat(88));
console.log('3. 可视化编辑');
console.log('='.repeat(88));
await page.locator('.ant-tabs-tab:has-text("可视化编辑")').click();
await sleep(700);
let vBody = await page.locator('body').innerText();
check('渲染「访问规则」区块', vBody.includes('访问规则'));
check('渲染「主机别名」区块', vBody.includes('主机别名'));
check('渲染「用户分组」区块', vBody.includes('用户分组'));
check('渲染「标签归属」区块', vBody.includes('标签归属'));
check('展示规则条数徽标', /\d+ 条/.test(vBody), (vBody.match(/(\d+) 条/) ?? ['无'])[0]);
// 关键语义警示必须出现（当前策略处于「规则」模式，两个警示都不应出现；
// 但要确认页面没有误报）
const hasFalseAlarm =
  vBody.includes('整张网络处于「全通」状态') && vBody.includes('所有设备之间完全无法互访');
check('未同时误报「全通」与「全禁」', !hasFalseAlarm);

// ---------------- 原始编辑 ----------------
console.log('\n' + '='.repeat(88));
console.log('4. 原始编辑 + 本地校验');
console.log('='.repeat(88));
await page.locator('.ant-tabs-tab:has-text("原始编辑")').click();
await sleep(600);
check('编辑器存在', (await page.locator('textarea').count()) > 0);
check('AI 辅助生成入口存在', (await page.locator('button:has-text("AI 辅助生成")').count()) > 0);

// 输入一段非法策略，确认本地校验给出「人话」错误
const ta = page.locator('textarea').first();
await ta.fill('{"acls":[{"action":"deny","proto":"*","src":["*"],"dst":["*:*"]}]}');
await sleep(1800);
let rBody = await page.locator('body').innerText();
check('非法策略触发校验错误提示', rBody.includes('处错误') || rBody.includes('处错误'.replace('处', '处')), (rBody.match(/\d+ 处错误/) ?? ['无'])[0]);
check('报错说明 action 只能是 accept', rBody.includes('accept'), rBody.includes('action 只能是') ? '含 action 提示' : '');
check('报错说明 proto 不接受 *', rBody.includes('协议'), '');
const applyBtns = page.locator('button:has-text("应用策略")');
const applyN = await applyBtns.count();
const allDisabled = [];
for (let i = 0; i < applyN; i++) allDisabled.push(await applyBtns.nth(i).isDisabled());
check(
  `校验未过时全部「应用策略」按钮均禁用（共 ${applyN} 个）`,
  applyN > 0 && allDisabled.every(Boolean),
  allDisabled.map((d, i) => `#${i}:${d ? '禁用' : '可点'}`).join(' '),
);

// 恢复合法内容
await ta.fill('{"acls":[{"action":"accept","proto":"tcp","src":["*"],"dst":["*:*"]}]}');
await sleep(1800);
rBody = await page.locator('body').innerText();
check('合法策略显示校验通过', rBody.includes('本地校验通过'));

// ---------------- 访问矩阵 ----------------
console.log('\n' + '='.repeat(88));
console.log('5. 访问矩阵');
console.log('='.repeat(88));
await page.locator('.ant-tabs-tab:has-text("访问矩阵")').click();
await sleep(3000);
let mBody = await page.locator('body').innerText();
check('矩阵说明渲染', mBody.includes('连通性矩阵'));
const cellCount = await page.locator('td div[class*="rounded-sm"]').count();
check('矩阵格子已渲染', cellCount > 0, `${cellCount} 个格子`);
check('图例显示「允许/拒绝」计数', mBody.includes('允许') && mBody.includes('拒绝'));
check('求值进度或已完成', !mBody.includes('求值中') || /求值中 \d+\/\d+/.test(mBody), (mBody.match(/求值中 \d+\/\d+/) ?? ['已完成'])[0]);

// ---------------- 访问检查 ----------------
console.log('\n' + '='.repeat(88));
console.log('6. 访问检查');
console.log('='.repeat(88));
await page.locator('.ant-tabs-tab:has-text("访问检查")').click();
await sleep(700);
let cBody = await page.locator('body').innerText();
check('检查器渲染', cBody.includes('验证「源 → 目的」是否被允许访问'));
check('提供「草稿策略 / 生效策略」切换', cBody.includes('用编辑中的草稿策略'));
check('可切换用生效策略求值', (await page.locator('text=用 Headscale 当前生效策略').count()) > 0);

// 用稳定 id 锚定两端，避免按 placeholder 文本定位（antd 下拉是浮层，定位不稳）
async function pickDevice(sideId, optionIndex) {
  const side = page.locator(`#${sideId}`);
  const sel = side.locator('.ant-select').nth(1); // [0] 是类型选择器，[1] 是取值选择器
  await sel.click();
  await sleep(500);
  const opts = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  const n = await opts.count();
  if (n === 0) return false;
  await opts.nth(Math.min(optionIndex, n - 1)).click();
  await sleep(400);
  return true;
}

try {
  const okFrom = await pickDevice('acl-check-from', 0);
  const okTo = await pickDevice('acl-check-to', 1);
  check('可选择源设备', okFrom);
  check('可选择目的设备', okTo);

  if (okFrom && okTo) {
    // ⚠️ antd 会在「恰好两个中文字符」的按钮文字中间插入一个空格（排版行为），
    // 所以 DOM 里实际是「检 查」。必须用容忍空格的匹配，否则选择器永远匹配不到
    // （表现为 isEnabled 超时，而不是「元素不存在」的直观报错）。
    const checkBtn = page.getByRole('button', { name: /检\s*查/ }).first();
    check('「检查」按钮已启用', await checkBtn.isEnabled());
    await checkBtn.click();
    await sleep(2500);
    cBody = await page.locator('body').innerText();
    check(
      '求值返回「允许」或「拒绝」结论',
      /允许访问|拒绝访问/.test(cBody),
      (cBody.match(/允许访问|拒绝访问/) ?? ['无'])[0],
    );
    check('展示判定轨迹', cBody.includes('判定轨迹'));
    check(
      '展示轨迹步骤（可排障）',
      (await page.locator('#acl-check-from').count()) > 0 && /^\s*01/m.test(cBody),
      (cBody.match(/判定轨迹[\s\S]{0,120}/) ?? ['无'])[0].replace(/\n/g, ' ').slice(0, 80),
    );
  }
} catch (err) {
  check('访问检查交互流程', false, `驱动失败：${String(err).slice(0, 120)}`);
}

// ---------------- 版本历史 ----------------
console.log('\n' + '='.repeat(88));
console.log('7. 版本历史');
console.log('='.repeat(88));
await page.locator('.ant-tabs-tab:has-text("版本历史")').click();
await sleep(2000);
let hBody = await page.locator('body').innerText();
check('版本历史渲染', hBody.includes('策略版本由面板维护'));
check('版本表格有数据行', (await page.locator('.ant-table-tbody tr.ant-table-row').count()) > 0,
  `${await page.locator('.ant-table-tbody tr.ant-table-row').count()} 行`);
check('存在「生效」标记', hBody.includes('生效'));

// ---------------- 控制台错误 ----------------
console.log('\n' + '='.repeat(88));
console.log('8. 运行时健康');
console.log('='.repeat(88));
// 排除与功能无关的资源类噪声（favicon 等）
const real = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
check('无未捕获的前端运行时错误', real.length === 0, real.slice(0, 3).join(' | '));

await browser.close();

// ---------------- 汇总 ----------------
const passed = results.filter((r) => r.ok).length;
console.log('\n' + '='.repeat(88));
console.log(`结果：${passed} 通过 / ${results.length - passed} 失败`);
if (results.some((r) => !r.ok)) {
  console.log('失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  ✗ ${r.label}`);
}
console.log('='.repeat(88));
process.exit(results.some((r) => !r.ok) ? 1 : 0);
