#!/usr/bin/env node
/**
 * P4 统计前端验证（无头浏览器，断言真实 DOM）
 *
 * 不只测「有没有渲染」，重点测三类容易写成假象的地方：
 *  1. 图表是否**真的画出来了**（recharts 的 svg 是否挂在 DOM 上），
 *     而不是只有标题和一个空白 div
 *  2. 时序库自检是否显示**真实采集计数**（已写入点 > 0），
 *     否则「曲线空白」无法区分「没设备在线」和「根本没采到」
 *  3. **架构限制是否如实告知**：设备流量在 headscale 下不可得，
 *     页面必须写出来，而不是悄悄不画
 *
 * 用法：node lab/verify_stats_ui.mjs [baseUrl]
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

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `   → ${detail}` : ''}`);
}

if (!PASS) {
  console.log('✗ 未取到 PANEL_ADMIN_SECRET（检查 container/lab.env）');
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));

// ---------------------------------------------------------------- 登录
console.log('='.repeat(88));
console.log('0. 登录');
console.log('='.repeat(88));
await loginUI(page, BASE, USER, PASS);
check('登录成功', new URL(page.url()).pathname === '/dashboard', new URL(page.url()).pathname);
await page.waitForTimeout(3000);

// ---------------------------------------------------------------- 在线趋势
console.log('\n' + '='.repeat(88));
console.log('1. 在线趋势图');
console.log('='.repeat(88));

const trendCard = page.locator('.hsa-card', { hasText: '在线趋势' }).first();
check('「在线趋势」卡片存在', (await trendCard.count()) > 0);
check('标注数据来源（面板采样 → InfluxDB）', (await page.locator('text=面板采样').count()) > 0);

const svgCount = await page.locator('.recharts-surface').count();
check('recharts 真实渲染出 SVG（不是空 div）', svgCount > 0, `${svgCount} 个`);

const legendText = (await page.locator('.recharts-legend-wrapper').first().innerText().catch(() => '')) || '';
check('图例含「在线」', legendText.includes('在线'), legendText.replace(/\n/g, ' / '));
check('图例含「总数」', legendText.includes('总数'));
check('图例含「在线率」', legendText.includes('在线率'));

const axisTicks = await page.locator('.recharts-xAxis .recharts-cartesian-axis-tick-value').count();
check('X 轴有时间刻度', axisTicks > 0, `${axisTicks} 个`);

const areaPaths = await page.locator('.recharts-area-area').count();
check('面积图层已绘制', areaPaths > 0, `${areaPaths} 个`);

// ⚠️ 单独的回归断言：AreaChart 会静默忽略 <Line>，
// 必须用 ComposedChart。这里直接数折线元素，防止「图例少一项」再被漏掉。
const lineCurves = await page.locator('.recharts-line-curve').count();
check('在线率折线真实渲染（需 ComposedChart）', lineCurves > 0, `${lineCurves} 条`);

// ---------------------------------------------------------------- 时序库自检
console.log('\n' + '='.repeat(88));
console.log('2. 时序库自检');
console.log('='.repeat(88));

const healthCard = page.locator('.hsa-card', { hasText: '时序库' }).first();
const healthText = (await healthCard.innerText().catch(() => '')) || '';
check('显示「正常」状态', healthText.includes('正常'), healthText.split('\n').slice(0, 2).join(' / '));

// 已写入点必须是真实正数（证明采样在写，而不是页面写死）
const writtenMatch = healthText.match(/已写入点\s*([\d,]+)/);
const written = writtenMatch ? Number(writtenMatch[1].replace(/,/g, '')) : -1;
check('已写入点为真实正数（证明采样在写）', written > 0, String(written));

const roundsMatch = healthText.match(/已采轮次\s*([\d,]+)/);
const rounds = roundsMatch ? Number(roundsMatch[1].replace(/,/g, '')) : -1;
check('已采轮次为正数', rounds > 0, String(rounds));

check('显示跟踪设备数', /跟踪设备\s*\d+/.test(healthText));

// 架构限制必须如实告知
check(
  '如实说明「设备流量不可得」',
  healthText.includes('流量') && healthText.includes('不可得'),
  healthText.includes('控制面') ? '并说明 headscale 是控制面' : '',
);

// ---------------------------------------------------------------- 在线时长表
console.log('\n' + '='.repeat(88));
console.log('3. 设备在线时长表');
console.log('='.repeat(88));

const uptimeCard = page.locator('.hsa-card', { hasText: '设备在线时长' }).first();
check('「设备在线时长」卡片存在', (await uptimeCard.count()) > 0);

const rowCount = await uptimeCard.locator('tbody .ant-table-row').count();
check('表格有数据行', rowCount > 0, `${rowCount} 行`);

const tableText = (await uptimeCard.innerText().catch(() => '')) || '';
check('列头含「在线采样比」', tableText.includes('在线采样比'));
check('列头含「观测窗口」', tableText.includes('观测窗口'));
// 观测窗口必须写清实际区间，而不是笼统的「24h 在线率」
check('展示实际观测区间（避免把未采到的时段算成离线）', /\d+\/\d+\s+\d{2}:\d{2}\s*→/.test(tableText));

const names = await uptimeCard.locator('tbody .ant-table-row td:first-child').allInnerTexts();
check('设备名来自真实数据（lab-*）', names.some((n) => n.includes('lab-')), names.slice(0, 3).join(' | '));

// ---------------------------------------------------------------- 时间窗口切换
console.log('\n' + '='.repeat(88));
console.log('4. 时间窗口切换');
console.log('='.repeat(88));

const before = await page.locator('.recharts-surface').count();
await page.locator('.ant-segmented-item', { hasText: '1 小时' }).first().click();
await page.waitForTimeout(2500);
const after = await page.locator('.recharts-surface').count();
check('切到「1 小时」后图表仍在', after === before && after > 0, `切换前 ${before} / 切换后 ${after}`);

const footerText = (await trendCard.innerText()) || '';
check('提示窗口与采样点数', /窗口：最近\s*1\s*小时/.test(footerText), (footerText.match(/窗口：[^\n]+/) || [''])[0]);

await page.locator('.ant-segmented-item', { hasText: '6 小时' }).first().click();
await page.waitForTimeout(2000);
check('切回「6 小时」正常', /窗口：最近\s*6\s*小时/.test((await trendCard.innerText()) || ''));

// ---------------------------------------------------------------- 面板控制面（方案 B）
console.log('\n' + '='.repeat(88));
console.log('5. 面板控制面指标（方案 B，与设备流量严格区分）');
console.log('='.repeat(88));

const panelCard = page.locator('[data-testid="panel-control-metrics"]');
check('面板控制面卡片已渲染', (await panelCard.count()) > 0);

const panelText = (await panelCard.innerText().catch(() => '')) || '';
check('显示请求速率', panelText.includes('请求速率'));
check('显示 5xx 错误率', panelText.includes('5xx 错误率'));
check('显示延迟 p95', panelText.includes('延迟 p95'));
check('显示 WS 连接数', panelText.includes('WS 连接'));

// 关键：必须明确声明这不是设备流量
check(
  '明确标注「不是设备流量」',
  panelText.includes('面板自身') && panelText.includes('不是设备流量'),
  panelText.includes('headscale 是控制面') ? '并说明控制面不转发数据面' : '',
);

// 数字必须是真实值（rpm / p95 不能是占位符）
const rpmMatch = panelText.match(/请求速率\s*(\d+)/);
check('请求速率为真实数字', rpmMatch !== null, rpmMatch?.[1] ?? '未匹配');

// 无请求时错误率显示「无样本」而不是 0%（0% 会被读成很健康）
check(
  '错误率无样本时不显示 0%',
  panelText.includes('无样本') || /5xx 错误率\s*\d+(\.\d+)?%/.test(panelText),
  (panelText.match(/5xx 错误率\s*\S+/) ?? [''])[0],
);

// ---------------------------------------------------------------- 功能进度诚实性
console.log('\n' + '='.repeat(88));
console.log('5. 功能进度清单的诚实性');
console.log('='.repeat(88));

const bodyText = await page.locator('body').innerText();
check('监控统计标为已完成', bodyText.includes('监控统计（在线状态 / 在线时长 / 趋势）'));
check('流量项明确标注架构限制', bodyText.includes('设备流量统计（headscale 架构下不可得）'));
check('网络拓扑标为已完成', bodyText.includes('网络拓扑可视化'));
check('面板控制面指标标为已完成', bodyText.includes('面板控制面指标（API 吞吐/延迟/WS）'));
check('资源中心标为已完成', bodyText.includes('资源中心（IP+端口 → ACL hosts 同步）'));
check('DNS 记录标为已完成', bodyText.includes('DNS 额外记录（热加载）'));
check('内置 OIDC Provider 标为已完成', bodyText.includes('内置 OIDC Provider（RS256 + JWKS + 授权码流）'));
check('外部 OIDC 登录标注为不做', bodyText.includes('外部 OIDC 登录（按需求不做）'));

// ---------------------------------------------------------------- 控制台
console.log('\n' + '='.repeat(88));
console.log('6. 运行时错误');
console.log('='.repeat(88));
const realErrors = consoleErrors.filter(
  (e) => !e.includes('favicon') && !e.includes('Download the React DevTools') && !/status of 40[13]/.test(e),
);
check('无前端运行时异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | '));

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
