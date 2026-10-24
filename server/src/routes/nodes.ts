/**
 * 设备（节点）管理路由。
 *
 * 所有写操作均走：权限校验 → CSRF → 影响评估 → 执行 → 审计。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hs } from '../services/headscale.ts';
import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';
import { setSetting } from '../services/settings.ts';
import { nowIso, secondsSince } from '../util/time.ts';
import type { HsNode } from '../headscale/client.ts';
import { notifyChanged } from '../realtime/hub.ts';

/**
 * 判断 headscale 节点是否永不过期。
 *
 * ⚠️ 实测坑：headscale 用两种方式表达「永不过期」：
 *   1. expiry = null（通过 disable_expiry 设置后）
 *   2. expiry = "0001-01-01T00:00:00Z"（Go time.Time 零值，调试创建的节点即此形态）
 * 两种都**不能**当作「已过期」处理，否则面板会把正常设备标红。
 */
export function isNeverExpiring(expiry: string | null | undefined): boolean {
  if (!expiry) return true;
  const t = new Date(expiry).getTime();
  if (Number.isNaN(t)) return true;
  // Go 零值 / 任何 1 月 1 日的公元 1 年时间
  return t <= new Date('0002-01-01T00:00:00Z').getTime();
}

/**
 * 归一化节点数据，补上前端需要的派生字段。
 *
 * 关键语义（实测 v0.29.6）：
 *   - `name`      = 客户端上报的主机名，通常不可改
 *   - `givenName` = 面板/CLI 重命名设置的值，才是「用户改过的名字」
 *     RenameNode 改的是 givenName，name 原封不动。UI 必须优先显示 displayName，
 *     否则「重命名」看起来像没生效。
 */
function shapeNode(n: HsNode): Record<string, unknown> {
  const neverExpires = isNeverExpiring(n.expiry);
  const expiresAt = neverExpires ? null : new Date(n.expiry!).getTime();
  const now = Date.now();
  const given = (n.givenName ?? '').trim();
  return {
    id: Number(n.id),
    name: n.name,
    givenName: n.givenName ?? '',
    /** UI 展示与搜索都用这个：优先 givenName，回退 name */
    displayName: given || n.name,
    renamed: given !== '' && given !== n.name,
    user: n.user ? { id: Number(n.user.id), name: n.user.name, displayName: n.user.displayName ?? null } : null,
    ipAddresses: n.ipAddresses ?? [],
    tags: n.tags ?? [],
    online: Boolean(n.online),
    lastSeen: n.lastSeen ?? null,
    lastSeenAgoSec: secondsSince(n.lastSeen),
    createdAt: n.createdAt ?? null,
    /** 原始值，排障时保留 */
    expiryRaw: n.expiry ?? null,
    /** 归一化后：null 表示永不过期 */
    expiry: neverExpires ? null : n.expiry,
    neverExpires,
    expired: expiresAt !== null && expiresAt <= now,
    expiresInSec: expiresAt === null ? null : Math.floor((expiresAt - now) / 1000),
    approvedRoutes: n.approvedRoutes ?? [],
    availableRoutes: n.availableRoutes ?? [],
    subnetRoutes: n.subnetRoutes ?? [],
    registerMethod: n.registerMethod ?? null,
    machineKey: n.machineKey,
    nodeKey: n.nodeKey,
    preAuthKeyPrefix: n.preAuthKey?.key ?? null,
  };
}

