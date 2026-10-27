/**
 * 控制面指标单元测试（纯函数，不依赖 HTTP）
 *
 * 重点覆盖三处容易出错、且出错后**静默给出错数字**的地方：
 *  1. 路径归一化：不归一化的话每台设备都算一个独立路由，top 列表立刻被冲垮
 *  2. errorRate 在无请求时必须是 null 而不是 0（0 会被读成「很健康」）
 *  3. 分位计算：样本数很少时的边界（1 个样本、0 个样本）
 *
 * 运行：cd server && npx tsx src/services/metrics.test.ts
 */

import { recordRequest, panelMetrics, normalizePath, __resetMetrics } from './metrics.ts';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `实际 ${a} / 期望 ${e}`);
}

// ============================================================
console.log('\n=== 1. 路径归一化 ===');
eq('数字 ID 段 → :id', normalizePath('/api/nodes/123'), '/api/nodes/:id');
eq('尾部数字 ID → :id', normalizePath('/api/nodes/456/rename'), '/api/nodes/:id/rename');
eq('嵌套资源保留结构', normalizePath('/api/acl/versions/12/rollback'), '/api/acl/versions/:id/rollback');
eq('查询串被剥离', normalizePath('/api/nodes?status=online'), '/api/nodes');
eq('无 ID 路径不变', normalizePath('/api/system/health'), '/api/system/health');
eq(
  '长随机段（令牌/客户端 ID）→ :key',
  normalizePath('/api/keys/hskey-authreq-abcdefghijklmnopqrstuvwx'),
  '/api/keys/:key',
);
eq('多个数字段都归一化', normalizePath('/api/users/1/nodes/2'), '/api/users/:id/nodes/:id');

// ============================================================
console.log('\n=== 2. 空状态：无请求时 errorRate 必须是 null ===');
__resetMetrics();
{
  const m = panelMetrics();
  eq('总请求 0', m.total, 0);
  eq('rpm 0', m.rpm, 0);
  // 关键断言：0 会被前端读成「错误率 0%，很健康」，而事实是「没有样本」
  eq('errorRate 为 null（不是 0）', m.errorRate, null);
  eq('p50 为 null', m.latency.p50, null);
  eq('p95 为 null', m.latency.p95, null);
  eq('topRoutes 为空', m.topRoutes.length, 0);
}

// ============================================================
console.log('\n=== 3. 状态分类计数 ===');
__resetMetrics();
recordRequest('GET', '/api/nodes', 200, 12);
recordRequest('GET', '/api/nodes/1', 200, 8);
recordRequest('GET', '/api/nodes', 304, 3);
recordRequest('POST', '/api/auth/login', 401, 5);
recordRequest('GET', '/api/nodes/1', 404, 4);
recordRequest('GET', '/api/system/overview', 500, 900);
{
  const m = panelMetrics();
  eq('总请求 6', m.total, 6);
  eq('2xx = 2', m.status.s2xx, 2);
  eq('3xx = 1', m.status.s3xx, 1);
  eq('4xx = 2', m.status.s4xx, 2);
  eq('5xx = 1', m.status.s5xx, 1);
  // 1/6 ≈ 0.1667，四舍五入到 4 位
  eq('errorRate ≈ 0.1667', m.errorRate, 0.1667);
}

// ============================================================
console.log('\n=== 4. 路径归一化后的路由聚合 ===');
__resetMetrics();
recordRequest('GET', '/api/nodes/1', 200, 10);
recordRequest('GET', '/api/nodes/2', 200, 20);
recordRequest('GET', '/api/nodes/3', 500, 30);
recordRequest('GET', '/api/system/health', 200, 2);
{
  const m = panelMetrics();
  eq('top 路由只有 2 条（3 台设备合并为 1 条）', m.topRoutes.length, 2);
  const nodes = m.topRoutes.find((r) => r.route === 'GET /api/nodes/:id');
  ok('设备路由被合并', nodes !== undefined);
  eq('合并后计数 3', nodes?.count, 3);
  eq('合并后错误数 1', nodes?.errors, 1);
  eq('平均耗时 (10+20+30)/3 = 20', nodes?.avgMs, 20);
  eq('按请求量降序', m.topRoutes[0]?.route, 'GET /api/nodes/:id');
}

// ============================================================
console.log('\n=== 5. 延迟分位 ===');
__resetMetrics();
// 1..100 ms，p50 应≈50、p95≈95、p99≈99
for (let i = 1; i <= 100; i += 1) recordRequest('GET', '/api/x', 200, i);
{
  const m = panelMetrics();
  eq('p50 = 50', m.latency.p50, 50);
  eq('p95 = 95', m.latency.p95, 95);
  eq('p99 = 99', m.latency.p99, 99);
  eq('样本数 100', m.latency.samples, 100);
}

console.log('\n=== 6. 单样本边界 ===');
__resetMetrics();
recordRequest('GET', '/api/x', 200, 42);
{
  const m = panelMetrics();
  eq('单样本 p50 = 42', m.latency.p50, 42);
  eq('单样本 p95 = 42', m.latency.p95, 42);
}

// ============================================================
console.log('\n=== 7. 指标接口自身不计入（防止自我放大）===');
__resetMetrics();
recordRequest('GET', '/api/stats/panel', 200, 5);
recordRequest('GET', '/api/stats/panel/anything', 200, 5);
recordRequest('GET', '/api/nodes', 200, 5);
{
  const m = panelMetrics();
  eq('只统计了 1 个请求', m.total, 1);
  eq('top 路由不含指标接口', m.topRoutes[0]?.route, 'GET /api/nodes');
}

// ============================================================
console.log('\n=== 8. rpm 是「最近 60 秒」而非累计 ===');
__resetMetrics();
for (let i = 0; i < 5; i += 1) recordRequest('GET', '/api/x', 200, 1);
{
  const m = panelMetrics();
  eq('总请求 5', m.total, 5);
  eq('rpm 5（刚发生）', m.rpm, 5);
  eq('窗口长度为 60', m.windowSec, 60);
}

// ============================================================
console.log('\n=== 9. 非有限耗时被安全处理 ===');
__resetMetrics();
recordRequest('GET', '/api/x', 200, Number.NaN);
recordRequest('GET', '/api/x', 200, Number.POSITIVE_INFINITY);
{
  const m = panelMetrics();
  eq('总请求 2', m.total, 2);
  ok('NaN/Infinity 不会污染分位', m.latency.p50 === 0, String(m.latency.p50));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
