/**
 * 审计日志。
 *
 * 所有对 Headscale 的写操作、面板账户变更、设置修改都必须留痕，
 * 这是「可审计」底线的落地实现。
 */
import { all, run, get } from '../db/index.ts';
import { nowIso } from '../util/time.ts';

export interface AuditInput {
  userId?: number | null;
  username?: string | null;
  ip?: string | null;
  action: string;
  targetType?: string;
  targetId?: string | number;
  result?: 'ok' | 'error';
  detail?: unknown;
}

export function audit(input: AuditInput): void {
  try {
    run(
      `INSERT INTO audit_logs (ts, user_id, username, ip, action, target_type, target_id, result, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      nowIso(),
      input.userId ?? null,
      input.username ?? null,
      input.ip ?? null,
      input.action,
      input.targetType ?? null,
      input.targetId === undefined || input.targetId === null ? null : String(input.targetId),
      input.result ?? 'ok',
      input.detail === undefined ? null : JSON.stringify(input.detail),
      nowIso(),
    );
  } catch (err) {
    // 审计写入失败不能影响主流程，但必须留下痕迹
    console.error('[audit] 写入审计日志失败：', err);
  }
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  action?: string;
  username?: string;
  result?: string;
  since?: string;
  until?: string;
}

export function queryAudit(q: AuditQuery = {}): { total: number; rows: Record<string, unknown>[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.action) {
    where.push('action LIKE ?');
    params.push(`%${q.action}%`);
  }
  if (q.username) {
    where.push('username = ?');
    params.push(q.username);
  }
  if (q.result) {
    where.push('result = ?');
    params.push(q.result);
  }
  if (q.since) {
    where.push('ts >= ?');
    params.push(q.since);
  }
  if (q.until) {
    where.push('ts <= ?');
    params.push(q.until);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs ${clause}`, ...params)?.n ?? 0;
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const rows = all(
    `SELECT id, ts, username, ip, action, target_type, target_id, result, detail
       FROM audit_logs ${clause}
      ORDER BY ts DESC, id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  return { total, rows };
}
