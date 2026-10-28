/**
 * InfluxDB 3.x 写入与查询层（line protocol + SQL，无 SDK 依赖）
 *
 * ## 为什么是 3.x 而不是 2.x
 *
 * 2.x 的 Flux 查询语言在 3.x 已被移除，官方明确新负载走 SQL。两者 API
 * 完全不同，无法含糊兼容：
 *
 * | | 2.x | 3.x |
 * |---|---|---|
 * | 写入 | `POST /api/v2/write?org=&bucket=&precision=s` | `POST /api/v3/write_lp?db=&precision=second` |
 * | 查询 | `POST /api/v2/query?org=` + Flux → annotated CSV | `POST /api/v3/query_sql` + JSON → **纯数组** |
 * | 身份 | org + bucket | database（无 org 概念） |
 * | 建库 | 需预先创建 bucket | **首次写入自动创建** |
 * | 健康 | `/api/v2/buckets` | `/health`（**需 token**，返回纯文本 `OK`） |
 *
 * 配置层保留 `INFLUX_ORG` 只为兼容旧 .env，3.x 下不参与任何请求。
 * `INFLUX_BUCKET` 直接作为 3.x 的 database 名。
 *
 * ## 设计取舍
 *
 * 1. **不用官方 SDK**：写入就是「一行行 line protocol 发个 POST」，查询就是
 *    「发个 JSON 拿回 JSON 数组」。自己发 fetch 约 80 行，换来少一个依赖、
 *    无供应链风险、出错报文能原样进日志。
 *
 * 2. **写失败绝不抛到调用方**：采样器跑在定时器里，一次写入异常若冒泡就会
 *    中断整个轮询链，连带把 WebSocket 推送也带停。写路径全部 try/catch，
 *    失败只累加计数并记录最后错误（节流后 warn），下个周期继续。这是监控
 *    数据，丢几个点远好过拖垮采样器。
 *
 * 3. **time 字段统一补时区**：见 normalizeTime —— 这是 3.x 最容易踩的坑。
 */

import { loadConfig } from '../config.ts';

/** 一个时序点：measurement + tags + fields + 可选时间戳（秒） */
export interface Point {
  measurement: string;
  tags?: Record<string, string | number>;
  fields: Record<string, number | string | boolean>;
  /** Unix 秒；不传则用服务端时间 */
  ts?: number;
}

let buffer: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let droppedTotal = 0;
let writtenTotal = 0;
let lastErrorAt = 0;
let lastErrorMsg = '';

const FLUSH_MAX = 200;
const FLUSH_MS = 2000;

function cfgInflux(): { url: string; org: string; bucket: string; token: string } {
  return loadConfig().influx;
}

/** 是否已配置 InfluxDB（未配置时采样器降级：只算内存快照，不写库） */
export function influxEnabled(): boolean {
  const c = cfgInflux();
  // 3.x 不需要 org，只看 url / token / database
  return Boolean(c.url && c.token && c.bucket);
}

/**
 * line protocol 转义规则（官方文档）：
 *   measurement / tag key / tag value：逗号、等号、空格要转义
 *   field key：逗号、等号、空格要转义
 *   field string value：双引号和反斜杠要转义，整体加双引号
 * 不转义会让一个含空格的设备名把整批数据写成语法错误。
 */
