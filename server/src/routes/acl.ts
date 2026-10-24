/**
 * ACL 管理路由。
 *
 * 端点分组：
 *   - 策略读写与校验：GET/PUT /api/acl/policy，POST /api/acl/validate
 *   - 访问检查（面板自研能力）：POST /api/acl/check
 *   - 版本历史：GET /api/acl/versions，POST /api/acl/versions/:id/rollback，GET /api/acl/diff
 *
 * 安全设计：所有写操作都要 acl:write，推送要 acl:apply（拆开是因为
 * 「编辑」与「让策略生效」的风险等级不同——后者会立刻改变全网连通性）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { hs } from '../services/headscale.ts';
import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';
import { notifyChanged } from '../realtime/hub.ts';
import { parsePolicy, stringifyPolicy, interpretPolicy, type AclPolicy } from '../acl/model.ts';
import { validatePolicy } from '../acl/validate.ts';
import { checkAccess, type EvalNode } from '../acl/evaluator.ts';
import {
  listVersions,
  getVersion,
  readCurrentPolicy,
  detectDrift,
  applyPolicy,
  deleteVersion,
  diffVersions,
  importCurrentAsBaseline,
} from '../services/acl-versions.ts';
import { isNeverExpiring } from '../routes/nodes.ts';

/** 从 headscale 拉节点并转成求值引擎需要的形状 */
async function loadEvalNodes(): Promise<EvalNode[]> {
  const [nodes, users] = await Promise.all([hs().listNodes(), hs().listUsers()]);
  void users;
  return nodes.map((n) => ({
    id: Number(n.id),
    name: n.name,
    displayName: (n.givenName ?? '').trim() || n.name,
    ips: n.ipAddresses ?? [],
    tags: n.tags ?? [],
    userName: n.user?.name ?? null,
    approvedRoutes: n.approvedRoutes ?? [],
    isExitNode: (n.approvedRoutes ?? []).some((r) => r === '0.0.0.0/0' || r === '::/0'),
  }));
}

