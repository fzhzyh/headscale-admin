/**
 * 路由鉴权守卫。
 *
 * 单独成模块的原因：app.ts 需要 import 路由模块，若守卫写在 app.ts 里
 * 会形成 ESM 循环依赖。守卫必须独立。
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { AuthContext } from './session.ts';
import type { Permission } from './rbac.ts';

/** 取当前会话；未登录直接回 401 并返回 null */
export function authOr401(req: FastifyRequest, reply: FastifyReply): AuthContext | null {
  const ctx = req.auth;
  if (!ctx) {
    void reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录或会话已失效' });
    return null;
  }
  return ctx;
}

/** 声明式权限要求，配合 preHandler 使用 */
export function requirePermission(perm: Permission | Permission[]) {
  const need = Array.isArray(perm) ? perm : [perm];
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = req.auth;
    if (!ctx) {
      await reply.code(401).send({ error: 'UNAUTHORIZED', message: '未登录' });
      return;
    }
    const missing = need.filter((p) => !ctx.permissions.has(p));
    if (missing.length > 0) {
      await reply.code(403).send({ error: 'FORBIDDEN', message: `缺少权限：${missing.join(', ')}` });
    }
  };
}

/** 写操作的 CSRF 校验，返回 false 表示已回包，调用方应直接 return */
export function csrfOk(req: FastifyRequest, reply: FastifyReply): boolean {
  const ctx = req.auth;
  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!ctx || !token || ctx.csrfToken !== token) {
    void reply.code(403).send({ error: 'BAD_CSRF', message: 'CSRF 校验失败，请刷新页面重试' });
    return false;
  }
  return true;
}
