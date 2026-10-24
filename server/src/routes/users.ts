/**
 * 用户管理路由。
 *
 * 三块内容刻意分开，因为它们生命周期完全不同：
 *   1. Headscale 用户 —— 属于 headscale 网络身份，由上游权威，面板只做代理
 *   2. 面板账户      —— 属于面板自身，本地权威
 *   3. 用户组/权限   —— 面板 RBAC
 * 绑定关系（面板账户 ↔ Headscale 用户）是多对多，解决「一个人管多个网络身份」。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { all, get, run, changes, tx, json } from '../db/index.ts';
import { hs } from '../services/headscale.ts';
import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';
import { nowIso } from '../util/time.ts';
import { hashPassword, checkPasswordStrength, generateStrongPassword } from '../auth/secrets.ts';
import { revokeUserSessions, resolvePermissions } from '../auth/session.ts';
import { PERMISSIONS, isPermission, ALL_PERMISSIONS } from '../auth/rbac.ts';
import { notifyChanged } from '../realtime/hub.ts';

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================
  // 一、Headscale 用户（上游权威）
  // ============================================================
  app.get('/api/hs/users', { preHandler: requirePermission('user:read') }, async (_req, reply) => {
    const users = await hs().listUsers();
    return reply.send({
      users: users.map((u) => ({
        id: Number(u.id),
        name: u.name,
        displayName: u.displayName ?? null,
        email: u.email ?? null,
        provider: u.provider ?? null,
        providerId: u.providerId ?? null,
        profilePicUrl: u.profilePicUrl ?? null,
        createdAt: u.createdAt ?? null,
      })),
    });
  });

  app.post('/api/hs/users', { preHandler: requirePermission('user:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({
        name: z.string().min(1).max(63).regex(/^[a-zA-Z0-9._@-]+$/, '用户名仅允许字母数字与 . _ @ -'),
        displayName: z.string().max(128).optional(),
        email: z.string().email().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const user = await hs().createUser(parsed.data);
    notifyChanged('nodes', 'users.changed', { data: { action: 'create', name: user.name } });
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'hs.user.create', targetType: 'hs_user', targetId: user.id, detail: parsed.data });
    return reply.send({ user });
  });

  app.post('/api/hs/users/:id/rename', { preHandler: requirePermission('user:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ newName: z.string().min(1).max(63) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '新用户名非法' });
    const user = await hs().renameUser(id, parsed.data.newName);
    notifyChanged('nodes', 'users.changed', { data: { action: 'rename', name: user.name } });
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'hs.user.rename', targetType: 'hs_user', targetId: id, detail: { to: parsed.data.newName } });
    return reply.send({ user });
  });

  app.post('/api/hs/users/:id/delete', { preHandler: requirePermission('user:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'NEED_CONFIRM', message: '删除用户需显式确认（其下设备需先迁移或删除）' });

    // 影响评估：该用户下还有多少设备
    const users = await hs().listUsers();
    const target = users.find((u) => Number(u.id) === id);
    const nodes = await hs().listNodes(target?.name);
    if (nodes.length > 0) {
      return reply.code(409).send({
        error: 'HAS_NODES',
        message: `该用户名下仍有 ${nodes.length} 台设备，请先迁移或删除设备`,
        nodes: nodes.map((n) => ({ id: Number(n.id), name: n.name })),
      });
    }
    await hs().deleteUser(id);
    // 清理面板侧绑定
    const removed = changes('DELETE FROM panel_user_hs_users WHERE hs_user_id = ?', id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'hs.user.delete', targetType: 'hs_user', targetId: id, detail: { name: target?.name, bindingsRemoved: removed } });
    return reply.send({ ok: true });
  });

  // ============================================================
  // 二、面板账户（本地权威）
  // ============================================================
  app.get('/api/panel/users', { preHandler: requirePermission('paneluser:read') }, async (_req, reply) => {
    const users = all<Record<string, unknown>>(
      `SELECT id, username, display_name, email, is_superuser, is_active, totp_enabled,
              must_change_pwd, auth_source, last_login_at, created_at
         FROM panel_users ORDER BY id`,
    );
    const groups = all<{ user_id: number; group_id: number; name: string }>(
      `SELECT ug.user_id, ug.group_id, g.name FROM panel_user_groups ug JOIN panel_groups g ON g.id = ug.group_id`,
    );
    const bindings = all<{ user_id: number; hs_user_id: number; hs_user_name: string }>(
      'SELECT user_id, hs_user_id, hs_user_name FROM panel_user_hs_users',
    );
    return reply.send({
      users: users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.display_name,
        email: u.email,
        isSuperuser: u.is_superuser === 1,
        isActive: u.is_active === 1,
        totpEnabled: u.totp_enabled === 1,
        mustChangePassword: u.must_change_pwd === 1,
        authSource: u.auth_source,
        lastLoginAt: u.last_login_at,
        createdAt: u.created_at,
        groups: groups.filter((g) => g.user_id === u.id).map((g) => ({ id: g.group_id, name: g.name })),
        hsUsers: bindings.filter((b) => b.user_id === u.id).map((b) => ({ id: b.hs_user_id, name: b.hs_user_name })),
      })),
    });
  });

  app.post('/api/panel/users', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({
        username: z.string().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, '用户名仅允许字母数字与 . _ -'),
        displayName: z.string().max(128).optional(),
        email: z.string().email().optional(),
        password: z.string().optional(),
        isSuperuser: z.boolean().optional(),
        groupIds: z.array(z.number().int()).optional(),
        hsUserIds: z.array(z.number().int()).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const d = parsed.data;
    if (get<{ id: number }>('SELECT id FROM panel_users WHERE username = ?', d.username)) {
      return reply.code(409).send({ error: 'EXISTS', message: '用户名已存在' });
    }
    // 未指定口令则随机生成并返回一次
    const generated = !d.password;
    const plain = d.password ?? generateStrongPassword(20);
    const strength = checkPasswordStrength(plain);
    if (!strength.ok) return reply.code(400).send({ error: 'WEAK_PASSWORD', message: strength.reason });

    const hsUsers = d.hsUserIds?.length ? await hs().listUsers() : [];

    const id = tx(() => {
      const uid = run(
        `INSERT INTO panel_users (username, display_name, email, pwd_hash, is_superuser, is_active, must_change_pwd, auth_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 'local', ?, ?)`,
        d.username,
        d.displayName ?? null,
        d.email ?? null,
        hashPassword(plain),
        d.isSuperuser ? 1 : 0,
        generated ? 1 : 0,
        nowIso(),
        nowIso(),
      );
      for (const gid of d.groupIds ?? []) {
        run('INSERT OR IGNORE INTO panel_user_groups (user_id, group_id) VALUES (?, ?)', uid, gid);
      }
      for (const hsid of d.hsUserIds ?? []) {
        const found = hsUsers.find((u) => Number(u.id) === hsid);
        run(
          'INSERT OR IGNORE INTO panel_user_hs_users (user_id, hs_user_id, hs_user_name, created_at) VALUES (?, ?, ?, ?)',
          uid,
          hsid,
          found?.name ?? `#${hsid}`,
          nowIso(),
        );
      }
      return uid;
    });

    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.create', targetType: 'panel_user', targetId: id, detail: { username: d.username, isSuperuser: !!d.isSuperuser, groups: d.groupIds ?? [], hsUsers: d.hsUserIds ?? [] } });
    return reply.send({ ok: true, id, ...(generated ? { generatedPassword: plain } : {}) });
  });

  app.patch('/api/panel/users/:id', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z
      .object({
        displayName: z.string().max(128).nullable().optional(),
        email: z.string().email().nullable().optional(),
        isActive: z.boolean().optional(),
        isSuperuser: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const target = get<{ id: number; username: string; is_superuser: number }>('SELECT id, username, is_superuser FROM panel_users WHERE id = ?', id);
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '账户不存在' });

    // 护栏：不能把自己降级 / 停用，避免把自己锁在门外
    if (id === ctx.user.id && (parsed.data.isSuperuser === false || parsed.data.isActive === false)) {
      return reply.code(400).send({ error: 'SELF_LOCKOUT', message: '不能停用或降级当前登录账户' });
    }
    // 护栏：不能移除最后一个超管
    if (parsed.data.isSuperuser === false && target.is_superuser === 1) {
      const supers = get<{ n: number }>('SELECT COUNT(*) AS n FROM panel_users WHERE is_superuser = 1 AND is_active = 1')?.n ?? 0;
      if (supers <= 1) return reply.code(400).send({ error: 'LAST_SUPERUSER', message: '系统必须保留至少一个启用的超级管理员' });
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    if (parsed.data.displayName !== undefined) { sets.push('display_name = ?'); params.push(parsed.data.displayName); }
    if (parsed.data.email !== undefined) { sets.push('email = ?'); params.push(parsed.data.email); }
    if (parsed.data.isActive !== undefined) { sets.push('is_active = ?'); params.push(parsed.data.isActive ? 1 : 0); }
    if (parsed.data.isSuperuser !== undefined) { sets.push('is_superuser = ?'); params.push(parsed.data.isSuperuser ? 1 : 0); }
    if (sets.length === 0) return reply.send({ ok: true });

    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    run(`UPDATE panel_users SET ${sets.join(', ')} WHERE id = ?`, ...params);

    if (parsed.data.isActive === false) revokeUserSessions(id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.update', targetType: 'panel_user', targetId: id, detail: parsed.data });
    return reply.send({ ok: true });
  });

  app.post('/api/panel/users/:id/password', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ password: z.string().optional(), forceChange: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });
    const plain = parsed.data.password ?? generateStrongPassword(20);
    const strength = checkPasswordStrength(plain);
    if (!strength.ok) return reply.code(400).send({ error: 'WEAK_PASSWORD', message: strength.reason });
    changes(
      'UPDATE panel_users SET pwd_hash = ?, must_change_pwd = ?, updated_at = ? WHERE id = ?',
      hashPassword(plain),
      parsed.data.forceChange === false ? 0 : 1,
      nowIso(),
      id,
    );
    const n = revokeUserSessions(id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.reset_password', targetType: 'panel_user', targetId: id, detail: { sessionsRevoked: n } });
    return reply.send({ ok: true, password: plain, sessionsRevoked: n });
  });

  app.post('/api/panel/users/:id/2fa/reset', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    changes('UPDATE panel_users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    const n = revokeUserSessions(id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.reset_2fa', targetType: 'panel_user', targetId: id, detail: { sessionsRevoked: n } });
    return reply.send({ ok: true, sessionsRevoked: n });
  });

  app.post('/api/panel/users/:id/delete', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    if (id === ctx.user.id) return reply.code(400).send({ error: 'SELF_DELETE', message: '不能删除当前登录账户' });
    const target = get<{ username: string; is_superuser: number }>('SELECT username, is_superuser FROM panel_users WHERE id = ?', id);
    if (!target) return reply.code(404).send({ error: 'NOT_FOUND', message: '账户不存在' });
    if (target.is_superuser === 1) {
      const supers = get<{ n: number }>('SELECT COUNT(*) AS n FROM panel_users WHERE is_superuser = 1 AND is_active = 1')?.n ?? 0;
      if (supers <= 1) return reply.code(400).send({ error: 'LAST_SUPERUSER', message: '系统必须保留至少一个启用的超级管理员' });
    }
    run('DELETE FROM panel_users WHERE id = ?', id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.delete', targetType: 'panel_user', targetId: id, detail: { username: target.username } });
    return reply.send({ ok: true });
  });

  // 账户 ↔ Headscale 用户 绑定
  app.put('/api/panel/users/:id/bindings', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ hsUserIds: z.array(z.number().int()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const hsUsers = await hs().listUsers();
    tx(() => {
      run('DELETE FROM panel_user_hs_users WHERE user_id = ?', id);
      for (const hsid of parsed.data.hsUserIds) {
        const found = hsUsers.find((u) => Number(u.id) === hsid);
        run(
          'INSERT OR IGNORE INTO panel_user_hs_users (user_id, hs_user_id, hs_user_name, created_at) VALUES (?, ?, ?, ?)',
          id,
          hsid,
          found?.name ?? `#${hsid}`,
          nowIso(),
        );
      }
    });
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.bind', targetType: 'panel_user', targetId: id, detail: { hsUserIds: parsed.data.hsUserIds } });
    return reply.send({ ok: true });
  });

  // ============================================================
  // 三、用户组与权限
  // ============================================================
  app.get('/api/panel/groups', { preHandler: requirePermission('group:read') }, async (_req, reply) => {
    const groups = all<{ id: number; name: string; description: string | null; is_builtin: number; created_at: string }>(
      'SELECT id, name, description, is_builtin, created_at FROM panel_groups ORDER BY id',
    );
    const perms = all<{ group_id: number; permission: string }>('SELECT group_id, permission FROM panel_group_permissions');
    const counts = all<{ group_id: number; n: number }>(
      'SELECT group_id, COUNT(*) AS n FROM panel_user_groups GROUP BY group_id',
    );
    return reply.send({
      catalog: PERMISSIONS,
      allPermissions: ALL_PERMISSIONS,
      groups: groups.map((g) => ({
        id: g.id,
        name: g.name,
        description: g.description,
        isBuiltin: g.is_builtin === 1,
        createdAt: g.created_at,
        permissions: perms.filter((p) => p.group_id === g.id).map((p) => p.permission),
        memberCount: counts.find((c) => c.group_id === g.id)?.n ?? 0,
      })),
    });
  });

  app.post('/api/panel/groups', { preHandler: requirePermission('group:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({
        name: z.string().min(1).max(64),
        description: z.string().max(255).optional(),
        permissions: z.array(z.string()).default([]),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const bad = parsed.data.permissions.filter((p) => !isPermission(p));
    if (bad.length) return reply.code(400).send({ error: 'BAD_PERMISSION', message: `未知权限：${bad.join(', ')}` });
    if (get<{ id: number }>('SELECT id FROM panel_groups WHERE name = ?', parsed.data.name)) {
      return reply.code(409).send({ error: 'EXISTS', message: '同名用户组已存在' });
    }

    const id = tx(() => {
      const gid = run(
        'INSERT INTO panel_groups (name, description, is_builtin, created_at, updated_at) VALUES (?, ?, 0, ?, ?)',
        parsed.data.name,
        parsed.data.description ?? null,
        nowIso(),
        nowIso(),
      );
      for (const p of parsed.data.permissions) {
        run('INSERT OR IGNORE INTO panel_group_permissions (group_id, permission) VALUES (?, ?)', gid, p);
      }
      return gid;
    });
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.group.create', targetType: 'panel_group', targetId: id, detail: parsed.data });
    return reply.send({ ok: true, id });
  });

  app.patch('/api/panel/groups/:id', { preHandler: requirePermission('group:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z
      .object({
        name: z.string().min(1).max(64).optional(),
        description: z.string().max(255).nullable().optional(),
        permissions: z.array(z.string()).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const group = get<{ name: string; is_builtin: number }>('SELECT name, is_builtin FROM panel_groups WHERE id = ?', id);
    if (!group) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户组不存在' });

    if (parsed.data.permissions) {
      const bad = parsed.data.permissions.filter((p) => !isPermission(p));
      if (bad.length) return reply.code(400).send({ error: 'BAD_PERMISSION', message: `未知权限：${bad.join(', ')}` });
      // 内置超级管理员组必须保有全部权限，否则会把系统锁死
      if (group.is_builtin === 1 && group.name === '超级管理员' && parsed.data.permissions.length < ALL_PERMISSIONS.length) {
        return reply.code(400).send({ error: 'PROTECTED', message: '内置「超级管理员」角色不可裁剪权限' });
      }
    }

    tx(() => {
      if (parsed.data.name || parsed.data.description !== undefined) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (parsed.data.name) { sets.push('name = ?'); params.push(parsed.data.name); }
        if (parsed.data.description !== undefined) { sets.push('description = ?'); params.push(parsed.data.description); }
        sets.push('updated_at = ?');
        params.push(nowIso(), id);
        run(`UPDATE panel_groups SET ${sets.join(', ')} WHERE id = ?`, ...params);
      }
      if (parsed.data.permissions) {
        run('DELETE FROM panel_group_permissions WHERE group_id = ?', id);
        for (const p of parsed.data.permissions) {
          run('INSERT OR IGNORE INTO panel_group_permissions (group_id, permission) VALUES (?, ?)', id, p);
        }
      }
    });
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.group.update', targetType: 'panel_group', targetId: id, detail: parsed.data });
    return reply.send({ ok: true });
  });

  app.post('/api/panel/groups/:id/delete', { preHandler: requirePermission('group:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const group = get<{ name: string; is_builtin: number }>('SELECT name, is_builtin FROM panel_groups WHERE id = ?', id);
    if (!group) return reply.code(404).send({ error: 'NOT_FOUND', message: '用户组不存在' });
    if (group.is_builtin === 1) return reply.code(400).send({ error: 'PROTECTED', message: '内置角色不可删除' });
    run('DELETE FROM panel_groups WHERE id = ?', id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.group.delete', targetType: 'panel_group', targetId: id, detail: { name: group.name } });
    return reply.send({ ok: true });
  });

  // 把用户加入/移出组
  app.put('/api/panel/users/:id/groups', { preHandler: requirePermission('paneluser:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ groupIds: z.array(z.number().int()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    tx(() => {
      run('DELETE FROM panel_user_groups WHERE user_id = ?', id);
      for (const gid of parsed.data.groupIds) {
        run('INSERT OR IGNORE INTO panel_user_groups (user_id, group_id) VALUES (?, ?)', id, gid);
      }
    });
    const perms = Array.from(resolvePermissions(id, get<{ is_superuser: number }>('SELECT is_superuser FROM panel_users WHERE id = ?', id)?.is_superuser === 1));
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'panel.user.set_groups', targetType: 'panel_user', targetId: id, detail: { groupIds: parsed.data.groupIds } });
    return reply.send({ ok: true, effectivePermissions: perms });
  });

  // 我的网络身份（供「快速连接」判断能看到哪些设备）
  app.get('/api/panel/me/bindings', async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx) return;
    const rows = all<{ hs_user_id: number; hs_user_name: string }>(
      'SELECT hs_user_id, hs_user_name FROM panel_user_hs_users WHERE user_id = ?',
      ctx.user.id,
    );
    return reply.send({ boundUsers: rows.map((r) => ({ id: r.hs_user_id, name: r.hs_user_name })) });
  });

  // 未使用的 json 导入防护（保留以便后续扩展解析）
  void json;
}
