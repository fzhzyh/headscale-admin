/**
 * 鉴权状态（zustand）。
 *
 * 只保存会话与权限；业务数据走 react-query，不在这里堆。
 * CSRF Token 变更时同步注入到 api 层，避免每个调用点都关心它。
 */
import { create } from 'zustand';
import { api, setCsrfToken, setUnauthorizedHandler, type ApiError } from '../api/client';
import type { SessionInfo } from '../api/types';

interface AuthUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isSuperuser: boolean;
  mustChangePassword: boolean;
  totpEnabled: boolean;
}

interface AuthState {
  user: AuthUser | null;
  permissions: Set<string>;
  csrfToken: string;
  /** 首次会话探测是否完成（避免闪一下登录页） */
  ready: boolean;

  bootstrap: () => Promise<void>;
  login: (username: string, password: string) => Promise<{ need2fa: boolean; challengeId?: string }>;
  verify2fa: (challengeId: string, code: string) => Promise<{ warn?: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (perm: string) => boolean;
  /** 有任意一个权限即可 */
  canAny: (...perms: string[]) => boolean;
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  permissions: new Set<string>(),
  csrfToken: '',
  ready: false,

  bootstrap: async () => {
    try {
      const res = await api.get<SessionInfo>('/api/auth/session');
      if (res.authenticated && res.user) {
        setCsrfToken(res.csrfToken ?? '');
        set({
          user: res.user,
          permissions: new Set(res.permissions ?? []),
          csrfToken: res.csrfToken ?? '',
          ready: true,
        });
      } else {
        set({ user: null, permissions: new Set(), csrfToken: '', ready: true });
      }
    } catch {
      set({ user: null, permissions: new Set(), csrfToken: '', ready: true });
    }
  },

  refresh: async () => {
    const res = await api.get<SessionInfo>('/api/auth/session');
    if (res.authenticated && res.user) {
      setCsrfToken(res.csrfToken ?? '');
      set({
        user: res.user,
        permissions: new Set(res.permissions ?? []),
        csrfToken: res.csrfToken ?? '',
        ready: true,
      });
    } else {
      setCsrfToken('');
      set({ user: null, permissions: new Set(), csrfToken: '', ready: true });
    }
  },

  login: async (username, password) => {
    const res = await api.post<{
      need2fa?: boolean;
      challengeId?: string;
      csrfToken?: string;
      mustChangePassword?: boolean;
      user?: { id: number; username: string };
    }>('/api/auth/login', { username, password });

    if (res.need2fa && res.challengeId) {
      return { need2fa: true, challengeId: res.challengeId };
    }
    setCsrfToken(res.csrfToken ?? '');
    await get().refresh();
    return { need2fa: false };
  },

  verify2fa: async (challengeId, code) => {
    const res = await api.post<{ csrfToken?: string; warn?: string }>('/api/auth/2fa', { challengeId, code });
    setCsrfToken(res.csrfToken ?? '');
    await get().refresh();
    return res.warn ? { warn: res.warn } : {};
  },

  logout: async () => {
    try {
      await api.post('/api/auth/logout');
    } catch (err) {
      // 会话已失效时登出报错无需打扰用户
      const e = err as ApiError;
      if (e.status !== 401) throw err;
    }
    setCsrfToken('');
    set({ user: null, permissions: new Set(), csrfToken: '' });
  },

  can: (perm) => get().permissions.has(perm),
  canAny: (...perms) => perms.some((p) => get().permissions.has(p)),
}));

/** 会话失效时自动清空并跳转登录页 */
setUnauthorizedHandler(() => {
  const s = useAuth.getState();
  if (s.user) {
    setCsrfToken('');
    useAuth.setState({ user: null, permissions: new Set(), csrfToken: '' });
  }
});
