/**
 * 认证路由：登录 / 2FA / 登出 / 会话 / 改密。
 *
 * 安全要点：
 *   - 登录失败计数 + 窗口锁定，防爆破
 *   - 2FA 与口令分两步校验，通过后统一下发会话
 *   - 会话 Cookie 为 httpOnly + SameSite=Lax（https 时加 Secure）
 *   - 改密后撤销该用户其它全部会话
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { get, run, changes, json } from '../db/index.ts';
import { loadConfig } from '../config.ts';
import { nowIso } from '../util/time.ts';
import {
  createSession,
  revokeSession,
  revokeUserSessions,
  recordLoginAttempt,
  isLockedOut,
  clearLoginFailures,
  verifyCsrf,
} from '../auth/session.ts';
import {
  verifyPassword,
  hashPassword,
  checkPasswordStrength,
  verifyTotp,
  generateTotpSecret,
  totpKeyUri,
  generateRecoveryCodes,
  consumeRecoveryCode,
} from '../auth/secrets.ts';
import { secretBox } from '../crypto/box.ts';
import { audit } from '../services/audit.ts';
import { ALL_PERMISSIONS } from '../auth/rbac.ts';

const COOKIE = 'hsa_sid';

interface PendingLogin {
  userId: number;
  expires: number;
}
/** 通过口令但尚未完成 2FA 的中间态（进程内，重启即失效——安全上可接受） */
const pending2fa = new Map<string, PendingLogin>();

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const twoFactorSchema = z.object({
  challengeId: z.string().min(10).max(128),
  code: z.string().min(4).max(32),
});

