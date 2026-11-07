/**
 * 数据保留期清理。
 *
 * ## 为什么必须有
 * 面板有三张**只增长不收敛**的表，长期运行会把磁盘和查询一起拖垮：
 *
 * | 表 | 增长来源 | 不清理的后果 |
 * |---|---|---|
 * | `login_attempts` | 每次登录尝试插一行（含失败） | 表过百万行后，锁定查询的 COUNT 变慢，登录接口跟着慢 |
 * | `audit_logs` | 每个写操作插一行 | 审计页 `ORDER BY ts DESC` 走索引还行，但 `COUNT(*)` 过滤会全扫 |
 * | `metric_points` | 未配 InfluxDB 时的降级写入点 | 无上限，一天就能写几十万行 |
 *
 * ## 设计取舍
 * - **按「天」保留，不按行数**。行数上限会让「某天操作特别多」的审计记录
 *   被提前删掉，而这恰恰是最需要留证的时刻。天数是对「合规要留多久」的直接表达。
 * - **DELETE 分批**：一次删太多会长时间持有写锁，把同进程的写操作（会话、审计）
 *   全堵在 busy_timeout 后面。这里每批 5000 行，循环直到删完或达到批次上限。
 * - **失败不影响主流程**：清理是维护动作，出错记日志即可，绝不冒泡到请求处理。
 */
import { changes } from './index.ts';
import { isoFrom } from '../util/time.ts';

export interface RetentionPolicy {
  /** 登录尝试保留天数（足够覆盖锁定窗口与事后追查） */
  loginAttemptsDays: number;
  /** 审计日志保留天数（合规留证的基本要求，默认一年） */
  auditLogsDays: number;
  /** 降级时序点保留天数 */
  metricPointsDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  loginAttemptsDays: 30,
  auditLogsDays: 365,
  metricPointsDays: 30,
};

/** 单表单次清理最多删多少行（防止一次清理占用写锁太久） */
const BATCH = 5000;
const MAX_BATCHES = 20;

interface PurgeResult {
  table: string;
  deleted: number;
  /** 是否达到批次上限（说明还剩很多，下次继续） */
  more: boolean;
}

function purgeBefore(table: string, timeCol: string, cutoffIso: string): PurgeResult {
  let deleted = 0;
  let batches = 0;
  for (; batches < MAX_BATCHES; batches += 1) {
    // 带 LIMIT 的 DELETE 需要子查询：SQLite 的 DELETE 不支持直接 LIMIT
    const n = changes(
      `DELETE FROM ${table}
         WHERE id IN (SELECT id FROM ${table} WHERE ${timeCol} < ? LIMIT ?)`,
      cutoffIso,
      BATCH,
    );
    deleted += n;
    if (n < BATCH) break;
  }
  return { table, deleted, more: batches >= MAX_BATCHES - 1 };
}

/**
 * 执行一轮清理。
 * @param nowMs 当前时间（可注入，便于测试）
 */
export function runRetention(
  policy: RetentionPolicy = DEFAULT_RETENTION,
  nowMs: number = Date.now(),
): PurgeResult[] {
  const out: PurgeResult[] = [];
  out.push(
    purgeBefore('login_attempts', 'created_at', isoFrom(nowMs - policy.loginAttemptsDays * 86400_000)),
  );
  out.push(purgeBefore('audit_logs', 'ts', isoFrom(nowMs - policy.auditLogsDays * 86400_000)));
  out.push(
    purgeBefore('metric_points', 'ts', isoFrom(nowMs - policy.metricPointsDays * 86400_000)),
  );
  return out;
}
