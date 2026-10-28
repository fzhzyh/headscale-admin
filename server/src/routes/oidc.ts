/**
 * 内置 OIDC Provider 路由
 *
 * 目的：让 headscale 把面板当认证源（`oidc.issuer` 指向本面板），
 * 实现「一套账号管所有服务」。
 *
 * ## 端点
 *   GET  /.well-known/openid-configuration   — 发现文档
 *   GET  /oidc/jwks                          — 公钥集
 *   GET  /oidc/authorize                     — 授权端点（需已登录面板）
 *   POST /oidc/token                         — 换 token（code / refresh_token）
 *   GET  /oidc/userinfo                      — 用户信息
 *   GET  /oidc/logout                        — 结束会话（前端页）
 *   —— 管理 ——
 *   GET/POST/PUT/DELETE /api/oidc/clients    — 客户端管理
 *   POST /api/oidc/clients/:id/rotate        — 轮换 client_secret
 *   GET  /api/oidc/keys                      — 签名密钥列表
 *   POST /api/oidc/keys/rotate               — 轮换签名密钥
 *
 * ## 关键安全设计
 *
 * 1. **授权端点必须先有面板会话**
 *    `/oidc/authorize` 不在 PUBLIC_PATHS 里，走面板的会话闸门。
 *    没登录就 302 到面板登录页并带 `next` 回跳——不是返回 401，
 *    那样浏览器里会看到一段 JSON，用户无从操作。
 *
 * 2. **PKCE 强制**（S256 优先）
 *    授权码是 bearer 凭据，走 query 会进浏览器历史与代理日志。
 *    PKCE 让「截到 code 但没 verifier」也换不到 token。
 *    public client 必须 PKCE；confidential client 也建议。
 *
 * 3. **授权码一次性**
 *    `consumed_at` 非空即视为已用。重复用同一个 code 一律 400
 *    （RFC 6749 要求，也防重放）。
 *
 * 4. **redirect_uri 精确匹配**
 *    不做前缀匹配、不做通配。开放重定向是 OIDC 最经典的漏洞，
 *    一个 `redirect_uri=https://evil.com` 就能把 code 送出去。
 *
 * 5. **code 有效期 60s，token 10 分钟**
 *    授权码只在「授权→换 token」这一跳存在，没必要给长；
 *    ID Token 短有效期 + refresh token 续期是标准做法。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { loadSession } from '../auth/session.ts';
import { hashPassword, verifyPassword } from '../auth/secrets.ts';
import { all, get, run } from '../db/index.ts';
import { audit } from '../services/audit.ts';
import { nowIso } from '../util/time.ts';
import { jwks, listKeys, rotateKey, signIdToken, selfVerify } from '../oidc/keys.ts';
import { secretBox } from '../crypto/box.ts';

// ---------------------------------------------------------------- 常量
const CODE_TTL_SEC = 60;
const ID_TOKEN_TTL_SEC = 600;
const ACCESS_TOKEN_TTL_SEC = 3600;
const REFRESH_TTL_SEC = 30 * 86400;

// ---------------------------------------------------------------- 行形状
interface ClientRow {
  id: number;
  client_id: string;
  client_secret_hash: string | null;
  name: string;
  redirect_uris: string;
  post_logout_uris: string | null;
  scopes: string;
  grant_types: string;
  is_public: number;
  require_pkce: number;
  enabled: number;
  secret_prefix: string | null;
  secret_rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CodeRow {
  code: string;
  client_id: string;
  user_id: number;
  redirect_uri: string;
  scope: string;
  nonce: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  auth_time: string;
  expires_at: string;
  consumed_at: string | null;
}

interface RefreshRow {
  token: string;
  client_id: string;
  user_id: number;
  scope: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

function jsonArr(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function shapeClient(c: ClientRow) {
  return {
    id: c.id,
    clientId: c.client_id,
    name: c.name,
    redirectUris: jsonArr(c.redirect_uris),
    postLogoutUris: jsonArr(c.post_logout_uris),
    scopes: jsonArr(c.scopes),
    grantTypes: jsonArr(c.grant_types),
    isPublic: c.is_public === 1,
    requirePkce: c.require_pkce === 1,
    enabled: c.enabled === 1,
    /** 只回显前缀，绝不回显 secret 本体 */
    secretPrefix: c.secret_prefix,
    secretRotatedAt: c.secret_rotated_at,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/** 面板对外地址：OIDC 的 issuer 必须与调用方看到的地址一致，否则 iss 校验失败 */
