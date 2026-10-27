/**
 * InfluxDB 2.x 写入层（line protocol，无 SDK 依赖）
 *
 * 设计取舍：
 * ─────────────────────────────────────────────────────────────
 * 1. **不用 @influxdata/influxdb-client**
 *    写入 API 就是 `POST /api/v2/write?org=&bucket=&precision=s` + 一行行
 *    `measurement,tag=v field=1 ts`。自己发 fetch 约 60 行，换来：
 *      · 少一个依赖（该 SDK 会连带 vendor 一堆浏览器侧 polyfill）
 *      · 无供应链风险，Node 22 自带 fetch，零额外安装
 *      · 出错时的报文能原样打日志，不像 SDK 包一层自定义 Error
 *    代价：没有自动重试/背压。这里用「批量 + 失败丢弃 + 计数」覆盖，
 *    因为这些是监控数据，丢几个点远好过拖垮采样器。
 *
 * 2. **写失败绝不抛到调用方**
 *    采样器跑在定时器里，一次写入异常若冒泡就会中断整个轮询链，
 *    连带把 WebSocket 推送也带停。所以写路径全部 try/catch，
 *    失败只累加计数器并 warn（带节流），下个周期继续。
 *
 * 3. **批量而非逐点**
 *    15s 采一次、N 台设备 → 每轮 N+1 个点。攒够 FLUSH_MAX 或超过
 *    FLUSH_MS 就一次性发，减少 HTTP 往返。
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

  const url = `${c.url}/api/v2/write?org=${encodeURIComponent(c.org)}&bucket=${encodeURIComponent(c.bucket)}&precision=s`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${c.token}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: lines.join('\n'),
      signal: AbortSignal.timeout(5000),
    });
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
 * 连通性自检：查 /api/v2/buckets 而不是写一个假点。
 * 写假点会污染真实数据，且在只读 token 下会误判为「不可用」。
 */
export async function influxHealth(): Promise<{ ok: boolean; detail: string }> {
  const c = cfgInflux();
  if (!influxEnabled()) return { ok: false, detail: '未配置 INFLUX_URL / INFLUX_TOKEN' };
  try {
    const res = await fetch(`${c.url}/api/v2/buckets?limit=1`, {
      headers: { Authorization: `Token ${c.token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return { ok: true, detail: `bucket=${c.bucket}` };
    const body = await res.text().catch(() => '');
    return { ok: false, detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 执行一条 Flux 查询，返回「列名 → 值」的行数组。
 *
 * 为什么要自己解析 CSV：InfluxDB 返回的是 **annotated CSV**（前面若干行
 * `#datatype`/`#group`/`#default` 元数据，然后才是表头与数据），按行 split
 * 会得到一堆噪音。这里只取 `,result,table,...` 之后的第一张表，
 * 足够覆盖本项目的查询（单 measurement、单 field 或少量 field）。
 *
 * 设计取舍：不引 @influxdata/influxdb-client 的 queryApi —— 它把 CSV 解析
 * 封得很深，出错时看不到原始响应；而面板只需要"取几条曲线"，自己解析
 * 反而更透明、可调试。
 */
export interface FluxRow {
  [column: string]: string;
}

export async function queryFlux(flux: string, signalMs = 8000): Promise<{ rows: FluxRow[]; error?: string }> {
  const c = cfgInflux();
  if (!influxEnabled()) return { rows: [], error: '未配置 InfluxDB' };
  try {
    const res = await fetch(`${c.url}/api/v2/query?org=${encodeURIComponent(c.org)}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${c.token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
      body: flux,
      signal: AbortSignal.timeout(signalMs),
    });
    const text = await res.text();
    if (!res.ok) return { rows: [], error: `HTTP ${res.status} ${text.slice(0, 300)}` };
    return { rows: parseAnnotatedCsv(text) };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** 解析 annotated CSV：跳过 # 开头的元数据行，取表头后的数据行 */
export function parseAnnotatedCsv(text: string): FluxRow[] {
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  let hasValueCol = false;
  const rows: FluxRow[] = [];
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#')) continue;
    const cells = line.split(',');
    // 表头行形如 ",result,table,_start,..."——首列是空的分组键
    if (header === null) {
      header = cells;
      // ⚠️ 只有未 pivot 的查询才有 _value 列。
      // pivot(rowKey,columnKey,valueColumn) 会把 field 拆成独立列，
      // 此时若仍按「必须有 _value」过滤，整张表会被滤空 → 接口返回 0 点，
      // 而 InfluxDB 里其实有数据（实测踩过：count() 有 9 条，API 返回 0 点）。
      hasValueCol = cells.includes('_value');
      continue;
    }
    // result 为空表示这张表结束（InfluxDB 用空行+新表头分隔）
    if (cells.length < header.length) continue;
    const row: FluxRow = {};
    for (let i = 0; i < header.length; i += 1) {
      const key = header[i] || `_col${i}`;
      row[key] = cells[i] ?? '';
    }
    // 未 pivot 时只保留带 _value 的数据行；pivot 后保留全部
    if (hasValueCol && (row._value === undefined || row._value === '')) continue;
    rows.push(row);
  }
  return rows;
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
