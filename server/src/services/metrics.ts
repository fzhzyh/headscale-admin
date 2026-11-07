/**
 * 面板自身控制面指标（P4 / 方案 B）
 *
 * ## 这是什么、不是什么
 * 统计**面板自己**的 API 请求量、错误率、延迟分位、WS 推送量。
 * **不是设备流量**——设备流量在 headscale 架构下不可得（控制面不转发数据面），
 * 这里也不会假装统计。两者的区别在接口与 UI 上都显式标注。
 *
 * 为什么这个指标有运维价值：
 * 面板是运维唯一的入口。它慢/报错，用户第一反应是「网络坏了」。
 * 有了 rpm、5xx 率、p95 延迟，就能区分「上游 headscale 慢」与
 * 「面板自己慢」——这是排障第一个岔路口。
 *
 * ## 设计取舍
 * 1. **纯内存、定长环形缓冲**，不落库。
 *    指标是「此刻状态」，不是审计记录；落库会引入写放大，
 *    而真正的历史趋势由采样器批量写 InfluxDB（见 sampler）。
 * 2. **延迟用蓄水池采样**（最近 CAP 个样本）算分位。
 *    完整直方图更准，但要选桶边界、还要处理标签爆炸；
 *    运维看 p50/p95 的量级足够，而且蓄水池实现只有十几行、无外部依赖。
 * 3. **路径归一化**：`/api/nodes/123` → `/api/nodes/:id`。
 *    否则每台设备都算一个独立路由，top 列表立刻被冲垮。
 * 4. **指标接口自身不计入**，否则查询指标会把指标自己刷高。
 */

/** 延迟样本容量：足够算稳定的 p95，又不会占内存 */
const CAP = 512;
/** top 路由保留条数 */
const TOP_N = 8;
/** 指标接口前缀：不统计自身，避免自我放大 */
const EXCLUDED_PREFIXES = ['/api/stats/panel'];

interface RouteCounter {
  count: number;
  errors: number;
  totalMs: number;
}

const latencyRing: number[] = [];
let latencyIdx = 0;

const routeMap = new Map<string, RouteCounter>();
let total = 0;
let status2xx = 0;
let status3xx = 0;
let status4xx = 0;
let status5xx = 0;
/** 启动时刻，用于算平均 rpm */
const startedAt = Date.now();

/**
 * 最近 60 秒的请求时间戳，用于算实时 rpm。
 *
 * ⚠️ 为什么不用 `Array.shift()`：
 * `shift()` 每次都要把整个数组前移一位，是 **O(n)**。面板一次页面加载会打出
 * 几十个 API 请求，`while (recent[0] 超时) recent.shift()` 的代价是 O(n²)——
 * 在 60 秒窗口里堆到上万条时，这一行的耗时能超过真正的业务逻辑。
 *
 * 这里改用**环形缓冲 + 读写下标**：写入永远 O(1)，过期只移动下标，
 * 物理回收等下标走到一定阈值再批量 splice（摊销 O(1)）。
 */
const RPM_WINDOW_MS = 60_000;
const recent: number[] = [];
/** 逻辑窗口起点（recent 中第一个有效元素的下标） */
let recentHead = 0;

function pruneRecent(now: number): void {
  while (recentHead < recent.length && now - (recent[recentHead] ?? now) > RPM_WINDOW_MS) {
    recentHead += 1;
  }
  // 下标推进太多时做一次物理压缩，避免数组无限增长（摊销 O(1)）
  if (recentHead > 1024 && recentHead * 2 > recent.length) {
    recent.splice(0, recentHead);
    recentHead = 0;
  }
}

function recentCount(now: number): number {
  pruneRecent(now);
  return recent.length - recentHead;
}

