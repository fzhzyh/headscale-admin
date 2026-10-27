/**
 * 面板配置加载。
 *
 * 优先级：数据库 settings 表（登录后在「系统设置」里改） > 环境变量 > 默认值。
 * 环境变量只负责引导，运行期以数据库为准，这样面板可以自运维 Headscale 连接。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/**
 * 本模块所在目录（编译前后都能用）。
 *
 * ⚠️ 为什么默认路径不能基于 `process.cwd()`：
 * 容器里 WORKDIR=/app、入口是 `node server/dist/index.js`，
 * `resolve('../web/dist')` 会算成 /web/dist（少了 /app 前缀），
 * 于是面板首页 404、提示「前端资源未构建」——而文件其实好好的在 /app/web/dist。
 * 本地之所以没暴露，是因为 npm workspace 会把 cwd 设成 server/，恰好算对。
 *
 * 改为相对「模块自身位置」解析，本地 / 容器 / 任意启动目录都正确。
 *
 * 注：本注释里不要写连续的双星号加斜杠——那会提前闭合块注释。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
/** 从 server/{src,dist}/ 回到仓库根，再进 web/dist */
const DEFAULT_WEB_DIST = resolve(MODULE_DIR, '..', '..', 'web', 'dist');

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
    /**
     * 登录接口的**总尝试**限流（不只失败次数）。
     * 生产默认 20 次/5 分钟；联调环境会把窗口放宽，
     * 否则多个测试套件连续登录会撞 429（实测踩到：7 个套件 + 手动探测 > 20 次）。
     */
    loginRateMax: number;
    loginRateWindowSec: number;
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
      loginRateMax: envInt('LOGIN_RATE_MAX', 20),
      loginRateWindowSec: envInt('LOGIN_RATE_WINDOW_SEC', 300),
      sessionTtlSec: envInt('SESSION_TTL_SEC', 43200),
      csrfEnabled: envBool('CSRF_ENABLED', true),
      // 只有 https 才下发 Secure Cookie，否则本机 http 调试会登录不上
      cookieSecure: publicUrl.startsWith('https://'),
    },

    // 默认相对模块位置（见文件头说明）；WEB_DIST 仍可显式覆盖
    webDist: env('WEB_DIST') ? resolve(env('WEB_DIST')) : DEFAULT_WEB_DIST,
  };

  return cached;
}

/** 测试用：重置缓存以便重新读取环境变量 */
export function resetConfigCache(): void {
  cached = null;
}
