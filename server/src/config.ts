/**
 * 面板配置加载。
 *
 * 优先级：数据库 settings 表（登录后在「系统设置」里改） > 环境变量 > 默认值。
 * 环境变量只负责引导，运行期以数据库为准，这样面板可以自运维 Headscale 连接。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

function env(key: string, fallback = ''): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function envInt(key: string, fallback: number): number {
  const v = Number(env(key, ''));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const v = env(key, '').toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** 读取或生成一个持久化的随机密钥文件（权限 600） */
function loadOrCreateKey(file: string, bytes: number): string {
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= 16) return existing;
  }
  const generated = randomBytes(bytes).toString('base64');
  writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows 等平台可能不支持，忽略 */
  }
  return generated;
}

export interface AppConfig {
  nodeEnv: 'development' | 'production';
  isProd: boolean;
  logLevel: string;

  host: string;
  port: number;
  publicUrl: string;

  dataDir: string;
  dbFile: string;
  masterKey: string;
  sessionSecret: string;
  /** 首次启动生成的初始管理员口令（仅日志可见） */
  bootstrapAdminUser: string;
  bootstrapAdminSecret: string;

  headscale: {
    transport: 'rest' | 'grpc';
    url: string;
    grpcAddr: string;
    apiKey: string;
    tlsSkipVerify: boolean;
    timeoutMs: number;
  };

  extraRecordsPath: string;

  influx: {
    url: string;
    org: string;
    bucket: string;
    token: string;
  };

  poll: {
    enabled: boolean;
    intervalSec: number;
  };

  security: {
    loginMaxFailures: number;
    loginLockoutSec: number;
    sessionTtlSec: number;
    csrfEnabled: boolean;
    cookieSecure: boolean;
  };

  webDist: string;
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;

  const nodeEnv = env('NODE_ENV', 'development') === 'production' ? 'production' : 'development';
  const dataDir = resolve(env('PANEL_DATA_DIR', './data'));
  mkdirSync(dataDir, { recursive: true });

  const publicUrl = env('PANEL_PUBLIC_URL', 'http://127.0.0.1:8080').replace(/\/+$/, '');

  cached = {
    nodeEnv,
    isProd: nodeEnv === 'production',
    logLevel: env('LOG_LEVEL', nodeEnv === 'production' ? 'info' : 'debug'),

    host: env('PANEL_HOST', '127.0.0.1'),
    port: envInt('PANEL_PORT', 8080),
    publicUrl,

    dataDir,
    dbFile: join(dataDir, 'panel.sqlite'),
    masterKey: env('PANEL_MASTER_KEY') || loadOrCreateKey(join(dataDir, 'master.key'), 32),
    sessionSecret: env('PANEL_SESSION_SECRET') || loadOrCreateKey(join(dataDir, 'session.key'), 48),
    bootstrapAdminUser: env('PANEL_ADMIN_USER', 'admin'),
    bootstrapAdminSecret: env('PANEL_ADMIN_SECRET'),

    headscale: {
      transport: env('HS_TRANSPORT', 'rest') === 'grpc' ? 'grpc' : 'rest',
      url: env('HS_URL', 'http://127.0.0.1:18080').replace(/\/+$/, ''),
      grpcAddr: env('HS_GRPC_ADDR', '127.0.0.1:50443'),
      apiKey: env('HS_API_KEY', ''),
      tlsSkipVerify: envBool('HS_TLS_SKIP_VERIFY', false),
      timeoutMs: envInt('HS_TIMEOUT_MS', 10000),
    },

    extraRecordsPath: env('HS_EXTRA_RECORDS_PATH', ''),

    influx: {
      url: env('INFLUX_URL', '').replace(/\/+$/, ''),
      org: env('INFLUX_ORG', 'headscale'),
      bucket: env('INFLUX_BUCKET', 'headscale_admin'),
      token: env('INFLUX_TOKEN', ''),
    },

    poll: {
      enabled: envBool('POLL_ENABLED', true),
      intervalSec: envInt('POLL_INTERVAL_SEC', 15),
    },

    security: {
      loginMaxFailures: envInt('LOGIN_MAX_FAILURES', 5),
      loginLockoutSec: envInt('LOGIN_LOCKOUT_SEC', 900),
      sessionTtlSec: envInt('SESSION_TTL_SEC', 43200),
      csrfEnabled: envBool('CSRF_ENABLED', true),
      // 只有 https 才下发 Secure Cookie，否则本机 http 调试会登录不上
      cookieSecure: publicUrl.startsWith('https://'),
    },

    webDist: resolve(env('WEB_DIST', '../web/dist')),
  };

  return cached;
}

/** 测试用：重置缓存以便重新读取环境变量 */
export function resetConfigCache(): void {
  cached = null;
}
