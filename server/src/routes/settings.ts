/**
 * 系统设置路由：Headscale 连接、DNS 路径、InfluxDB、采样参数。
 *
 * 安全约定：敏感项（API Key / Token）提交后加密落库，读取只回掩码。
 * 提交敏感项时若不填（留空）表示「保持原值不变」，避免误清空。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting, describeSettings, SETTING_DEFS } from '../services/settings.ts';
import { reloadHeadscale, testConnection } from '../services/headscale.ts';
import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', { preHandler: requirePermission('settings:read') }, async (_req, reply) => {
    return reply.send({ items: describeSettings() });
  });

  app.put('/api/settings', { preHandler: requirePermission('settings:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({ items: z.record(z.string(), z.string()) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数格式不正确（需 { items: {key: value} }）' });

    const defMap = new Map(SETTING_DEFS.map((d) => [d.key, d]));
    const changed: string[] = [];
    const skipped: string[] = [];

    for (const [key, rawValue] of Object.entries(parsed.data.items)) {
      const def = defMap.get(key);
      if (!def) {
        skipped.push(key);
        continue;
      }
      const value = typeof rawValue === 'string' ? rawValue.trim() : String(rawValue);
      // 敏感项留空 = 保持原值
      if (def.secret && value === '') {
        skipped.push(key);
        continue;
      }
      if (def.type === 'boolean' && !['true', 'false', '1', '0'].includes(value.toLowerCase())) {
        return reply.code(400).send({ error: 'BAD_INPUT', message: `${def.label} 需为布尔值` });
      }
      if (def.type === 'number' && value !== '' && !Number.isFinite(Number(value))) {
        return reply.code(400).send({ error: 'BAD_INPUT', message: `${def.label} 需为数字` });
      }
      if (def.type === 'select' && def.options && value !== '' && !def.options.includes(value)) {
        return reply.code(400).send({ error: 'BAD_INPUT', message: `${def.label} 取值非法，应为 ${def.options.join(' / ')}` });
      }
      if (def.key === 'hs.url' && value !== '' && !/^https?:\/\//i.test(value)) {
        return reply.code(400).send({ error: 'BAD_INPUT', message: 'Headscale REST API 地址需以 http:// 或 https:// 开头' });
      }

      const before = getSetting(key);
      if (before === value) continue;
      setSetting(key, value);
      changed.push(key);
      audit({
        userId: ctx.user.id,
        username: ctx.user.username,
        ip: req.ip,
        action: 'settings.update',
        targetType: 'setting',
        targetId: key,
        // 敏感项不记录前后值
        detail: def.secret ? { secret: true } : { from: before, to: value },
      });
    }

    // 连接类参数变更后立即生效
    if (changed.some((k) => k.startsWith('hs.'))) {
      reloadHeadscale();
      audit({ userId: ctx.user.id, username: ctx.user.username, ip: req.ip, action: 'settings.reload_headscale', detail: { changed } });
    }

    return reply.send({ ok: true, changed, skipped });
  });

  /** 连接自检：不改配置，只验证当前配置是否可用 */
  app.post('/api/settings/test-connection', { preHandler: requirePermission('settings:read') }, async (req, reply) => {
    const result = await testConnection();
    return reply.send(result);
  });

  /** 单独提交 API Key（便于「先测后存」流程） */
  app.post('/api/settings/headscale-key', { preHandler: requirePermission('settings:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z.object({ apiKey: z.string().min(8, 'API Key 长度不足') }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });

    setSetting('hs.apiKey', parsed.data.apiKey.trim());
    reloadHeadscale();
    const test = await testConnection();
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'settings.set_headscale_key',
      result: test.ok ? 'ok' : 'error',
      detail: { ok: test.ok, errorCode: test.errorCode, prefix: parsed.data.apiKey.slice(0, 10) },
    });
    if (!test.ok) {
      return reply.code(400).send({
        error: 'KEY_REJECTED',
        message: `API Key 已保存，但连通性校验失败：${test.error}`,
        test,
      });
    }
    return reply.send({ ok: true, test });
  });

  /** 面板自身运行信息（不含敏感值） */
  app.get('/api/settings/runtime', { preHandler: requirePermission('settings:read') }, async (_req, reply) => {
    const mem = process.memoryUsage();
    return reply.send({
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      uptimeSec: Math.floor(process.uptime()),
      pid: process.pid,
      memory: {
        rssMB: Math.round(mem.rss / 1048576),
        heapUsedMB: Math.round(mem.heapUsed / 1048576),
      },
      headscale: {
        transport: getSetting('hs.transport'),
        url: getSetting('hs.url'),
        hasApiKey: getSetting('hs.apiKey').length > 0,
      },
    });
  });
}
