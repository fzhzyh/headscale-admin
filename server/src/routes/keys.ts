/**
 * 密钥路由：预授权密钥（PreAuthKey）、Headscale API Key、快速连接命令生成。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hs } from '../services/headscale.ts';
import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';
import { getSetting } from '../services/settings.ts';
import { secondsSince } from '../util/time.ts';

export async function registerKeyRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================
  // 预授权密钥
  // ============================================================
  app.get('/api/preauthkeys', { preHandler: requirePermission('preauthkey:read') }, async (_req, reply) => {
    const keys = await hs().listPreAuthKeys();
    const now = Date.now();
    return reply.send({
      keys: keys.map((k) => ({
        id: Number(k.id),
        key: k.key,
        user: k.user ? { id: Number(k.user.id), name: k.user.name } : null,
        reusable: Boolean(k.reusable),
        ephemeral: Boolean(k.ephemeral),
        used: Boolean(k.used),
        aclTags: k.aclTags ?? [],
        expiration: k.expiration ?? null,
        createdAt: k.createdAt ?? null,
        expired: k.expiration ? new Date(k.expiration).getTime() <= now : false,
        expiresInSec: k.expiration ? Math.floor((new Date(k.expiration).getTime() - now) / 1000) : null,
      })),
    });
  });

  app.post('/api/preauthkeys', { preHandler: requirePermission('preauthkey:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({
        userId: z.number().int().positive('请选择 Headscale 用户'),
        reusable: z.boolean().default(false),
        ephemeral: z.boolean().default(false),
        /** 有效期天数；0 或省略表示 90 天后过期，-1 表示不设置过期 */
        expirationDays: z.number().int().min(-1).max(3650).default(90),
        aclTags: z.array(z.string().regex(/^tag:[a-zA-Z0-9._-]+$/)).default([]),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const d = parsed.data;
    const expiration = d.expirationDays < 0 ? undefined : new Date(Date.now() + d.expirationDays * 86400_000);

    const key = await hs().createPreAuthKey({
      user: d.userId,
      reusable: d.reusable,
      ephemeral: d.ephemeral,
      ...(expiration ? { expiration } : {}),
      aclTags: d.aclTags,
    });
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'preauthkey.create',
      targetType: 'preauthkey',
      targetId: key.id,
      detail: { user: key.user?.name, reusable: d.reusable, ephemeral: d.ephemeral, days: d.expirationDays, tags: d.aclTags },
    });
    return reply.send({ key });
  });

  app.post('/api/preauthkeys/:id/expire', { preHandler: requirePermission('preauthkey:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    await hs().expirePreAuthKey(id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'preauthkey.expire', targetType: 'preauthkey', targetId: id });
    return reply.send({ ok: true });
  });

  app.post('/api/preauthkeys/:id/delete', { preHandler: requirePermission('preauthkey:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'NEED_CONFIRM', message: '删除密钥需显式确认' });
    await hs().deletePreAuthKey(id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'preauthkey.delete', targetType: 'preauthkey', targetId: id });
    return reply.send({ ok: true });
  });

  // ============================================================
  // Headscale API Key
  // ============================================================
  app.get('/api/apikeys', { preHandler: requirePermission('apikey:read') }, async (_req, reply) => {
    const keys = await hs().listApiKeys();
    const now = Date.now();
    return reply.send({
      keys: keys.map((k) => ({
        id: Number(k.id),
        prefix: k.prefix,
        expiration: k.expiration ?? null,
        createdAt: k.createdAt ?? null,
        lastSeen: k.lastSeen ?? null,
        lastSeenAgoSec: secondsSince(k.lastSeen),
        expired: k.expiration ? new Date(k.expiration).getTime() <= now : false,
      })),
    });
  });

  app.post('/api/apikeys', { preHandler: requirePermission('apikey:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z.object({ expirationDays: z.number().int().min(1).max(3650).default(90) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const apiKey = await hs().createApiKey(new Date(Date.now() + parsed.data.expirationDays * 86400_000));
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'apikey.create', detail: { days: parsed.data.expirationDays, prefix: apiKey.slice(0, 10) } });
    // 明文只在这一刻返回，headscale 之后只给 prefix
    return reply.send({ apiKey, warning: '该密钥仅本次显示，请立即复制保存' });
  });

  app.post('/api/apikeys/:id/expire', { preHandler: requirePermission('apikey:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    await hs().expireApiKey(id);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'apikey.expire', targetType: 'apikey', targetId: id });
    return reply.send({ ok: true });
  });

  app.post('/api/apikeys/:prefix/delete', { preHandler: requirePermission('apikey:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const prefix = (req.params as { prefix: string }).prefix;
    const parsed = z.object({ confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'NEED_CONFIRM', message: '删除密钥需显式确认' });

    // 护栏：不要删掉面板自己正在用的那把 key
    const current = getSetting('hs.apiKey');
    if (current && current.startsWith(prefix)) {
      return reply.code(400).send({
        error: 'SELF_LOCKOUT',
        message: '该密钥正是面板当前使用的 API Key，删除后面板将失去对 Headscale 的控制，请先切换为其它密钥',
      });
    }
    await hs().deleteApiKey(prefix);
    audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'apikey.delete', targetType: 'apikey', targetId: prefix });
    return reply.send({ ok: true });
  });

  // ============================================================
  // 快速连接：命令生成
  // ============================================================
  app.get('/api/connect/commands', { preHandler: requirePermission('node:read') }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const serverUrl = q.serverUrl ?? getSetting('hs.url') ?? '';
    // Headscale 的 server_url 与 API 地址可能不同（API 常走内网），这里允许前端覆写
    const loginServer = q.loginServer ?? serverUrl;
    const key = q.key ?? '';
    const hostname = q.hostname ?? '';
    const tags = (q.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const tagArgs = tags.map((t) => `--advertise-tags=${t}`).join(' ');
    const hostArg = hostname ? `--hostname=${hostname}` : '';
    // --login-server 始终由下面各模板自带（无密钥时它就是唯一能指定控制面的参数）。
    // 这里只在**有预授权密钥**时追加 --authkey。
    //
    // 曾经写成 `key ? '--authkey=' + key : '--login-server=' + loginServer`，
    // 于是无密钥时生成：
    //   tailscale up --login-server=X --login-server=X
    // 参数重复，用户复制执行会失败。authArg 无密钥时必须是空串。
    const authArg = key ? `--authkey=${key}` : '';

    const linuxBringUp = [
      '# 1) 安装 Tailscale（以 Debian/Ubuntu 为例）',
      'curl -fsSL https://tailscale.com/install.sh | sh',
      '# 2) 接入 Headscale',
      `sudo tailscale up --login-server=${loginServer} ${authArg} ${hostArg} ${tagArgs}`.replace(/\s+/g, ' ').trim(),
    ]
      .filter(Boolean)
      .join('\n');

    const windows = [
      '# 下载并安装 Tailscale for Windows 后，在 PowerShell（管理员）执行：',
      `tailscale up --login-server=${loginServer} ${authArg} ${hostArg} ${tagArgs}`.replace(/\s+/g, ' ').trim(),
    ].join('\n');

    const docker = [
      '# 容器内运行（需 --net=host 与 /dev/net/tun）',
      'docker run -d --name=ts-node --restart=unless-stopped \\',
      '  --net=host --cap-add=NET_ADMIN --device=/dev/net/tun \\',
      '  -v /var/lib/tailscale:/var/lib/tailscale \\',
      `  tailscale/tailscale:latest tailscale up --login-server=${loginServer} ${authArg} ${tagArgs}`.replace(/\s+/g, ' ').trim(),
    ].join('\n');

    const sshCmd = hostname
      ? `ssh ${hostname}            # 前提：ACL 中已为你的身份放行 ssh，且对端开启了 tailscale ssh`
      : '# 填写目标设备名后可生成 tailscale SSH 命令';

    return reply.send({
      loginServer,
      hasAuthKey: Boolean(key),
      commands: {
        linux: linuxBringUp,
        windows,
        docker,
        subnetRouter: [
          '# 子网路由（发布内网段，需在「路由管理」里批准）',
          `sudo tailscale up --login-server=${loginServer} ${authArg} --advertise-routes=192.168.0.0/24 ${tagArgs}`.replace(/\s+/g, ' ').trim(),
          '# 执行后会返回 authId，需在面板「设备管理 → 注册设备」中批准后才能加入网络',
        ].join('\n'),
        exitNode: `sudo tailscale up --login-server=${loginServer} ${authArg} --advertise-exit-node`,
        ssh: sshCmd,
        logout: 'sudo tailscale logout && sudo tailscale down',
      },
      notes: [
        key
          ? '已带 --authkey，设备接入后无需浏览器授权，直接生效'
          : '未带 --authkey：设备执行命令后会返回待批 authId，需在「设备管理 → 注册设备」中批准',
        'MINIMUM: Headscale v0.29.x 要求 Tailscale 客户端版本 ≥ v1.80.0',
        'ACL 未放行时，即使设备已接入也无法互访',
      ].filter(Boolean),
    });
  });
}
