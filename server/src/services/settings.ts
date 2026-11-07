/**
 * 系统设置服务。
 *
 * 落库的敏感值（Headscale API Key、InfluxDB Token）+ AES-256-GCM 加密。
 * 读取时自动解密；对外 API 一律只回显掩码，绝不回显明文。
 */
import { all, run, get } from '../db/index.ts';
import { secretBox } from '../crypto/box.ts';
import { loadConfig } from '../config.ts';
import { nowIso } from '../util/time.ts';

export interface SettingDef {
  key: string;
  label: string;
  group: 'headscale' | 'dns' | 'influx' | 'poll' | 'ai' | 'system';
  /** 敏感值加密存储且不回显 */
  secret?: boolean;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: string[];
  hint?: string;
  default: string;
}

export const SETTING_DEFS: SettingDef[] = [
  // ---------- Headscale 连接 ----------
  {
    key: 'hs.transport',
    label: '传输方式',
    group: 'headscale',
    type: 'select',
    options: ['rest', 'grpc'],
    hint: 'rest 走 /api/v1/*（推荐）；grpc 走 :50443 长连接',
    default: 'rest',
  },
  {
    key: 'hs.url',
    label: 'Headscale REST API 地址',
    group: 'headscale',
    type: 'string',
    hint: 'headscale 的 listen_addr，例如 https://hs.example.com 或 http://10.0.0.1:18080',
    default: '',
  },
  {
    key: 'hs.grpcAddr',
    label: 'Headscale gRPC 地址',
    group: 'headscale',
    type: 'string',
    hint: 'grpc_listen_addr，例如 10.0.0.1:50443',
    default: '',
  },
  {
    key: 'hs.apiKey',
    label: 'Headscale API Key',
    group: 'headscale',
    type: 'string',
    secret: true,
    hint: '由 `headscale apikeys create` 生成；加密落库，保存后不再回显',
    default: '',
  },
  {
    key: 'hs.tlsSkipVerify',
    label: '跳过 TLS 证书校验',
    group: 'headscale',
    type: 'boolean',
    hint: '自签证书场景可用，生产环境不建议开启',
    default: 'false',
  },
  {
    key: 'hs.timeoutMs',
    label: '请求超时（毫秒）',
    group: 'headscale',
    type: 'number',
    default: '10000',
  },

  // ---------- DNS ----------
  {
    key: 'dns.extraRecordsPath',
    label: 'extra_records 文件路径',
    group: 'dns',
    type: 'string',
    hint: '与 headscale 配置中 dns.extra_records_path 一致；面板写入后 fsnotify 热加载',
    default: '',
  },

  // ---------- 时序库 ----------
  { key: 'influx.url', label: 'InfluxDB 地址', group: 'influx', type: 'string', hint: 'InfluxDB 3.x 的地址，默认端口 8181，例如 http://influxdb:8181', default: '' },
  { key: 'influx.org', label: 'InfluxDB Org（3.x 已弃用）', group: 'influx', type: 'string', hint: '仅 InfluxDB 2.x 需要；3.x 没有 org 概念，此值不参与请求', default: 'headscale' },
  { key: 'influx.bucket', label: 'InfluxDB 数据库名', group: 'influx', type: 'string', hint: '3.x 称 database。不存在时首次写入自动创建', default: 'headscale_admin' },
  { key: 'influx.token', label: 'InfluxDB Token', group: 'influx', type: 'string', secret: true, default: '' },

  // ---------- 采样 ----------
  { key: 'poll.enabled', label: '启用状态采样', group: 'poll', type: 'boolean', default: 'true' },
  {
    key: 'poll.intervalSec',
    label: '采样间隔（秒）',
    group: 'poll',
    type: 'number',
    hint: '决定在线时长统计精度；间隔越小越精确但请求越频繁',
    default: '15',
  },

  // ---------- 系统 ----------
  // ---------- AI 辅助生成 ACL ----------
  // 走 OpenAI 兼容的 /chat/completions，大多数自建与云服务都适配。
  // 未配置时「AI 辅助生成」会返回 501 与配置指引，不会静默失败。
  {
    key: 'ai.baseUrl',
    label: '模型服务地址',
    group: 'ai',
    type: 'string',
    hint: 'OpenAI 兼容接口的 Base URL，例如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1',
    default: '',
  },
  { key: 'ai.apiKey', label: 'API Key', group: 'ai', type: 'string', secret: true, hint: '本地模型服务可留空', default: '' },
  { key: 'ai.model', label: '模型名称', group: 'ai', type: 'string', hint: '例如 gpt-4o-mini、qwen2.5:14b', default: '' },

  { key: 'system.lastSyncAt', label: '最后一次全量同步时间', group: 'system', type: 'string', default: '' },
];