export async function registerAclRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================
  // 读取当前策略 + 漂移检测
  // ============================================================
  app.get('/api/acl/policy', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx) return;

    const cur = await readCurrentPolicy();
    const drift = detectDrift(cur.hsUpdatedAt);
    const interp = interpretPolicy(cur.parsed);

    // 首次接管时自动导入基线，让版本历史有起点
    if (drift.drifted && drift.lastAppliedVersionId === null && cur.content.trim() !== '') {
      await importCurrentAsBaseline(ctx.user.username);
    }

    const validation = validatePolicy(cur.parsed, cur.content);

    return reply.send({
      /** headscale 上的原文 */
      content: cur.content,
      /** 面板规范化后的 JSON（解析成功时） */
      normalized: cur.parsed ? stringifyPolicy(cur.parsed) : null,
      parsed: cur.parsed,
      parseError: cur.parseError,
      hsUpdatedAt: cur.hsUpdatedAt,
      interpretation: interp,
      validation,
      drift,
      canApply: ctx.permissions.has('acl:apply'),
    });
  });

  // ============================================================
  // 本地校验（不发请求到 headscale，快速反馈）
  // ============================================================
  app.post('/api/acl/validate', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const parsed = z.object({ content: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const policy = parsePolicy(parsed.data.content);
    if (!policy.ok) {
      return reply.send({
        ok: false,
        parseError: policy.error,
        issues: [{ severity: 'error', path: '(根)', message: policy.error }],
      });
    }
    const result = validatePolicy(policy.policy, parsed.data.content);
    return reply.send({ ok: result.ok, parseError: null, issues: result.issues, stats: result.stats });
  });

  // ============================================================
  // 用上游 check 做最终确认（本地通过 ≠ 上游一定接受）
  // ============================================================
  app.post('/api/acl/check-upstream', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const parsed = z.object({ content: z.string() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });
    try {
      await hs().checkPolicy(parsed.data.content);
      return reply.send({ ok: true, message: 'Headscale 校验通过' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.send({ ok: false, message: msg });
    }
  });

  // ============================================================
  // 应用策略（推送 + 落版本）
  // ============================================================
  app.put('/api/acl/policy', { preHandler: requirePermission('acl:apply') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z
      .object({
        content: z.string().max(1024 * 1024, '策略文件过大（上限 1MB）'),
        comment: z.string().max(500).optional(),
        source: z.enum(['manual', 'visual-editor', 'ai', 'rollback', 'import']).default('manual'),
        /** 用户是否已知晓高危影响（全通/全禁）并确认 */
        acknowledgedImpact: z.boolean().default(false),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    // 本地先校验，拦住明显错误（避免把上游搞成 500）
    const policy = parsePolicy(parsed.data.content);
    if (!policy.ok) {
      return reply.code(400).send({ error: 'PARSE_FAILED', message: policy.error });
    }
    const validation = validatePolicy(policy.policy, parsed.data.content);
    if (!validation.ok) {
      return reply.code(400).send({
        error: 'VALIDATION_FAILED',
        message: '策略未通过校验，请修正后再应用',
        issues: validation.issues.filter((i) => i.severity === 'error'),
      });
    }

    // 高危变更（全通 ↔ 全禁）要求显式确认：这类改动会让全网立刻断联或全开放
    const before = await readCurrentPolicy();
    const beforeMode = interpretPolicy(before.parsed).mode;
    const afterMode = interpretPolicy(policy.policy).mode;
    const isHighImpact =
      (beforeMode !== afterMode && (afterMode === 'allow-all' || afterMode === 'deny-all')) ||
      (afterMode === 'deny-all' && beforeMode === 'deny-all');
    if (isHighImpact && !parsed.data.acknowledgedImpact) {
      return reply.code(409).send({
        error: 'NEED_ACK',
        message:
          afterMode === 'allow-all'
            ? '该策略会让整张网络变为「全通」——任何人都能访问任何设备。请确认后重试。'
            : '该策略会让整张网络变为「全禁」——所有设备之间无法互访，可能立即造成业务中断。请确认后重试。',
        beforeMode,
        afterMode,
      });
    }

    // 上游语义校验（比本地更权威）
    try {
      await hs().checkPolicy(parsed.data.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({
        error: 'UPSTREAM_REJECTED',
        message: `Headscale 拒绝了该策略：${msg}`,
        hint: '本地校验已通过但上游更严格，请按上游报错修正',
      });
    }

    const result = await applyPolicy({
      content: parsed.data.content,
      ...(parsed.data.comment ? { comment: parsed.data.comment } : {}),
      source: parsed.data.source,
      authorId: ctx.user.id,
      authorName: ctx.user.username,
    });

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'acl.apply',
      targetType: 'acl_version',
      targetId: result.versionId,
      result: result.ok ? 'ok' : 'error',
      detail: {
        mode: `${beforeMode} → ${afterMode}`,
        comment: parsed.data.comment ?? null,
        stats: validation.stats,
        error: result.error,
      },
    });

    if (!result.ok) {
      return reply.code(502).send({
        error: 'APPLY_FAILED',
        message: `策略已保存到版本库（版本 #${result.versionId}）但推送 Headscale 失败：${result.error}`,
        versionId: result.versionId,
      });
    }

    notifyChanged('nodes', 'acl.changed', { data: { versionId: result.versionId, mode: afterMode } });

    return reply.send({
      ok: true,
      versionId: result.versionId,
      hsUpdatedAt: result.hsUpdatedAt,
      mode: afterMode,
      stats: validation.stats,
    });
  });

  // ============================================================
  // 访问检查（面板自研能力，headscale 不提供）
  // ============================================================
  app.post('/api/acl/check', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx) return;

    const sideSchema = z.union([
      z.object({ nodeId: z.number().int().positive() }),
      z.object({ cidr: z.string().min(1) }),
      z.object({ user: z.string().min(1) }),
      z.object({ tag: z.string().min(1) }),
      z.object({ internet: z.literal(true) }),
    ]);

    const parsed = z
      .object({
        from: sideSchema,
        to: sideSchema,
        port: z.number().int().min(0).max(65535).optional(),
        proto: z.string().optional(),
        /** 不传则用 headscale 当前生效的策略；传了则用草稿校验（编辑器实时预览） */
        draftContent: z.string().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    let policy: AclPolicy | null;
    let modeSource = 'headscale 当前策略';
    if (parsed.data.draftContent !== undefined) {
      const draft = parsePolicy(parsed.data.draftContent);
      if (!draft.ok) {
        return reply.code(400).send({ error: 'DRAFT_PARSE_FAILED', message: draft.error });
      }
      policy = draft.policy;
      modeSource = '草稿策略（编辑器实时预览）';
    } else {
      const cur = await readCurrentPolicy();
      policy = cur.parsed;
    }

    const [nodes, users] = await Promise.all([hs().listNodes(), hs().listUsers()]);
    const evalNodes: EvalNode[] = nodes.map((n) => ({
      id: Number(n.id),
      name: n.name,
      displayName: (n.givenName ?? '').trim() || n.name,
      ips: n.ipAddresses ?? [],
      tags: n.tags ?? [],
      userName: n.user?.name ?? null,
      approvedRoutes: n.approvedRoutes ?? [],
      isExitNode: (n.approvedRoutes ?? []).some((r) => r === '0.0.0.0/0' || r === '::/0'),
    }));

    const req2 = {
      from: parsed.data.from as Parameters<typeof checkAccess>[1]['from'],
      to: parsed.data.to as Parameters<typeof checkAccess>[1]['to'],
      ...(parsed.data.port !== undefined ? { port: parsed.data.port } : {}),
      ...(parsed.data.proto !== undefined ? { proto: parsed.data.proto } : {}),
    };

    const result = checkAccess(
      { policy, nodes: evalNodes, users: users.map((u) => ({ id: Number(u.id), name: u.name, email: u.email ?? null })) },
      req2,
    );

    return reply.send({ ...result, source: modeSource });
  });

  // ============================================================
  // 版本历史
  // ============================================================
  app.get('/api/acl/versions', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    return reply.send(
      listVersions(q.limit ? Number(q.limit) : 50, q.offset ? Number(q.offset) : 0),
    );
  });

  app.get('/api/acl/versions/:id', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const v = getVersion(id);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND', message: '版本不存在' });
    return reply.send({ version: v });
  });

  app.get('/api/acl/diff', { preHandler: requirePermission('acl:read') }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const from = Number(q.from);
    const to = Number(q.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: '需要 from 与 to 两个版本 ID' });
    }
    const d = diffVersions(from, to);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND', message: '版本不存在' });
    return reply.send(d);
  });

  /** 回滚 = 把历史版本的内容作为新版本重新应用（不删除历史，保留完整轨迹） */
  app.post('/api/acl/versions/:id/rollback', { preHandler: requirePermission('acl:apply') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);

    const v = getVersion(id);
    if (!v) return reply.code(404).send({ error: 'NOT_FOUND', message: '版本不存在' });

    const parsed = z.object({ acknowledgedImpact: z.boolean().default(false) }).safeParse(req.body ?? {});
    const ack = parsed.success ? parsed.data.acknowledgedImpact : false;

    const policy = parsePolicy(v.content);
    if (!policy.ok) {
      return reply.code(400).send({ error: 'PARSE_FAILED', message: `该版本内容无法解析：${policy.error}` });
    }

    const before = await readCurrentPolicy();
    const beforeMode = interpretPolicy(before.parsed).mode;
    const afterMode = interpretPolicy(policy.policy).mode;
    if (afterMode !== beforeMode && (afterMode === 'allow-all' || afterMode === 'deny-all') && !ack) {
      return reply.code(409).send({
        error: 'NEED_ACK',
        message:
          afterMode === 'allow-all'
            ? '回滚后网络将变为「全通」，请确认。'
            : '回滚后网络将变为「全禁」，所有设备互访中断，请确认。',
        beforeMode,
        afterMode,
      });
    }

    const result = await applyPolicy({
      content: v.content,
      comment: `回滚到版本 #${id}${v.comment ? `（${v.comment}）` : ''}`,
      source: 'rollback',
      authorId: ctx.user.id,
      authorName: ctx.user.username,
    });

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'acl.rollback',
      targetType: 'acl_version',
      targetId: result.versionId,
      result: result.ok ? 'ok' : 'error',
      detail: { rollbackFrom: id, mode: `${beforeMode} → ${afterMode}`, error: result.error },
    });

    if (!result.ok) {
      return reply.code(502).send({
        error: 'APPLY_FAILED',
        message: `已记录回滚版本 #${result.versionId} 但推送失败：${result.error}`,
        versionId: result.versionId,
      });
    }
    notifyChanged('nodes', 'acl.changed', { data: { versionId: result.versionId, mode: afterMode } });
    return reply.send({ ok: true, versionId: result.versionId, hsUpdatedAt: result.hsUpdatedAt });
  });

  app.post('/api/acl/versions/:id/delete', { preHandler: requirePermission('acl:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const r = deleteVersion(id);
    if (!r.ok) return reply.code(400).send({ error: 'REJECTED', message: r.error });
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'acl.version.delete', targetType: 'acl_version', targetId: id });
    return reply.send({ ok: true });
  });

  // ============================================================
  // 可视化编辑器所需的上下文（可选值、当前实体清单）
  // ============================================================
  app.get('/api/acl/context', { preHandler: requirePermission('acl:read') }, async (_req, reply) => {
    const [nodes, users] = await Promise.all([hs().listNodes(), hs().listUsers()]);
    const cur = await readCurrentPolicy();

    const allTags = new Set<string>();
    for (const n of nodes) for (const t of n.tags ?? []) allTags.add(t);
    for (const t of Object.keys(cur.parsed?.tagOwners ?? {})) allTags.add(t);

    const routes = new Set<string>();
    for (const n of nodes) for (const r of n.approvedRoutes ?? []) if (r !== '0.0.0.0/0' && r !== '::/0') routes.add(r);

    return reply.send({
      users: users.map((u) => ({ id: Number(u.id), name: u.name, token: `${u.name}@` })),
      nodes: nodes.map((n) => ({
        id: Number(n.id),
        name: (n.givenName ?? '').trim() || n.name,
        userName: n.user?.name ?? null,
        ips: n.ipAddresses ?? [],
        tags: n.tags ?? [],
        neverExpires: isNeverExpiring(n.expiry),
      })),
      tags: [...allTags].sort(),
      groups: Object.keys(cur.parsed?.groups ?? {}).sort(),
      hosts: Object.keys(cur.parsed?.hosts ?? {}).sort(),
      routes: [...routes].sort(),
      autogroups: {
        src: ['autogroup:member', 'autogroup:tagged', 'autogroup:danger-all'],
        dst: ['autogroup:internet', 'autogroup:member', 'autogroup:tagged', 'autogroup:self'],
      },
      protocols: ['tcp', 'udp', 'icmp', 'icmpv6', 'sctp', 'gre', 'esp', 'ah'],
    });
  });

  // 供其他模块复用
  void loadEvalNodes;
}
