/**
 * 会话与鉴权。
 *
 * 设计取舍：JWT 无状态看着优雅，但「禁用账户立即踢下线」「改密踢所有会话」
 * 这类运维刚需做不干净。这里用服务端 sessions 表 + 随机 session id（Cookie 承载），
 * 换来可撤销性——对管理面板来说，可控 > 优雅。
 */
import { all, get, run, changes } from '../db/index.ts';
import { randomToken, safeEqual } from '../crypto/secretbox.ts';
import { loadConfig } from '../config.ts';
import { nowIso, isoFrom } from '../util/time.ts';
import { ALL_PERMISSIONS, type Permission } from './rbac.ts';

export interface PanelUserRow {
  id: number;
  username: string;
  display_name: string | null;
  email: string | null;
  pwd_hash: string;
  is_superuser: number;
  is_active: number;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  must_change_pwd: number;
  auth_source: string;
  last_login_at: string | null;
}

export interface AuthContext {
  user: PanelUserRow;
  sessionId: string;
  csrfToken: string;
  permissions: Set<string>;
}

/** 计算用户的全部权限（超管直接给全集） */
export function resolvePermissions(userId: number, isSuperuser: boolean): Set<string> {
  if (isSuperuser) return new Set<string>(ALL_PERMISSIONS);
  const rows = all<{ permission: string }>(
    `SELECT DISTINCT gp.permission AS permission
       FROM panel_user_groups ug
       JOIN panel_group_permissions gp ON gp.group_id = ug.group_id
      WHERE ug.user_id = ?`,
    userId,
  );
  return new Set(rows.map((r) => r.permission));
}

export function hasPermission(ctx: AuthContext, perm: Permission | string): boolean {
  return ctx.permissions.has(perm);
}

// ---------------- 会话 ----------------

export interface CreatedSession {
  id: string;
  csrfToken: string;
  expiresAt: string;
}

export function createSession(userId: number, ip: string | null, userAgent: string | null): CreatedSession {
  const cfg = loadConfig();
  const id = randomToken(32);
  const csrfToken = randomToken(24);
  const now = Date.now();
  const expiresAt = isoFrom(now + cfg.security.sessionTtlSec * 1000);
  run(
    `INSERT INTO sessions (id, user_id, csrf_token, ip, user_agent, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    csrfToken,
    ip,
    userAgent,
    nowIso(),
    expiresAt,
  );
  return { id, csrfToken, expiresAt };
}

export function loadSession(sessionId: string): AuthContext | null {
  if (!sessionId) return null;
  const row = get<{
    session_id: string;
    csrf_token: string;
    expires_at: string;
    revoked_at: string | null;
    user: number;
    is_active: number;
  }>(
    `SELECT s.id AS session_id, s.csrf_token, s.expires_at, s.revoked_at,
            s.user_id AS user, u.is_active
       FROM sessions s JOIN panel_users u ON u.id = s.user_id
      WHERE s.id = ?`,
    sessionId,
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (!row.is_active) return null;

  const user = get<PanelUserRow>('SELECT * FROM panel_users WHERE id = ?', row.user);
  if (!user) return null;

  return {
    user,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    permissions: resolvePermissions(user.id, user.is_superuser === 1),
  };
}

export function revokeSession(sessionId: string): void {
  changes('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), sessionId);
}

/** 撤销某用户全部会话（改密/禁用/重置 2FA 后调用） */
export function revokeUserSessions(userId: number, except?: string): number {
  if (except) {
    return changes(
      'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
      nowIso(),
      userId,
      except,
    );
  }
  return changes('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', nowIso(), userId);
}

export function purgeExpiredSessions(): number {
  return changes('DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL', nowIso());
}

/** 校验 CSRF Token（写操作必过） */
export function verifyCsrf(ctx: AuthContext | null, token: string | undefined): boolean {
  const cfg = loadConfig();
  if (!cfg.security.csrfEnabled) return true;
  if (!ctx || !token) return false;
  return safeEqual(ctx.csrfToken, token);
}

// ---------------- 登录防爆破 ----------------

export function recordLoginAttempt(username: string, ip: string | null, success: boolean, reason?: string): void {
  run(
    'INSERT INTO login_attempts (username, ip, success, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    username,
    ip,
    success ? 1 : 0,
    reason ?? null,
    nowIso(),
  );
}

export function isLockedOut(username: string): { locked: boolean; retryAfterSec: number } {
  const cfg = loadConfig();
  const since = isoFrom(Date.now() - cfg.security.loginLockoutSec * 1000);
  const row = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND success = 0 AND created_at >= ?',
    username,
    since,
  );
  const failures = row?.n ?? 0;
  if (failures < cfg.security.loginMaxFailures) return { locked: false, retryAfterSec: 0 };
  const oldest = get<{ created_at: string }>(
    `SELECT created_at FROM login_attempts
      WHERE username = ? AND success = 0 AND created_at >= ?
      ORDER BY created_at ASC LIMIT 1`,
    username,
    since,
  );
  const unlockAt = oldest
    ? new Date(oldest.created_at).getTime() + cfg.security.loginLockoutSec * 1000
    : Date.now();
  return { locked: true, retryAfterSec: Math.max(1, Math.ceil((unlockAt - Date.now()) / 1000)) };
}

export function clearLoginFailures(username: string): void {
  run('DELETE FROM login_attempts WHERE username = ? AND success = 0', username);
}