function issuerOf(req: FastifyRequest): string {
  const cfgUrl = process.env.PANEL_PUBLIC_URL?.trim();
  if (cfgUrl) return cfgUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0] ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

function token(): string {
  return randomBytes(32).toString('base64url');
}

/** PKCE S256：BASE64URL(SHA256(verifier)) */
function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeEqStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function registerOidcRoutes(app: FastifyInstance): Promise<void> {
  // ============================================================
  // 发现文档
  // ============================================================
  app.get('/.well-known/openid-configuration', async (req, reply) => {
    const iss = issuerOf(req);
    return reply.send({
      issuer: iss,
      authorization_endpoint: `${iss}/oidc/authorize`,
      token_endpoint: `${iss}/oidc/token`,
      userinfo_endpoint: `${iss}/oidc/userinfo`,
      jwks_uri: `${iss}/oidc/jwks`,
      end_session_endpoint: `${iss}/oidc/logout`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'profile', 'email', 'groups'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      code_challenge_methods_supported: ['S256', 'plain'],
      claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'preferred_username', 'name', 'email', 'groups'],
    });
  });

  // ============================================================
  // JWKS
  // ============================================================
  app.get('/oidc/jwks', async (_req, reply) => {
    // 公钥集本来就要公开，且可能被频繁拉取，允许缓存
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.send(await jwks());
  });

  // ============================================================
  // 授权端点
  // ============================================================
  app.get('/oidc/authorize', async (req, reply) => {
    const q = z
      .object({
        response_type: z.string(),
        client_id: z.string().min(1),
        redirect_uri: z.string().min(1),
        scope: z.string().default('openid'),
        state: z.string().optional(),
        nonce: z.string().optional(),
        code_challenge: z.string().optional(),
        code_challenge_method: z.string().optional(),
        prompt: z.string().optional(),
      })
      .safeParse(req.query);

    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_request', error_description: '缺少必要参数' });
    }
    const p = q.data;

    if (p.response_type !== 'code') {
      return reply.code(400).send({ error: 'unsupported_response_type', error_description: '仅支持 code' });
    }

    const client = get<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', p.client_id);
    if (!client || client.enabled !== 1) {
      return reply.code(400).send({ error: 'invalid_client', error_description: '客户端不存在或已禁用' });
    }

    // redirect_uri 必须**精确匹配**，杜绝开放重定向
    const allowed = jsonArr(client.redirect_uris);
    if (!allowed.includes(p.redirect_uri)) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'redirect_uri 未在该客户端登记',
      });
    }

    // 必须有面板会话；没有就跳登录页（带 next 回跳）
    const sid = req.cookies['hsa_sid'];
    const session = sid ? loadSession(sid) : null;
    if (!session) {
      const back = req.raw.url ?? '/';
      return reply.redirect(`/login?next=${encodeURIComponent(back)}`);
    }

    // PKCE：public client 必须带；confidential 也建议带
    const needPkce = client.is_public === 1 || client.require_pkce === 1;
    if (needPkce && !p.code_challenge) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: '该客户端要求 PKCE（code_challenge）',
      });
    }
    if (p.code_challenge && p.code_challenge_method && !['S256', 'plain'].includes(p.code_challenge_method)) {
      return reply.code(400).send({
        error: 'invalid_request',
        error_description: 'code_challenge_method 仅支持 S256 / plain',
      });
    }

    const scopes = p.scope.split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) {
      return reply.code(400).send({ error: 'invalid_scope', error_description: '必须包含 openid' });
    }

    // 发码
    const code = token();
    const now = Date.now();
    run(
      `INSERT INTO oauth_auth_codes
         (code, client_id, user_id, redirect_uri, scope, nonce, code_challenge, code_challenge_method, auth_time, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      client.client_id,
      session.user.id,
      p.redirect_uri,
      scopes.join(' '),
      p.nonce ?? null,
      p.code_challenge ?? null,
      p.code_challenge_method ?? (p.code_challenge ? 'plain' : null),
      nowIso(),
      new Date(now + CODE_TTL_SEC * 1000).toISOString(),
    );

    audit({
      userId: session.user.id,
      username: session.user.username,
      ip: req.ip,
      action: 'oidc.authorize',
      targetType: 'oauth_client',
      targetId: client.client_id,
      result: 'ok',
      detail: { scope: scopes.join(' '), pkce: Boolean(p.code_challenge) },
    });

    const url = new URL(p.redirect_uri);
    url.searchParams.set('code', code);
    if (p.state) url.searchParams.set('state', p.state);
    return reply.redirect(url.toString());
  });

  // ============================================================
  // 换 token
  // ============================================================
  app.post('/oidc/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    // client_secret_basic 支持
    let basicId: string | undefined;
    let basicSecret: string | undefined;
    const authz = req.headers.authorization;
    if (authz?.startsWith('Basic ')) {
      const decoded = Buffer.from(authz.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        basicId = decodeURIComponent(decoded.slice(0, idx));
        basicSecret = decodeURIComponent(decoded.slice(idx + 1));
      }
    }

    const grantType = String(body.grant_type ?? '');
    const clientId = basicId ?? String(body.client_id ?? '');

    const client = get<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
    if (!client || client.enabled !== 1) {
      return reply.code(401).send({ error: 'invalid_client', error_description: '客户端不存在或已禁用' });
    }

    // confidential client 必须带 secret
    if (client.is_public !== 1) {
      const provided = basicSecret ?? String(body.client_secret ?? '');
      if (!provided) {
        return reply.code(401).send({ error: 'invalid_client', error_description: '缺少 client_secret' });
      }
      if (!client.client_secret_hash || !verifyPassword(provided, client.client_secret_hash)) {
        return reply.code(401).send({ error: 'invalid_client', error_description: 'client_secret 不正确' });
      }
    }

    const iss = issuerOf(req);
    const userRow = (userId: number) => get<{
      id: number; username: string; display_name: string | null; email: string | null;
    }>('SELECT id, username, display_name, email FROM panel_users WHERE id = ?', userId);

    const groupsOf = (userId: number): string[] =>
      all<{ name: string }>(
        `SELECT g.name AS name FROM panel_groups g
           JOIN panel_user_groups ug ON ug.group_id = g.id
          WHERE ug.user_id = ? ORDER BY g.name`,
        userId,
      ).map((r) => r.name);

    const issueTokens = async (userId: number, scope: string, nonce: string | null) => {
      const u = userRow(userId);
      if (!u) return null;
      const idToken = await signIdToken(
        {
          sub: String(u.id),
          aud: client.client_id,
          iss,
          preferred_username: u.username,
          ...(u.display_name ? { name: u.display_name } : {}),
          email: u.email,
          groups: groupsOf(u.id),
          auth_time: Math.floor(Date.now() / 1000),
          nonce,
        },
        ID_TOKEN_TTL_SEC,
      );
      // 签发即自验：把格式问题挡在面板侧，避免下游排查跨系统
      const verified = await selfVerify(idToken, iss, client.client_id);
      if (!verified) throw new Error('ID Token 自验失败');
      return { idToken, user: u };
    };

    // ---------------------------------------------------------- authorization_code
    if (grantType === 'authorization_code') {
      const code = String(body.code ?? '');
      const redirectUri = String(body.redirect_uri ?? '');
      if (!code || !redirectUri) {
        return reply.code(400).send({ error: 'invalid_request', error_description: '缺少 code 或 redirect_uri' });
      }

      const row = get<CodeRow>('SELECT * FROM oauth_auth_codes WHERE code = ?', code);
      if (!row) return reply.code(400).send({ error: 'invalid_grant', error_description: '授权码不存在' });
      if (row.client_id !== client.client_id) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: '授权码不属于该客户端' });
      }
      // 一次性：已消费的码不可重放
      if (row.consumed_at) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: '授权码已被使用' });
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: '授权码已过期' });
      }
      if (row.redirect_uri !== redirectUri) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'redirect_uri 与授权时不一致' });
      }

      // PKCE 校验
      if (row.code_challenge) {
        const verifier = String(body.code_verifier ?? '');
        if (!verifier) {
          return reply.code(400).send({ error: 'invalid_grant', error_description: '缺少 code_verifier' });
        }
        const expected = row.code_challenge_method === 'S256' ? pkceS256(verifier) : verifier;
        if (!safeEqStr(expected, row.code_challenge)) {
          return reply.code(400).send({ error: 'invalid_grant', error_description: 'code_verifier 不匹配' });
        }
      } else if (client.is_public === 1 || client.require_pkce === 1) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: '该客户端要求 PKCE' });
      }

      // 标记已消费（同一事务语义：先标记，再发 token）
      run('UPDATE oauth_auth_codes SET consumed_at = ? WHERE code = ?', nowIso(), code);

      const issued = await issueTokens(row.user_id, row.scope, row.nonce);
      if (!issued) return reply.code(400).send({ error: 'invalid_grant', error_description: '用户不存在' });

      const refresh = token();
      run(
        `INSERT INTO oauth_refresh_tokens (token, client_id, user_id, scope, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        refresh,
        client.client_id,
        row.user_id,
        row.scope,
        nowIso(),
        new Date(Date.now() + REFRESH_TTL_SEC * 1000).toISOString(),
      );

      return reply.send({
        access_token: refresh, // 简化为与 refresh 同值：面板不校验 access_token 的细粒度权限
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SEC,
        id_token: issued.idToken,
        refresh_token: refresh,
        scope: row.scope,
      });
    }

    // ---------------------------------------------------------- refresh_token
    if (grantType === 'refresh_token') {
      const rt = String(body.refresh_token ?? '');
      if (!rt) return reply.code(400).send({ error: 'invalid_request', error_description: '缺少 refresh_token' });

      const row = get<RefreshRow>('SELECT * FROM oauth_refresh_tokens WHERE token = ?', rt);
      if (!row) return reply.code(400).send({ error: 'invalid_grant', error_description: 'refresh_token 不存在' });
      if (row.client_id !== client.client_id) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'refresh_token 不属于该客户端' });
      }
      if (row.revoked_at) return reply.code(400).send({ error: 'invalid_grant', error_description: 'refresh_token 已撤销' });
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        return reply.code(400).send({ error: 'invalid_grant', error_description: 'refresh_token 已过期' });
      }

      const issued = await issueTokens(row.user_id, row.scope, null);
      if (!issued) return reply.code(400).send({ error: 'invalid_grant', error_description: '用户不存在' });

      return reply.send({
        access_token: rt,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SEC,
        id_token: issued.idToken,
        refresh_token: rt,
        scope: row.scope,
      });
    }

    return reply.code(400).send({ error: 'unsupported_grant_type', error_description: `不支持 ${grantType}` });
  });

  // ============================================================
  // UserInfo
  // ============================================================
  app.get('/oidc/userinfo', async (req, reply) => {
    const authz = req.headers.authorization;
    if (!authz?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'invalid_token', error_description: '缺少 Bearer token' });
    }
    const rt = authz.slice(7);
    const row = get<RefreshRow>('SELECT * FROM oauth_refresh_tokens WHERE token = ?', rt);
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) {
      return reply.code(401).send({ error: 'invalid_token', error_description: 'token 无效或已过期' });
    }
    const u = get<{ id: number; username: string; display_name: string | null; email: string | null }>(
      'SELECT id, username, display_name, email FROM panel_users WHERE id = ?',
      row.user_id,
    );
    if (!u) return reply.code(401).send({ error: 'invalid_token', error_description: '用户不存在' });

    return reply.send({
      sub: String(u.id),
      preferred_username: u.username,
      ...(u.display_name ? { name: u.display_name } : {}),
      ...(u.email ? { email: u.email } : {}),
      groups: all<{ name: string }>(
        `SELECT g.name AS name FROM panel_groups g
           JOIN panel_user_groups ug ON ug.group_id = g.id
          WHERE ug.user_id = ? ORDER BY g.name`,
        u.id,
      ).map((r) => r.name),
    });
  });

  // ============================================================
  // 登出（简单实现：清面板会话）
  // ============================================================
  app.get('/oidc/logout', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const sid = req.cookies['hsa_sid'];
    if (sid) {
      run('DELETE FROM sessions WHERE id = ?', sid);
      reply.clearCookie('hsa_sid', { path: '/' });
    }
    const target = q.post_logout_redirect_uri;
    if (target) {
      // 只允许登记过的回跳地址，防开放重定向
      const anyClient = all<ClientRow>('SELECT * FROM oauth_clients WHERE enabled = 1');
      const allowed = anyClient.flatMap((c) => jsonArr(c.post_logout_uris));
      if (allowed.includes(target)) return reply.redirect(target);
    }
    return reply.redirect('/login');
  });

  // ============================================================
  // 管理：客户端
  // ============================================================
  app.get('/api/oidc/clients', { preHandler: requirePermission('oidc:read') }, async (_req, reply) => {
    const rows = all<ClientRow>('SELECT * FROM oauth_clients ORDER BY created_at DESC');
    return reply.send({ clients: rows.map(shapeClient) });
  });

  app.post('/api/oidc/clients', { preHandler: requirePermission('oidc:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z
      .object({
        name: z.string().min(1).max(100),
        redirectUris: z.array(z.string().min(1)).min(1).max(20),
        postLogoutUris: z.array(z.string().min(1)).max(20).optional(),
        scopes: z.array(z.string()).min(1).optional(),
        isPublic: z.boolean().default(false),
        requirePkce: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    // redirect_uri 必须是绝对 URL
    for (const u of parsed.data.redirectUris) {
      try {
        const parsedUrl = new URL(u);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('protocol');
      } catch {
        return reply.code(400).send({ error: 'BAD_REDIRECT_URI', message: `redirect_uri 必须是绝对 http(s) URL：${u}` });
      }
    }

    const clientId = `oidc_${randomBytes(8).toString('hex')}`;
    const secret = parsed.data.isPublic ? null : `oidcs_${randomBytes(24).toString('base64url')}`;
    const now = nowIso();

    run(
      `INSERT INTO oauth_clients
         (client_id, client_secret_hash, name, redirect_uris, post_logout_uris, scopes, grant_types,
          is_public, require_pkce, enabled, secret_prefix, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      clientId,
      secret ? hashPassword(secret) : null,
      parsed.data.name,
      JSON.stringify(parsed.data.redirectUris),
      JSON.stringify(parsed.data.postLogoutUris ?? []),
      JSON.stringify(parsed.data.scopes ?? ['openid', 'profile', 'email', 'groups']),
      JSON.stringify(['authorization_code', 'refresh_token']),
      parsed.data.isPublic ? 1 : 0,
      parsed.data.requirePkce ? 1 : 0,
      secret ? `${secret.slice(0, 10)}…` : null,
      now,
      now,
    );

    const row = get<ClientRow>('SELECT * FROM oauth_clients WHERE client_id = ?', clientId);
    audit({
      userId: ctx.user.id, username: ctx.user.username, ip: req.ip,
      action: 'oidc.client.create', targetType: 'oauth_client', targetId: clientId, result: 'ok',
      detail: { name: parsed.data.name, isPublic: parsed.data.isPublic },
    });

    return reply.code(201).send({
      client: row ? shapeClient(row) : null,
      /** secret 只在此刻返回一次，之后只能看到前缀 */
      clientSecret: secret,
      note: secret ? 'client_secret 只显示这一次，请立即保存' : 'public client 无 secret，依赖 PKCE',
    });
  });

  app.put('/api/oidc/clients/:id', { preHandler: requirePermission('oidc:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    const existing = get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '客户端不存在' });

    const parsed = z
      .object({
        name: z.string().min(1).max(100).optional(),
        redirectUris: z.array(z.string().min(1)).min(1).max(20).optional(),
        postLogoutUris: z.array(z.string().min(1)).max(20).optional(),
        scopes: z.array(z.string()).min(1).optional(),
        requirePkce: z.boolean().optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }
    const d = parsed.data;
    if (d.redirectUris) {
      for (const u of d.redirectUris) {
        try {
          const pu = new URL(u);
          if (!['http:', 'https:'].includes(pu.protocol)) throw new Error('protocol');
        } catch {
          return reply.code(400).send({ error: 'BAD_REDIRECT_URI', message: `redirect_uri 非法：${u}` });
        }
      }
    }

    run(
      `UPDATE oauth_clients SET
         name = COALESCE(?, name),
         redirect_uris = COALESCE(?, redirect_uris),
         post_logout_uris = COALESCE(?, post_logout_uris),
         scopes = COALESCE(?, scopes),
         require_pkce = COALESCE(?, require_pkce),
         enabled = COALESCE(?, enabled),
         updated_at = ?
       WHERE id = ?`,
      d.name ?? null,
      d.redirectUris ? JSON.stringify(d.redirectUris) : null,
      d.postLogoutUris ? JSON.stringify(d.postLogoutUris) : null,
      d.scopes ? JSON.stringify(d.scopes) : null,
      d.requirePkce === undefined ? null : d.requirePkce ? 1 : 0,
      d.enabled === undefined ? null : d.enabled ? 1 : 0,
      nowIso(),
      id,
    );

    const row = get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id);
    audit({
      userId: ctx.user.id, username: ctx.user.username, ip: req.ip,
      action: 'oidc.client.update', targetType: 'oauth_client', targetId: existing.client_id, result: 'ok',
      detail: { changed: Object.keys(d) },
    });
    return reply.send({ client: row ? shapeClient(row) : null });
  });

  app.post('/api/oidc/clients/:id/rotate', { preHandler: requirePermission('oidc:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    const existing = get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '客户端不存在' });
    if (existing.is_public === 1) {
      return reply.code(400).send({
        error: 'NO_SECRET',
        message: 'public client 没有 secret，靠 PKCE 保护；如需 secret 请先改为 confidential',
      });
    }

    const secret = `oidcs_${randomBytes(24).toString('base64url')}`;
    run(
      'UPDATE oauth_clients SET client_secret_hash = ?, secret_prefix = ?, secret_rotated_at = ?, updated_at = ? WHERE id = ?',
      hashPassword(secret),
      `${secret.slice(0, 10)}…`,
      nowIso(),
      nowIso(),
      id,
    );

    audit({
      userId: ctx.user.id, username: ctx.user.username, ip: req.ip,
      action: 'oidc.client.rotate', targetType: 'oauth_client', targetId: existing.client_id, result: 'ok',
      detail: {},
    });
    return reply.send({ clientSecret: secret, note: '旧 secret 立即失效，请更新下游配置' });
  });

  app.delete('/api/oidc/clients/:id', { preHandler: requirePermission('oidc:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    const existing = get<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '客户端不存在' });

    run('DELETE FROM oauth_clients WHERE id = ?', id);
    audit({
      userId: ctx.user.id, username: ctx.user.username, ip: req.ip,
      action: 'oidc.client.delete', targetType: 'oauth_client', targetId: existing.client_id, result: 'ok',
      detail: {},
    });
    return reply.send({ ok: true });
  });

  // ============================================================
  // 管理：签名密钥
  // ============================================================
  app.get('/api/oidc/keys', { preHandler: requirePermission('oidc:read') }, async (req, reply) => {
    const iss = issuerOf(req);
    return reply.send({
      keys: listKeys(),
      jwksUri: `${iss}/oidc/jwks`,
      issuer: iss,
      /** headscale 侧对接所需的三项 */
      headscaleConfig: {
        issuer: iss,
        client_id: '<在下方客户端列表里创建后填入>',
        note: 'headscale 配置项：oidc.issuer / oidc.client_id / oidc.client_secret',
      },
    });
  });

  app.post('/api/oidc/keys/rotate', { preHandler: requirePermission('oidc:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z.object({ retireOld: z.boolean().default(false) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const r = await rotateKey(parsed.data.retireOld);
    audit({
      userId: ctx.user.id, username: ctx.user.username, ip: req.ip,
      action: 'oidc.key.rotate', targetType: 'oidc_key', targetId: r.kid, result: 'ok',
      detail: { retireOld: parsed.data.retireOld, retired: r.retired },
    });

    return reply.send({
      kid: r.kid,
      retired: r.retired,
      note: parsed.data.retireOld
        ? '旧密钥已退役：已签发的 ID Token 将立即验签失败，请确认没有在线会话'
        : '新密钥已用于签发，旧密钥仍在 JWKS 中继续验签（推荐）',
    });
  });
}