function escKey(s: string): string {
  return s.replace(/([,= ])/g, '\\$1');
}
function escTagValue(s: string): string {
  return s.replace(/([,= ])/g, '\\$1');
}
function fieldValue(v: number | string | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    // InfluxDB 不接受 NaN / Infinity，遇到就写 0 并留痕
    return Number.isFinite(v) ? String(v) : '0';
  }
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function toLine(p: Point): string {
  const parts: string[] = [escKey(p.measurement)];
  if (p.tags) {
    for (const [k, v] of Object.entries(p.tags)) {
      if (v === undefined || v === null || v === '') continue;
      // tag 值必须是字符串；数字 id 也转成字符串，避免被当成 field
      parts.push(`${escKey(k)}=${escTagValue(String(v))}`);
    }
  }
  const fields = Object.entries(p.fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${escKey(k)}=${fieldValue(v)}`);
  // line protocol 要求至少一个 field，空 field 的行必须丢弃，否则整批 400
  if (fields.length === 0) return '';
  const ts = p.ts ?? Math.floor(Date.now() / 1000);
  return `${parts.join(',')} ${fields.join(',')} ${ts}`;
}

/** 把点转成 line protocol 放进缓冲区；满即刷 */
export function enqueue(points: Point[]): void {
  if (!influxEnabled() || points.length === 0) return;
  for (const p of points) {
    const line = toLine(p);
    if (line) buffer.push(line);
  }
  if (buffer.length >= FLUSH_MAX) {
    void flush();
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => void flush(), FLUSH_MS);
    // 不要让定时器阻止进程退出
    flushTimer.unref?.();
  }
}

interface WriteStats {
  written: number;
  dropped: number;
  buffered: number;
  lastError: string | null;
  lastErrorAgoSec: number | null;
}

/**
 * 真正发出请求。内部函数，调用方必须是 flush()。
 * 返回是否成功——失败时整批标记为丢弃（不做重试：监控数据不值得
 * 为了几分钟前的点阻塞当前周期）。
 */
async function postBatch(lines: string[]): Promise<boolean> {
  if (lines.length === 0) return true;
  const c = cfgInflux();

  // 3.x 原生写入端点。db 不存在时会自动创建（实测确认，无需预建库）。
  // precision 用 3.x 的枚举名 `second`，不是 2.x 的 `s`。
  const url = `${c.url}/api/v3/write_lp?db=${encodeURIComponent(c.bucket)}&precision=second`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: lines.join('\n'),
      signal: AbortSignal.timeout(5000),
    });
    // 成功返回 204 No Content
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      lastErrorAt = Date.now();
      // InfluxDB 的写错误报文通常包含「哪一行、什么原因」，原样保留
      lastErrorMsg = `HTTP ${res.status} ${body.slice(0, 300)}`;
      droppedTotal += lines.length;
      return false;
    }
    writtenTotal += lines.length;
    return true;
  } catch (err) {
    lastErrorAt = Date.now();
    lastErrorMsg = err instanceof Error ? err.message : String(err);
    droppedTotal += lines.length;
    return false;
  }
}

/** 刷缓冲区。并发调用安全（取走 buffer 后清空，后到的点在下一批） */
export async function flush(): Promise<boolean> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0) return true;
  const batch = buffer;
  buffer = [];
  return postBatch(batch);
}

export function writeStats(): WriteStats {
  return {
    written: writtenTotal,
    dropped: droppedTotal,
    buffered: buffer.length,
    lastError: lastErrorMsg || null,
    lastErrorAgoSec: lastErrorAt ? Math.round((Date.now() - lastErrorAt) / 1000) : null,
  };
}

/**
 * 连通性自检：打 3.x 的 `/health`（带 token）。
 *
 * ⚠️ 3.x 的 `/health` **需要认证**，不带 token 返回 401
 * `{"error":"the request was not authenticated"}`；带对了返回**纯文本 `OK`**
 * （不是 JSON）。所以这里不能按 JSON 解析。
 *
 * 不用「写一个假点」来探测：会污染真实数据，且在只读 token 下会误判为不可用。
 */
export async function influxHealth(): Promise<{ ok: boolean; detail: string }> {
  const c = cfgInflux();
  if (!influxEnabled()) return { ok: false, detail: '未配置 INFLUX_URL / INFLUX_TOKEN' };
  try {
    const res = await fetch(`${c.url}/health`, {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(4000),
    });
    const body = (await res.text().catch(() => '')).trim();
    if (res.ok) return { ok: true, detail: `InfluxDB 3 · ${body || 'OK'} · db=${c.bucket}` };
    return { ok: false, detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** SQL 查询返回的一行：列名 → 值 */
export interface SqlRow {
  [column: string]: string | number | boolean | null;
}

/**
 * 把 InfluxDB 3 返回的时间字符串补上时区标识。
 *
 * ## 为什么必须做
 * 3.x 返回的 `time` 形如 `"2026-10-28T18:00:53"` —— **是 UTC，但没有 `Z`**。
 * 而 `new Date("2026-10-28T18:00:53")` 对这个「无时区标识的 ISO 串」会按
 * **本地时区**解析（ECMA-262 date-time 规则）。在 UTC+8 的机器上直接算，
 * 每个点的时间会偏 8 小时，图表整体错位，而且不报任何错。
 *
 * 实测：服务器本地时区 CST(+8)，写入 ts=1793210453（=18:00:53Z），
 * 接口原样返回 `"2026-10-28T18:00:53"`，`new Date()` 会当成
 * `18:00:53+08:00`，比真实时刻晚 8 小时。
 *
 * 这里统一补 `Z`。已有 `Z` 或带 `+08:00` 之类偏移的串原样返回（幂等）。
 */
export function normalizeTime(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v) ? `${v}Z` : v;
}

/**
 * 解析 `/api/v3/query_sql?format=json` 的响应体。
 *
 * 3.x 在 json 格式下直接返回**对象数组**（不是 2.x 的
 * `{results:[{series:{columns,values}}]}`），所以不需要列/值矩阵映射。
 * 抽成纯函数是为了能脱离网络做单元测试。
 *
 * `time` 经 normalizeTime 补时区；非数组/非法 JSON 返回 error 而不抛。
 */
export function parseSqlJson(text: string): { rows: SqlRow[]; error?: string } {
  const t = text.trim();
  if (!t) return { rows: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { rows: [], error: `返回不是合法 JSON: ${t.slice(0, 200)}` };
  }
  if (!Array.isArray(parsed)) {
    // 3.x 出错时返回纯文本（如 `Error during planning: table ... not found`），
    // 被上游当成功响应处理时会走到这里，保留下原文便于定位。
    return { rows: [], error: `返回不是数组: ${t.slice(0, 200)}` };
  }

  const rows: SqlRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const row = item as SqlRow;
    if ('time' in row) row.time = normalizeTime(row.time) as string;
    rows.push(row);
  }
  return { rows };
}

/**
 * 执行一条 SQL，返回「列名 → 值」的行数组。
 *
 * `time` 字段统一经 normalizeTime 补时区（见该函数注释）。
 */
export async function querySql(
  sql: string,
  signalMs = 8000,
): Promise<{ rows: SqlRow[]; error?: string }> {
  const c = cfgInflux();
  if (!influxEnabled()) return { rows: [], error: '未配置 InfluxDB' };
  try {
    const res = await fetch(`${c.url}/api/v3/query_sql`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ db: c.bucket, q: sql, format: 'json' }),
      signal: AbortSignal.timeout(signalMs),
    });
    const text = (await res.text()).trim();

    if (!res.ok) {
      const msg = text.slice(0, 300);
      // 「表不存在」= 还没有任何采样写入过（首次部署的正常空态），不是故障。
      // 若当成错误上报，用户第一次打开面板会看到红色故障提示。
      // 实测报文：Error during planning: table 'public.iox.node_status' not found
      if (/not found|does not exist/i.test(msg)) return { rows: [] };
      return { rows: [], error: `HTTP ${res.status} ${msg}` };
    }

    return parseSqlJson(text);
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 测试用：清空计数与缓冲 */
export function __resetForTests(): void {
  buffer = [];
  droppedTotal = 0;
  writtenTotal = 0;
  lastErrorAt = 0;
  lastErrorMsg = '';
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}