function cookieOptions(expiresAt: string): Record<string, unknown> {
  const cfg = loadConfig();
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: cfg.security.cookieSecure,
    expires: new Date(expiresAt),
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- 登录 ----------------
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 20, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'BAD_INPUT', message: '用户名或口令格式不正确' });
      }
      const { username, password } = parsed.data;
      const ip = req.ip;

      const lock = isLockedOut(username);
      if (lock.locked) {
        recordLoginAttempt(username, ip, false, 'locked');
        return reply.code(429).send({
          error: 'LOCKED',
          message: `登录失败次数过多，请 ${Math.ceil(lock.retryAfterSec / 60)} 分钟后再试`,
          retryAfterSec: lock.retryAfterSec,
        });
      }

      const user = get<{
        id: number;
        username: string;
        pwd_hash: string;
        is_active: number;
        totp_secret: string | null;
        totp_enabled: number;
        must_change_pwd: number;
      }>(
        'SELECT id, username, pwd_hash, is_active, totp_secret, totp_enabled, must_change_pwd FROM panel_users WHERE username = ?',
        username,
      );

      // 用户不存在与口令错误返回同一提示，避免枚举
      if (!user || !verifyPassword(password, user.pwd_hash)) {
        recordLoginAttempt(username, ip, false, 'bad_credentials');
        audit({ username, ip, action: 'auth.login', result: 'error', detail: { reason: 'bad_credentials' } });
        return reply.code(401).send({ error: 'BAD_CREDENTIALS', message: '用户名或口令错误' });
      }
      if (!user.is_active) {
        recordLoginAttempt(username, ip, false, 'disabled');
        audit({ userId: user.id, username, ip, action: 'auth.login', result: 'error', detail: { reason: 'disabled' } });
        return reply.code(403).send({ error: 'DISABLED', message: '该账户已被禁用' });
      }

      // 需要 2FA：返回 challenge，不直接发会话
      if (user.totp_enabled === 1 && user.totp_secret) {
        const challengeId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
        pending2fa.set(challengeId, { userId: user.id, expires: Date.now() + 5 * 60 * 1000 });
        recordLoginAttempt(username, ip, true, 'password_ok_await_2fa');
        return reply.send({ need2fa: true, challengeId });
      }

      // 无 2FA：直接建会话
      const session = createSession(user.id, ip, req.headers['user-agent'] ?? null);
      clearLoginFailures(username);
      recordLoginAttempt(username, ip, true, 'ok');
      run('UPDATE panel_users SET last_login_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), user.id);
      audit({ userId: user.id, username, ip, action: 'auth.login', detail: { twoFactor: false } });

      return reply
        .setCookie(COOKIE, session.id, cookieOptions(session.expiresAt))
        .send({
          ok: true,
          user: { id: user.id, username: user.username },
          csrfToken: session.csrfToken,
          mustChangePassword: user.must_change_pwd === 1,
        });
    },
  });

  // ---------------- 2FA 第二步 ----------------
  app.post('/api/auth/2fa', {
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
    handler: async (req, reply) => {
      const parsed = twoFactorSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'BAD_INPUT', message: '参数格式不正确' });
      }
      const { challengeId, code } = parsed.data;
      const pending = pending2fa.get(challengeId);
      if (!pending || pending.expires < Date.now()) {
        pending2fa.delete(challengeId);
        return reply.code(400).send({ error: 'CHALLENGE_EXPIRED', message: '验证会话已过期，请重新登录' });
      }

      const user = get<{
        id: number;
        username: string;
        totp_secret: string | null;
        recovery_codes: string | null;
        must_change_pwd: number;
      }>(
        'SELECT id, username, totp_secret, recovery_codes, must_change_pwd FROM panel_users WHERE id = ?',
        pending.userId,
      );
      if (!user) {
        pending2fa.delete(challengeId);
        return reply.code(400).send({ error: 'CHALLENGE_EXPIRED', message: '账户不存在' });
      }

      const secret = secretBox().tryDecrypt(user.totp_secret);
      let passed = Boolean(secret) && verifyTotp(secret!, code);
      let usedRecovery = false;

      // 动态码不过时，尝试恢复码
      if (!passed) {
        const hashed = json<string[]>(user.recovery_codes, []);
        const res = consumeRecoveryCode(hashed, code);
        if (res.ok) {
          passed = true;
          usedRecovery = true;
          run(
            'UPDATE panel_users SET recovery_codes = ?, updated_at = ? WHERE id = ?',
            JSON.stringify(res.remaining),
            nowIso(),
            user.id,
          );
        }
      }

      if (!passed) {
        recordLoginAttempt(user.username, req.ip, false, 'bad_2fa');
        audit({ userId: user.id, username: user.username, ip: req.ip, action: 'auth.2fa', result: 'error' });
        return reply.code(401).send({ error: 'BAD_2FA', message: '动态码或恢复码不正确' });
      }

      pending2fa.delete(challengeId);
      const session = createSession(user.id, req.ip, req.headers['user-agent'] ?? null);
      clearLoginFailures(user.username);
      recordLoginAttempt(user.username, req.ip, true, 'ok');
      run('UPDATE panel_users SET last_login_at = ?, updated_at = ? WHERE id = ?', nowIso(), nowIso(), user.id);
      audit({
        userId: user.id,
        username: user.username,
        ip: req.ip,
        action: 'auth.login',
        detail: { twoFactor: true, usedRecoveryCode: usedRecovery },
      });

      return reply
        .setCookie(COOKIE, session.id, cookieOptions(session.expiresAt))
        .send({
          ok: true,
          user: { id: user.id, username: user.username },
          csrfToken: session.csrfToken,
          mustChangePassword: user.must_change_pwd === 1,
          ...(usedRecovery ? { warn: `已使用恢复码，剩余 ${json<string[]>(get<{ recovery_codes: string | null }>('SELECT recovery_codes FROM panel_users WHERE id = ?', user.id)?.recovery_codes, []).length} 个` } : {}),
        });
    },
  });

  // ---------------- 当前会话 ----------------
  app.get('/api/auth/session', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) return reply.send({ authenticated: false });
    const perms = ctx.user.is_superuser === 1 ? ALL_PERMISSIONS : Array.from(ctx.permissions);
    return reply.send({
      authenticated: true,
      user: {
        id: ctx.user.id,
        username: ctx.user.username,
        displayName: ctx.user.display_name,
        email: ctx.user.email,
        isSuperuser: ctx.user.is_superuser === 1,
        mustChangePassword: ctx.user.must_change_pwd === 1,
        totpEnabled: ctx.user.totp_enabled === 1,
      },
      csrfToken: ctx.csrfToken,
      permissions: perms,
    });
  });

  // ---------------- 登出 ----------------
  app.post('/api/auth/logout', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) return reply.send({ ok: true });
    if (!verifyCsrf(ctx, req.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ error: 'BAD_CSRF', message: 'CSRF 校验失败' });
    }
    revokeSession(ctx.sessionId);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'auth.logout' });
    return reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true });
  });

  // ---------------- 修改自己的口令 ----------------
  app.post('/api/auth/password', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
    const schema = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: '参数格式不正确' });
    }
    if (!verifyCsrf(ctx, req.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ error: 'BAD_CSRF', message: 'CSRF 校验失败' });
    }
    if (!verifyPassword(parsed.data.currentPassword, ctx.user.pwd_hash)) {
      audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'auth.password', result: 'error', detail: { reason: 'bad_current' } });
      return reply.code(401).send({ error: 'BAD_CREDENTIALS', message: '当前口令不正确' });
    }
    const strength = checkPasswordStrength(parsed.data.newPassword);
    if (!strength.ok) {
      return reply.code(400).send({ error: 'WEAK_PASSWORD', message: strength.reason });
    }
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      return reply.code(400).send({ error: 'SAME_PASSWORD', message: '新口令不能与当前口令相同' });
    }

    changes(
      'UPDATE panel_users SET pwd_hash = ?, must_change_pwd = 0, updated_at = ? WHERE id = ?',
      hashPassword(parsed.data.newPassword),
      nowIso(),
      ctx.user.id,
    );
    // 改密后其它会话立即失效，保留当前会话
    revokeUserSessions(ctx.user.id, ctx.sessionId);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'auth.password' });
    return reply.send({ ok: true });
  });

  // ---------------- 2FA 自助管理 ----------------
  app.post('/api/auth/2fa/setup', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
    if (!verifyCsrf(ctx, req.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ error: 'BAD_CSRF', message: 'CSRF 校验失败' });
    }
    if (ctx.user.totp_enabled === 1) {
      return reply.code(400).send({ error: 'ALREADY_ENABLED', message: '2FA 已启用，如需重置请先关闭' });
    }
    const secret = generateTotpSecret();
    // 暂存到会话维度（写入库但标记未启用），避免明文外泄
    run('UPDATE panel_users SET totp_secret = ?, updated_at = ? WHERE id = ?', secretBox().encrypt(secret), nowIso(), ctx.user.id);
    const uri = totpKeyUri('headscale-admin', ctx.user.username, secret);
    return reply.send({ secret, otpauthUrl: uri });
  });

  app.post('/api/auth/2fa/enable', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
    if (!verifyCsrf(ctx, req.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ error: 'BAD_CSRF', message: 'CSRF 校验失败' });
    }
    const parsed = z.object({ code: z.string().min(6).max(8) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '动态码格式不正确' });

    const row = get<{ totp_secret: string | null }>('SELECT totp_secret FROM panel_users WHERE id = ?', ctx.user.id);
    const secret = secretBox().tryDecrypt(row?.totp_secret);
    if (!secret) return reply.code(400).send({ error: 'NO_SETUP', message: '请先获取 2FA 密钥' });
    if (!verifyTotp(secret, parsed.data.code)) {
      return reply.code(400).send({ error: 'BAD_2FA', message: '动态码校验失败，请检查设备时间是否准确' });
    }

    const { plain, hashed } = generateRecoveryCodes(8);
    run(
      'UPDATE panel_users SET totp_enabled = 1, recovery_codes = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(hashed),
      nowIso(),
      ctx.user.id,
    );
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'auth.2fa.enable' });
    return reply.send({ ok: true, recoveryCodes: plain });
  });

  app.post('/api/auth/2fa/disable', async (req, reply) => {
    const ctx = req.auth;
    if (!ctx) return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
    if (!verifyCsrf(ctx, req.headers['x-csrf-token'] as string | undefined)) {
      return reply.code(403).send({ error: 'BAD_CSRF', message: 'CSRF 校验失败' });
    }
    const parsed = z.object({ password: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '请输入口令确认' });
    if (!verifyPassword(parsed.data.password, ctx.user.pwd_hash)) {
      return reply.code(401).send({ error: 'BAD_CREDENTIALS', message: '口令不正确' });
    }
    run(
      'UPDATE panel_users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?',
      nowIso(),
      ctx.user.id,
    );
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'auth.2fa.disable' });
    return reply.send({ ok: true });
  });
}
