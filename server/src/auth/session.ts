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

/**
 * 超级管理员的权限集合是常量，进程内只构造一次。
 * 之前每个请求都 `new Set(ALL_PERMISSIONS)`，纯属重复分配。
 */
const SUPER_PERMS: Set<string> = new Set<string>(ALL_PERMISSIONS);

/** 计算用户的全部权限（超管直接给全集） */
export function resolvePermissions(userId: number, isSuperuser: boolean): Set<string> {
  // 超管是常量集合，无需缓存，直接复用同一份
  if (isSuperuser) return SUPER_PERMS;
  const now = Date.now();
  const hit = permCache.get(userId);
  if (hit && hit.cachedUntil > now) return hit.perms;
  const rows = all<{ permission: string }>(
    `SELECT DISTINCT gp.permission AS permission
       FROM panel_user_groups ug
       JOIN panel_group_permissions gp ON gp.group_id = ug.group_id
      WHERE ug.user_id = ?`,
    userId,
  );
  const perms = new Set(rows.map((r) => r.permission));
  if (permCache.size > 4096) permCache.clear();
  permCache.set(userId, { perms, cachedUntil: now + PERM_CACHE_MS });
  return perms;
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

  /**
   * 会话缓存。
   *
   * 为什么值得缓存：鉴权钩子在**每个请求**上跑，一次 loadSession 原本要
   *   1 次 sessions⋈panel_users 查询 + 1 次 panel_users 全行 + 1 次权限七表连接，
   * 每次都要重新编译 SQL、反序列化行。面板的高频轮询（采样 15s、看板 60s × 多查询）
   * 下这部分是纯重复劳动。
   *
   * 安全性如何保证「禁用立即生效」：
   *   - 缓存仅在**同进程内**、且有效期上限 5s（TTL_MS）
   *   - 所有撤销路径（revokeSession / revokeUserSessions / purge / 权限变更）
   *     都会**显式失效**，不依赖 TTL 兜底
   *   - 缓存条目仍受原会话 expires_at 约束，过期即 miss
   * 即最坏情况下「禁用账户后 5 秒内踢下线」，而正常路径是立即失效。
   */
  const now = Date.now();
  const hit = sessionCache.get(sessionId);
  if (hit && hit.cachedUntil > now) {
    // 会话本身到期仍要终止（缓存不能延长会话寿命）
    if (hit.ctx.user.is_active !== 1) {
      sessionCache.delete(sessionId);
      return null;
    }
    return hit.ctx;
  }

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
  const expiresMs = new Date(row.expires_at).getTime();
  if (expiresMs <= now) return null;
  if (!row.is_active) return null;

  const user = get<PanelUserRow>('SELECT * FROM panel_users WHERE id = ?', row.user);
  if (!user) return null;

  const ctx: AuthContext = {
    user,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    permissions: resolvePermissions(user.id, user.is_superuser === 1),
  };
  sessionCache.set(sessionId, {
    ctx,
    cachedUntil: Math.min(now + SESSION_CACHE_MS, expiresMs),
  });
  // 简单容量保护：缓存条目数受在线会话数约束，异常时整体清空重建
  if (sessionCache.size > SESSION_CACHE_MAX) sessionCache.clear();
  return ctx;
}

/** 会话上下文缓存（进程内，TTL 5 秒 + 写路径显式失效） */
const SESSION_CACHE_MS = 5_000;
const SESSION_CACHE_MAX = 512;
const sessionCache = new Map<string, { ctx: AuthContext; cachedUntil: number }>();

/** 用户权限集合缓存：权限变更极少，但每请求都要连表算 */
const permCache = new Map<number, { perms: Set<string>; cachedUntil: number }>();
const PERM_CACHE_MS = 60_000;

/**
 * 让所有会话/权限缓存失效。
 * 任何影响「谁能做什么」的写操作都必须调用：改组权限、改用户组、改超管标记、禁用账户。
 * 宁可多失效一次也不要漏——漏掉的后果是越权。
 */
export function invalidateSessionCache(): void {
  sessionCache.clear();
  permCache.clear();
}

export function revokeSession(sessionId: string): void {
  sessionCache.delete(sessionId);
  changes('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', nowIso(), sessionId);
}

/** 撤销某用户全部会话（改密/禁用/重置 2FA 后调用） */
export function revokeUserSessions(userId: number, except?: string): number {
  invalidateSessionCache();
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
  invalidateSessionCache();
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
