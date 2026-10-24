/**
 * Headscale v0.29.x REST API 客户端。
 *
 * 传输层事实（来自 v0.29.6 源码 hscontrol/app.go）：
 *   - grpc-gateway 挂在 headscale 的 listen_addr（HTTP 口）上，路径 /api/v1/*
 *   - 认证：Authorization: Bearer <apikey>，key 前缀必须匹配 headscale 的
 *     AuthPrefix（"Bearer "），校验走 state.ValidateAPIKey
 *   - /api/v1/* 路由被 httpAuthenticationMiddleware 包裹
 *
 * 本客户端只做「薄封装 + 错误归一 + 超时」三件事，不掺业务逻辑，
 * 便于将来 headscale 升版时集中适配。
 */

export class HeadscaleError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HeadscaleError';
  }
}

export interface HeadscaleClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  tlsSkipVerify?: boolean;
}

type Query = Record<string, string | number | boolean | undefined | null>;

/** headscale grpc-gateway 的错误体形如 {code, message, details} */
function parseError(status: number, text: string): { code: string; message: string; body: unknown } {
  let body: unknown = text;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    /* 非 JSON，保留原文 */
  }
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    const message = typeof o.message === 'string' ? o.message : `HTTP ${status}`;
    const code = typeof o.code === 'string' ? o.code : String(o.code ?? status);
    return { code, message, body };
  }
  return { code: String(status), message: text.slice(0, 300) || `HTTP ${status}`, body };
}

