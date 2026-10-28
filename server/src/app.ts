/**
 * Fastify 应用装配。
 *
 * 分层：plugins(横切) → routes(业务) → errorHandler(归一)。
 * 所有 /api/* 走 Cookie 会话鉴权；/api/auth/* 部分接口豁免。
 */
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from './config.ts';
import { loggerOptions } from './logger.ts';
import { openDb } from './db/index.ts';
import { migrate } from './db/migrate.ts';
import { seedBootstrap } from './db/seed.ts';
import { bootstrapSettingsFromEnv } from './services/settings.ts';
import { HeadscaleError } from './headscale/client.ts';
import { loadSession, type AuthContext } from './auth/session.ts';
import type { Permission } from './auth/rbac.ts';

import { registerAuthRoutes } from './routes/auth.ts';
import { registerNodeRoutes } from './routes/nodes.ts';
import { registerUserRoutes } from './routes/users.ts';
import { registerKeyRoutes } from './routes/keys.ts';
import { registerRouteRoutes } from './routes/routes.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerSystemRoutes } from './routes/system.ts';
import { registerAclRoutes } from './routes/acl.ts';
import { registerStatsRoutes } from './routes/stats.ts';
import { recordRequest } from './services/metrics.ts';
import { registerTopologyRoutes } from './routes/topology.ts';
import { registerResourceRoutes } from './routes/resources.ts';
import { registerAiRoutes } from './routes/ai.ts';
import { registerRealtimeRoutes } from './realtime/hub.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/2fa',
  '/api/auth/session',
  '/api/auth/bootstrap',
  '/api/system/health',
  '/api/system/version',
  '/api/oidc/.well-known/openid-configuration',
  /**
   * WebSocket 交给 hub 自己鉴权。
   * 原因：若在升级前返回 HTTP 401，浏览器只会看到 onclose code 1006，
   * 前端无法区分「会话过期」与「网络抖动」，会无限重连。
   * 让连接升级后由服务端主动 close(4401)，前端就能识别并停止重连、跳登录页。
   */
  '/api/ws',
]);

function isPublic(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  // OIDC Provider 端点与外部 OIDC 回调不带面板会话
  return path.startsWith('/api/oidc/');
}

export async function buildApp(): Promise<FastifyInstance> {
  const cfg = loadConfig();
  openDb(cfg.dbFile);
  migrate({ quiet: true });
  await seedBootstrap();
  bootstrapSettingsFromEnv();

  const app = Fastify({
    logger: loggerOptions(),
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024, // ACL 策略文件可能较大
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 300,
    timeWindow: '1 minute',
  });
  await app.register(websocket);

  // ---------- 鉴权：解析会话，写 req.auth ----------
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.auth = null;
    const sid = req.cookies['hsa_sid'];
    if (!sid) return;
    req.auth = loadSession(sid);
  });

  // ---------- 鉴权闸门 ----------
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.raw.url?.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/')) return; // 静态资源放行
    if (isPublic(path)) return;
    if (!req.auth) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或会话已失效' });
    }
    // 强制改密时只允许访问账号接口
    if (req.auth.user.must_change_pwd === 1 && !path.startsWith('/api/auth/')) {
      return reply.code(403).send({ error: 'MUST_CHANGE_PASSWORD', message: '请先修改初始口令' });
    }
  });

  // ---------- 面板自身指标：记录请求量/错误率/延迟 ----------
  // 放在鉴权闸门之后注册，保证 401/403 也被统计到（排障时最需要看这类）。
  // `reply.elapsedTime` 是 Fastify 自己测的毫秒数，比自己掐表更贴近真实耗时。
  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.raw.url?.split('?')[0] ?? req.url;
    // 静态资源不统计：一次页面加载会带出几十个文件，会把 rpm 冲得没有意义
    if (!path.startsWith('/api/')) return;
    recordRequest(req.method, path, reply.statusCode, reply.elapsedTime ?? 0);
  });

  // ---------- 统一错误出口 ----------
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };

    if (e instanceof HeadscaleError) {
      const hsErr = e as HeadscaleError;
      // 上游错误映射：401/403 说明 API Key 或权限问题，0 表示连不上（502）
      const status = hsErr.status === 0 ? 502 : hsErr.status;
      req.log.warn({ scope: 'headscale', code: hsErr.code, status: hsErr.status, msg: hsErr.message }, '上游返回错误');
      return reply.code(status).send({
        error: `HEADSCALE_${hsErr.code}`,
        message: hsErr.message,
        upstreamStatus: hsErr.status,
      });
    }

    const status = e.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, '未处理的服务端错误');
      return reply.code(status).send({ error: 'INTERNAL', message: '服务端内部错误，请查看面板日志' });
    }
    return reply.code(status).send({ error: e.code ?? 'BAD_REQUEST', message: e.message });
  });

  app.setNotFoundHandler((req, reply) => {
    const url = (req.raw.url ?? '').split('?')[0] ?? '';
    if (url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `接口不存在：${req.url}` });
    }
    // ⚠️ 关键：带扩展名的路径（.js/.css/.png…）必须真的 404，不能回退到 index.html。
    // 否则前端重建后旧哈希资源的请求会拿到 index.html（200 + text/html），
    // 浏览器把它当 JS 解析失败 → 整页白屏，且极难定位。
    if (/\.[a-zA-Z0-9]{1,8}$/.test(url)) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: `静态资源不存在：${url}` });
    }
    // 其余路径按 SPA history 回退
    const index = join(cfg.webDist, 'index.html');
    if (existsSync(index)) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'NOT_FOUND', message: '前端资源未构建（请先 npm run build:web）' });
  });

  // ---------- 业务路由 ----------
  await registerSystemRoutes(app);
  await registerAuthRoutes(app);
  await registerNodeRoutes(app);
  await registerUserRoutes(app);
  await registerKeyRoutes(app);
  await registerRouteRoutes(app);
  await registerSettingsRoutes(app);
  await registerAclRoutes(app);
  await registerStatsRoutes(app);
  await registerTopologyRoutes(app);
  await registerResourceRoutes(app);
  await registerAiRoutes(app);
  // WebSocket 实时推送（必须最后注册，避免与静态资源/SPA 回退冲突）
  await registerRealtimeRoutes(app);

  // ---------- 前端静态资源 ----------
  if (existsSync(cfg.webDist)) {
    // ⚠️ 必须用 wildcard: true（默认）且 index 保持默认 true。
    // wildcard: false 会在**启动时**枚举文件注册路由，前端重新构建后文件名哈希变化，
    // 新资源不在注册表里 → 全部落到 SPA 回退返回 index.html → 浏览器当 JS 解析 → 白屏。
    // index: false 则会让根路径 / 返回 403。
    await app.register(fastifyStatic, { root: cfg.webDist, prefix: '/' });
  }

  return app;
}