const DEF_MAP = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** 首次启动把环境变量里的引导值写入 settings（数据库为准） */
export function bootstrapSettingsFromEnv(): void {
  const cfg = loadConfig();
  const seeds: Record<string, string> = {
    'hs.transport': cfg.headscale.transport,
    'hs.url': cfg.headscale.url,
    'hs.grpcAddr': cfg.headscale.grpcAddr,
    'hs.apiKey': cfg.headscale.apiKey,
    'hs.tlsSkipVerify': String(cfg.headscale.tlsSkipVerify),
    'hs.timeoutMs': String(cfg.headscale.timeoutMs),
    'dns.extraRecordsPath': cfg.extraRecordsPath,
    'influx.url': cfg.influx.url,
    'influx.org': cfg.influx.org,
    'influx.bucket': cfg.influx.bucket,
    'influx.token': cfg.influx.token,
    'poll.enabled': String(cfg.poll.enabled),
    'poll.intervalSec': String(cfg.poll.intervalSec),
  };
  for (const [key, value] of Object.entries(seeds)) {
    if (value === '') continue;
    const exists = get<{ key: string }>('SELECT key FROM settings WHERE key = ?', key);
    if (!exists) setSetting(key, value);
  }
  // 一体化单容器：headscale 与面板同容器，API Key 由监督器生成/轮换并随卷持久化。
  // 这时 env 才是真源，必须覆盖库里可能残留的旧值 —— 否则只恢复其中一个卷、
  // 或监督器检测到僵尸 key 重建后，面板会一直拿着旧 key 报 401。
  // 只有监督器显式置位才生效，普通部署仍然遵循「env 仅首次引导」的语义。
  if (process.env.HS_API_KEY_MANAGED === '1' && cfg.headscale.apiKey !== '') {
    setSetting('hs.apiKey', cfg.headscale.apiKey);
  }

  // 确保所有定义项都有一行（哪怕空值），便于 UI 渲染
  for (const d of SETTING_DEFS) {
    const exists = get<{ key: string }>('SELECT key FROM settings WHERE key = ?', d.key);
    if (!exists) setSetting(d.key, d.default);
  }
}

/**
 * 设置缓存。
 *
 * settings 表是「写少读极多」的典型：`hs()` 装配一次要读 4 个键
 * （url / apiKey / timeout / tlsSkipVerify），鉴权自检、采样器每轮、
 * 拓扑请求都会触发装配。原来每次都是 1 次 SQL + 可能 1 次 AES-GCM 解密，
 * 属于重复劳动。
 *
 * 这里用「整表缓存 + 任何写入即整体失效」的最简策略：
 * 设置项总量只有几十个，内存开销可忽略；
 * 相比逐键失效，整表失效不可能漏掉某个键，也就不会出现「改了设置但没生效」。
 */
let settingsCache: Map<string, string> | null = null;

function loadSettingsCache(): Map<string, string> {
  if (settingsCache) return settingsCache;
  const map = new Map<string, string>();
  const rows = all<{ key: string; value: string | null; is_encrypted: number }>(
    'SELECT key, value, is_encrypted FROM settings',
  );
  const box = secretBox();
  for (const row of rows) {
    // 解密失败（主密钥换过）时给空串，与「未配置」等价，不抛错
    map.set(row.key, row.is_encrypted ? (box.tryDecrypt(row.value) ?? '') : (row.value ?? ''));
  }
  settingsCache = map;
  return map;
}

/** 让设置缓存失效（所有写入路径都必须调用） */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

export function getSetting(key: string): string {
  const def = DEF_MAP.get(key);
  const map = loadSettingsCache();
  const hit = map.get(key);
  if (hit === undefined) return def?.default ?? '';
  return hit;
}

export function setSetting(key: string, value: string): void {
  const def = DEF_MAP.get(key);
  const encrypt = Boolean(def?.secret) && value !== '';
  const stored = encrypt ? secretBox().encrypt(value) : value;
  run(
    `INSERT INTO settings (key, value, is_encrypted, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    is_encrypted = excluded.is_encrypted,
                                    updated_at = excluded.updated_at`,
    key,
    stored,
    encrypt ? 1 : 0,
    nowIso(),
  );
  // 写后立即更新缓存（若已加载），保证「保存设置马上生效」而不是等下次冷读
  if (settingsCache) settingsCache.set(key, value);
}

/** 敏感值是否已配置（不回显明文） */
export function hasSecret(key: string): boolean {
  return getSetting(key).length > 0;
}

/** 供管理 API 使用：敏感项只返回配置状态与掩码 */
export function describeSettings(): {
  key: string;
  label: string;
  group: string;
  type: string;
  options?: string[];
  hint?: string;
  value: string | null;
  configured: boolean;
}[] {
  return SETTING_DEFS.map((d) => {
    const raw = getSetting(d.key);
    if (d.secret) {
      return {
        key: d.key,
        label: d.label,
        group: d.group,
        type: d.type,
        ...(d.options ? { options: d.options } : {}),
        ...(d.hint ? { hint: d.hint } : {}),
        value: raw ? `${raw.slice(0, 6)}${'•'.repeat(8)}` : null,
        configured: raw.length > 0,
      };
    }
    return {
      key: d.key,
      label: d.label,
      group: d.group,
      type: d.type,
      ...(d.options ? { options: d.options } : {}),
      ...(d.hint ? { hint: d.hint } : {}),
      value: raw,
      configured: raw.length > 0,
    };
  });
}

export function getBool(key: string, fallback = false): boolean {
  const v = getSetting(key).toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function getInt(key: string, fallback: number): number {
  const n = Number(getSetting(key));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function allSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of all<{ key: string }>('SELECT key FROM settings')) {
    out[row.key] = getSetting(row.key);
  }
  return out;
}