/** 把 `/api/nodes/123/rename` 归一化成 `/api/nodes/:id/rename` */
export function normalizePath(path: string): string {
  const p = path.split('?')[0] ?? path;
  return p
    // 纯数字段 → :id
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    // 24 位以上十六进制/ulid 段 → :key（预授权密钥、客户端 ID 等）
    .replace(/\/[A-Za-z0-9_-]{24,}(?=\/|$)/g, '/:key');
}

export function recordRequest(method: string, path: string, status: number, durationMs: number): void {
  if (EXCLUDED_PREFIXES.some((pre) => path.startsWith(pre))) return;

  total += 1;
  if (status >= 500) status5xx += 1;
  else if (status >= 400) status4xx += 1;
  else if (status >= 300) status3xx += 1;
  else status2xx += 1;

  // 延迟蓄水池
  const ms = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  if (latencyRing.length < CAP) latencyRing.push(ms);
  else {
    latencyRing[latencyIdx % CAP] = ms;
    latencyIdx += 1;
  }

  // 实时 rpm 窗口：写入 O(1)，过期只移动下标
  const now = Date.now();
  recent.push(now);
  pruneRecent(now);

  // 路由计数
  const key = `${method} ${normalizePath(path)}`;
  const cur = routeMap.get(key);
  if (cur) {
    cur.count += 1;
    cur.totalMs += ms;
    if (status >= 400) cur.errors += 1;
  } else {
    routeMap.set(key, { count: 1, errors: status >= 400 ? 1 : 0, totalMs: ms });
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export interface PanelMetrics {
  /** 自进程启动以来的总请求数 */
  total: number;
  /** 最近 60 秒的请求数（每分钟） */
  rpm: number;
  status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  /** 5xx 占比（0~1）；无请求时为 null 而不是 0，避免误读成「很健康」 */
  errorRate: number | null;
  latency: { p50: number | null; p95: number | null; p99: number | null; samples: number };
  /** 按请求量排序的前 N 个路由 */
  topRoutes: { route: string; count: number; errors: number; avgMs: number }[];
  uptimeSec: number;
  /** 实时窗口长度，供前端标注「这是最近 60 秒」 */
  windowSec: 60;
}

/**
 * 面板指标快照。
 *
 * 性能注意：`latencyRing` 最多 512 个样本，每次调用都要复制+排序（O(n log n)）。
 * 该函数被 `/api/stats/panel` 和**每轮采样器**调用，所以加一个 1 秒的结果缓存：
 * 运维看板上的分位数本来也不需要亚秒级新鲜度。
 */
let metricsMemo: { at: number; value: PanelMetrics } | null = null;

export function panelMetrics(): PanelMetrics {
  const now = Date.now();
  if (metricsMemo && now - metricsMemo.at < 1000) return metricsMemo.value;

  const sorted = [...latencyRing].sort((a, b) => a - b);
  const topRoutes = [...routeMap.entries()]
    .map(([route, c]) => ({
      route,
      count: c.count,
      errors: c.errors,
      avgMs: c.count > 0 ? Math.round((c.totalMs / c.count) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N);

  const value: PanelMetrics = {
    total,
    rpm: recentCount(now),
    status: { s2xx: status2xx, s3xx: status3xx, s4xx: status4xx, s5xx: status5xx },
    // 分母为 0 时返回 null：没有请求 ≠ 没有错误
    errorRate: total > 0 ? Math.round((status5xx / total) * 10000) / 10000 : null,
    latency: {
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      samples: sorted.length,
    },
    topRoutes,
    uptimeSec: Math.round((now - startedAt) / 1000),
    windowSec: 60,
  };
  metricsMemo = { at: now, value };
  return value;
}

/** 测试用：清空全部计数 */
export function __resetMetrics(): void {
  latencyRing.length = 0;
  latencyIdx = 0;
  routeMap.clear();
  recent.length = 0;
  recentHead = 0;
  metricsMemo = null;
  total = 0;
  status2xx = 0;
  status3xx = 0;
  status4xx = 0;
  status5xx = 0;
}