export async function registerNodeRoutes(app: FastifyInstance): Promise<void> {
  // ---------------- 列表（支持筛选/搜索） ----------------
  app.get('/api/nodes', { preHandler: requirePermission('node:read') }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const all = await hs().listNodes(q.user);
    const shaped = all.map(shapeNode);

    const filtered = shaped.filter((n) => {
      if (q.status === 'online' && !n.online) return false;
      if (q.status === 'offline' && n.online) return false;
      if (q.status === 'expired' && !n.expired) return false;
      if (q.user && (n.user as { name: string } | null)?.name !== q.user) return false;
      if (q.tag) {
        const tags = n.tags as string[];
        if (!tags.some((t) => t.includes(q.tag!))) return false;
      }
      if (q.search) {
        const s = q.search.toLowerCase();
        const hay = [
          n.name,
          n.givenName,
          ...(n.ipAddresses as string[]),
          (n.user as { name: string } | null)?.name ?? '',
          ...(n.tags as string[]),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });

    return reply.send({
      total: filtered.length,
      nodes: filtered,
      facets: {
        users: [...new Set(shaped.map((n) => (n.user as { name: string } | null)?.name).filter(Boolean))],
        tags: [...new Set(shaped.flatMap((n) => n.tags as string[]))].sort(),
      },
    });
  });

  // ---------------- 详情 ----------------
  app.get('/api/nodes/:id', { preHandler: requirePermission('node:read') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: '节点 ID 非法' });
    }
    const n = await hs().getNode(id);
    return reply.send({ node: shapeNode(n) });
  });

  // ---------------- 重命名 ----------------
  app.post('/api/nodes/:id/rename', { preHandler: requirePermission('node:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ newName: z.string().min(1).max(63).regex(/^[a-zA-Z0-9._-]+$/, '仅允许字母数字与 . _ -') }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const before = await hs().getNode(id);
    const node = await hs().renameNode(id, parsed.data.newName);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'node.rename',
      targetType: 'node',
      targetId: id,
      detail: { from: before.name, to: parsed.data.newName },
    });
    notifyChanged('nodes', 'nodes.changed', { changed: [shapeNode(node)] });
    return reply.send({ node: shapeNode(node) });
  });

  // ---------------- 设置标签 ----------------
  app.post('/api/nodes/:id/tags', { preHandler: requirePermission('node:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z
      .object({ tags: z.array(z.string().regex(/^tag:[a-zA-Z0-9._-]+$/, '标签需形如 tag:name（只允许字母数字与 . _ -）')).max(64) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    // 实测提醒：headscale 对非法标签格式会返回 500（上游缺陷），
    // 所以上面的格式校验必须在本地先做，不能依赖上游报错。
    // 另外标签必须已在 ACL 的 tagOwners 中定义，否则上游返回 400
    // 「requested tags ... are invalid or not permitted」。
    const before = await hs().getNode(id);
    let node: HsNode;
    try {
      node = await hs().setTags(id, parsed.data.tags);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid or not permitted|tagOwners/i.test(msg)) {
        return reply.code(400).send({
          error: 'TAG_NOT_OWNED',
          message: `标签未在 ACL 的 tagOwners 中定义或当前身份无权拥有：${msg}。请先在「ACL 管理」中定义 tagOwners`,
        });
      }
      throw err;
    }
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'node.tags',
      targetType: 'node',
      targetId: id,
      detail: { nodeName: before.name, from: before.tags ?? [], to: parsed.data.tags },
    });
    return reply.send({ node: shapeNode(node) });
  });

  // ---------------- 过期 / 取消过期 ----------------
  app.post('/api/nodes/:id/expire', { preHandler: requirePermission('node:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z
      .object({
        /** true = 永不过期；false = 立即过期 */
        neverExpires: z.boolean().optional(),
        /** 指定到期时间（RFC3339）。与 neverExpires 互斥 */
        expiry: z.string().datetime().optional(),
      })
      .refine((d) => !(d.neverExpires === true && d.expiry !== undefined), {
        message: '「永不过期」与「指定到期时间」不能同时设置',
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const d = parsed.data;
    const before = await hs().getNode(id);

    // 实测语义（v0.29.6）：
    //   neverExpires=true        → ?disable_expiry=true → expiry 变为 null
    //   expiry=<RFC3339>         → ?expiry=...          → 到期时间生效
    //   两者都不传               → 立即过期
    let node: HsNode;
    if (d.neverExpires) {
      node = await hs().expireNode(id, undefined, true);
    } else if (d.expiry) {
      node = await hs().expireNode(id, new Date(d.expiry), false);
    } else {
      node = await hs().expireNode(id); // 立即过期
    }

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: d.neverExpires ? 'node.expiry.disable' : d.expiry ? 'node.expiry.set' : 'node.expire.now',
      targetType: 'node',
      targetId: id,
      detail: { nodeName: before.name, before: before.expiry ?? null, after: node.expiry ?? null, requested: d },
    });
    notifyChanged('nodes', 'nodes.changed', { changed: [shapeNode(node)] });
    return reply.send({ node: shapeNode(node) });
  });

  // ---------------- 删除（两步确认，防误删） ----------------
  app.post('/api/nodes/:id/delete', { preHandler: requirePermission('node:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'NEED_CONFIRM', message: '删除设备不可恢复，需显式确认' });
    }
    const node = await hs().getNode(id);
    await hs().deleteNode(id);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'node.delete',
      targetType: 'node',
      targetId: id,
      detail: { name: node.name, ips: node.ipAddresses || [], user: node.user?.name },
    });
    return reply.send({ ok: true });
  });

  // ---------------- 手动注册节点 ----------------
  app.post('/api/nodes/register', { preHandler: requirePermission('node:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({
        user: z.string().min(1, '必须指定 Headscale 用户名'),
        key: z.string().min(10, '请填写节点 key 或预授权密钥'),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const node = await hs().registerNode(parsed.data.user, parsed.data.key);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'node.register',
      targetType: 'node',
      targetId: node.id,
      detail: { user: parsed.data.user, name: node.name },
    });
    return reply.send({ node: shapeNode(node) });
  });

  // ---------------- 手动全量同步 ----------------
  app.post('/api/system/sync', { preHandler: requirePermission('settings:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const [nodes, users] = await Promise.all([hs().listNodes(), hs().listUsers()]);
    setSetting('system.lastSyncAt', nowIso());
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'system.sync',
      detail: { nodes: nodes.length, users: users.length },
    });
    return reply.send({
      ok: true,
      syncedAt: nowIso(),
      nodes: nodes.length,
      users: users.length,
      message: '已从 Headscale 拉取最新数据；面板自身数据（资源/ACL 版本/OIDC 客户端）为本地权威，不受影响',
    });
  });
}

export { shapeNode };
