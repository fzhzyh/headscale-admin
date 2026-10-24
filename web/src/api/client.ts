/**
 * API 客户端。
 *
 * 约定：
 *   - 同源请求，会话靠 httpOnly Cookie，前端拿不到也不需要拿
 *   - 所有写操作自动带 X-CSRF-Token（从 auth store 取）
 *   - 错误统一抛 ApiError，带上后端给的 error 码与中文 message，
 *     让 UI 可以直接展示有意义的信息而不是「请求失败」
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** CSRF Token 由 auth store 注入，避免 api 层依赖 React */
let csrfToken = '';
export function setCsrfToken(t: string): void {
  csrfToken = t;
}

/** 401 时的回调（由 auth store 注册，触发跳登录页） */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  /** 查询参数，undefined/null/'' 会被自动剔除 */
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** 写操作默认自动带 CSRF，只读接口可关闭 */
  csrf?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const base = import.meta.env.VITE_API_BASE ?? '';
  let url = `${base}${path}`;
  if (!query) return url;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  if (s) url += (url.includes('?') ? '&' : '?') + s;
  return url;
}

async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const isWrite = method !== 'GET';
  const wantCsrf = opts.csrf ?? isWrite;

  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (wantCsrf && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method,
      headers,
      credentials: 'same-origin',
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK', `无法连接面板服务：${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const body = (parsed ?? {}) as { error?: string; message?: string };
    // 401 交给上层处理（会话过期），但 401 也可能是登录接口本身的错误
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/2fa')) {
      onUnauthorized?.();
    }
    throw new ApiError(res.status, body.error ?? `HTTP_${res.status}`, body.message ?? `请求失败（${res.status}）`, parsed);
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>('GET', path, { query }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>('POST', path, { body: body ?? {}, query }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, { body }),
};

/** 把任意异常转成可展示的中文文案 */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    // 上游错误带上原始状态码，排障时有用
    if (err.code.startsWith('HEADSCALE_') && err.body) {
      const b = err.body as { upstreamStatus?: number };
      return `${err.message}（Headscale 返回 ${b.upstreamStatus ?? '?'}）`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