function buildQuery(q?: Query): string {
  if (!q) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export class HeadscaleClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private tlsSkipVerify: boolean;

  constructor(opts: HeadscaleClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 10000;
    this.tlsSkipVerify = opts.tlsSkipVerify ?? false;
  }

  /** 运行期更新连接参数（面板「系统设置」改完即时生效） */
  reconfigure(opts: Partial<HeadscaleClientOptions>): void {
    if (opts.baseUrl) this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
    if (opts.timeoutMs) this.timeoutMs = opts.timeoutMs;
    if (opts.tlsSkipVerify !== undefined) this.tlsSkipVerify = opts.tlsSkipVerify;
  }

  get baseAddress(): string {
    return this.baseUrl;
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  /** 底层请求；所有公开方法都经此，便于统一日志与超时 */
  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    if (!this.apiKey) {
      throw new HeadscaleError('未配置 Headscale API Key', 0, 'NO_API_KEY');
    }
    const url = `${this.baseUrl}${path}${buildQuery(opts.query)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    // Node 18+ 的 undici 支持 per-request 关闭证书校验
    const init: RequestInit & { dispatcher?: unknown } = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      signal: ac.signal,
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    if (this.tlsSkipVerify && this.baseUrl.startsWith('https://')) {
      try {
        const { Agent } = (await import('undici')) as { Agent: new (o: object) => unknown };
        (init as { dispatcher?: unknown }).dispatcher = new Agent({
          connect: { rejectUnauthorized: false },
        });
      } catch {
        /* undici 不可用时忽略，退化为默认校验 */
      }
    }

    let res: Response;
    try {
      res = await fetch(url, init as RequestInit);
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) {
        throw new HeadscaleError(`请求 Headscale 超时（${this.timeoutMs}ms）`, 0, 'TIMEOUT');
      }
      throw new HeadscaleError(`无法连接 Headscale：${msg}`, 0, 'UNREACHABLE');
    }
    clearTimeout(timer);

    const text = await res.text();
    if (!res.ok) {
      const { code, message, body } = parseError(res.status, text);
      throw new HeadscaleError(message, res.status, code, body);
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new HeadscaleError('Headscale 返回了非 JSON 响应', res.status, 'BAD_JSON', text.slice(0, 300));
    }
  }

  /** 连通性 + 凭据校验：/api/v1/health 需要有效 key，是最轻量的探活 */
  async health(): Promise<{ databaseConnectivity: boolean }> {
    const r = await this.request<{ databaseConnectivity?: boolean }>('GET', '/api/v1/health');
    return { databaseConnectivity: Boolean(r.databaseConnectivity) };
  }

  // ---------- 用户 ----------
  async listUsers(): Promise<HsUser[]> {
    const r = await this.request<{ users?: HsUser[] }>('GET', '/api/v1/user');
    return r.users ?? [];
  }
  async createUser(input: { name: string; displayName?: string; email?: string; pictureUrl?: string }): Promise<HsUser> {
    const r = await this.request<{ user?: HsUser }>('POST', '/api/v1/user', { body: input });
    return r.user ?? ({} as HsUser);
  }
  async renameUser(oldId: number, newName: string): Promise<HsUser> {
    const r = await this.request<{ user?: HsUser }>(
      'POST',
      `/api/v1/user/${oldId}/rename/${encodeURIComponent(newName)}`,
    );
    return r.user ?? ({} as HsUser);
  }
  async deleteUser(id: number): Promise<void> {
    await this.request('DELETE', `/api/v1/user/${id}`);
  }

  // ---------- 节点 ----------
  async listNodes(user?: string): Promise<HsNode[]> {
    const r = await this.request<{ nodes?: HsNode[] }>('GET', '/api/v1/node', { query: { user } });
    return r.nodes ?? [];
  }
  async getNode(nodeId: number): Promise<HsNode> {
    const r = await this.request<{ node?: HsNode }>('GET', `/api/v1/node/${nodeId}`);
    return r.node ?? ({} as HsNode);
  }
  async deleteNode(nodeId: number): Promise<void> {
    await this.request('DELETE', `/api/v1/node/${nodeId}`);
  }
  async expireNode(nodeId: number, expiry?: Date, disableExpiry?: boolean): Promise<HsNode> {
    // ⚠️ 实测（v0.29.6）：ExpireNode 的 HTTP 注解没有 body:"*"，
    // 请求体会被 grpc-gateway 静默忽略。expiry / disable_expiry 必须走查询参数，
    // 否则无论传什么都会退化成「立即过期」。
    const query: Query = {};
    if (disableExpiry) {
      query['disable_expiry'] = 'true';
    } else if (expiry) {
      query['expiry'] = expiry.toISOString();
    } else {
      // 不传任何参数 = 立即过期
      query['expiry'] = new Date(Date.now() - 1000).toISOString();
    }
    const r = await this.request<{ node?: HsNode }>('POST', `/api/v1/node/${nodeId}/expire`, { query });
    return r.node ?? ({} as HsNode);
  }
  async renameNode(nodeId: number, newName: string): Promise<HsNode> {
    const r = await this.request<{ node?: HsNode }>(
      'POST',
      `/api/v1/node/${nodeId}/rename/${encodeURIComponent(newName)}`,
    );
    return r.node ?? ({} as HsNode);
  }
  async setTags(nodeId: number, tags: string[]): Promise<HsNode> {
    const r = await this.request<{ node?: HsNode }>('POST', `/api/v1/node/${nodeId}/tags`, {
      body: { nodeId: String(nodeId), tags },
    });
    return r.node ?? ({} as HsNode);
  }
  async setApprovedRoutes(nodeId: number, routes: string[]): Promise<HsNode> {
    const r = await this.request<{ node?: HsNode }>('POST', `/api/v1/node/${nodeId}/approve_routes`, {
      body: { nodeId: String(nodeId), routes },
    });
    return r.node ?? ({} as HsNode);
  }
  /**
   * 手动注册节点到指定用户。
   * ⚠️ 实测（v0.29.6）：RegisterNode 的 HTTP 注解没有 body:"*"，
   * 用请求体传 user/key 会被丢弃，且上游会返回极具误导性的
   * 「auth ID has invalid prefix」（因为 key 读成了空串）。必须走查询参数。
   */
  async registerNode(user: string, key: string): Promise<HsNode> {
    const r = await this.request<{ node?: HsNode }>('POST', '/api/v1/node/register', {
      query: { user, key },
    });
    return r.node ?? ({} as HsNode);
  }

  // ---------- 预授权密钥 ----------
  async listPreAuthKeys(): Promise<HsPreAuthKey[]> {
    const r = await this.request<{ preAuthKeys?: HsPreAuthKey[] }>('GET', '/api/v1/preauthkey');
    return r.preAuthKeys ?? [];
  }
  async createPreAuthKey(input: {
    user: number;
    reusable?: boolean;
    ephemeral?: boolean;
    expiration?: Date;
    aclTags?: string[];
  }): Promise<HsPreAuthKey> {
    const r = await this.request<{ preAuthKey?: HsPreAuthKey }>('POST', '/api/v1/preauthkey', {
      body: {
        user: String(input.user),
        reusable: input.reusable ?? false,
        ephemeral: input.ephemeral ?? false,
        ...(input.expiration ? { expiration: input.expiration.toISOString() } : {}),
        aclTags: input.aclTags ?? [],
      },
    });
    return r.preAuthKey ?? ({} as HsPreAuthKey);
  }
  async expirePreAuthKey(id: number): Promise<void> {
    await this.request('POST', '/api/v1/preauthkey/expire', { body: { id: String(id) } });
  }
  async deletePreAuthKey(id: number): Promise<void> {
    // 同样的 body 绑定问题：DeletePreAuthKey 无 body:"*"，id 走查询参数最稳妥
    await this.request('DELETE', '/api/v1/preauthkey', { query: { id } });
  }

  // ---------- API Key ----------
  async listApiKeys(): Promise<HsApiKey[]> {
    const r = await this.request<{ apiKeys?: HsApiKey[] }>('GET', '/api/v1/apikey');
    return r.apiKeys ?? [];
  }
  async createApiKey(expiration?: Date): Promise<string> {
    const r = await this.request<{ apiKey?: string }>('POST', '/api/v1/apikey', {
      body: expiration ? { expiration: expiration.toISOString() } : {},
    });
    return r.apiKey ?? '';
  }
  async expireApiKey(id: number): Promise<void> {
    await this.request('POST', '/api/v1/apikey/expire', { body: { id: String(id) } });
  }
  async deleteApiKey(prefix: string): Promise<void> {
    await this.request('DELETE', `/api/v1/apikey/${encodeURIComponent(prefix)}`);
  }

  // ---------- 策略 / ACL ----------
  /**
   * 读取策略。
   * ⚠️ 实测：数据库模式下若从未设置过策略，headscale 返回 400 code 2
   * 「loading ACL from database: acl policy not found」，而不是空字符串。
   * 这属于正常初始状态，必须归一成空策略交给上层，不能当错误抛。
   */
  async getPolicy(): Promise<{ policy: string; updatedAt?: string }> {
    try {
      const r = await this.request<{ policy?: string; updatedAt?: string }>('GET', '/api/v1/policy');
      return { policy: r.policy ?? '', updatedAt: r.updatedAt };
    } catch (err) {
      if (err instanceof HeadscaleError && /acl policy not found/i.test(err.message)) {
        return { policy: '' };
      }
      throw err;
    }
  }
  async setPolicy(policy: string): Promise<{ policy: string; updatedAt?: string }> {
    const r = await this.request<{ policy?: string; updatedAt?: string }>('PUT', '/api/v1/policy', {
      body: { policy },
    });
    return { policy: r.policy ?? policy, updatedAt: r.updatedAt };
  }
  /** 语法合法性校验。注意：这不是「源→目的访问检查」，v0.29.6 只做语法校验 */
  async checkPolicy(policy: string): Promise<void> {
    await this.request('POST', '/api/v1/policy/check', { body: { policy } });
  }

  // ---------- 认证待批 ----------
  async authRegister(user: string, authId: string): Promise<HsNode> {
    const r = await this.request<{ node?: HsNode }>('POST', '/api/v1/auth/register', {
      body: { user, authId },
    });
    return r.node ?? ({} as HsNode);
  }
  async authApprove(authId: string): Promise<void> {
    await this.request('POST', '/api/v1/auth/approve', { body: { authId } });
  }
  async authReject(authId: string): Promise<void> {
    await this.request('POST', '/api/v1/auth/reject', { body: { authId } });
  }
}

// ============================================================
// Headscale 返回结构（字段与 proto/headscale/v1/*.proto 一一对应）
// ============================================================

export interface HsUser {
  id: string;
  name: string;
  createdAt?: string;
  displayName?: string;
  email?: string;
  providerId?: string;
  provider?: string;
  profilePicUrl?: string;
}

export interface HsPreAuthKey {
  id: string;
  user?: HsUser;
  key: string;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  expiration?: string;
  createdAt?: string;
  aclTags?: string[];
}

export interface HsApiKey {
  id: string;
  prefix: string;
  expiration?: string;
  createdAt?: string;
  lastSeen?: string;
}

/**
 * v0.29.6 的 Node 结构。
 * 破坏性变更提醒：last_successful_update(9)、updated_at(14)、deleted_at(15)、
 * forced_tags(18)、invalid_tags(19)、valid_tags(20) 在 v0.29 已 reserved 移除，
 * 不要依赖这些字段。
 */
export interface HsNode {
  id: string;
  machineKey: string;
  nodeKey: string;
  discoKey: string;
  ipAddresses: string[];
  name: string;
  user?: HsUser;
  lastSeen?: string;
  expiry?: string;
  preAuthKey?: HsPreAuthKey;
  createdAt?: string;
  registerMethod?: string;
  givenName: string;
  online: boolean;
  approvedRoutes: string[];
  availableRoutes: string[];
  subnetRoutes: string[];
  tags: string[];
}
