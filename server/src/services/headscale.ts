/**
 * Headscale 客户端装配层。
 *
 * 连接参数来自 settings 表（数据库为准），改完「系统设置」立即生效。
 * 不缓存连接对象，只缓存 HeadscaleClient 实例并在参数变更时 reconfigure。
 */
import { HeadscaleClient, HeadscaleError } from '../headscale/client.ts';
import { getSetting, getBool, getInt, setSetting } from './settings.ts';
import { nowIso } from '../util/time.ts';

let client: HeadscaleClient | null = null;

function build(): HeadscaleClient {
  return new HeadscaleClient({
    baseUrl: getSetting('hs.url') || 'http://127.0.0.1:18080',
    apiKey: getSetting('hs.apiKey'),
    timeoutMs: getInt('hs.timeoutMs', 10000),
    tlsSkipVerify: getBool('hs.tlsSkipVerify', false),
  });
}

export function hs(): HeadscaleClient {
  if (!client) client = build();
  return client;
}

/** 设置变更后调用，让新参数立即生效 */
export function reloadHeadscale(): void {
  const next = build();
  if (client) client.reconfigure({
    baseUrl: next.baseAddress,
    apiKey: getSetting('hs.apiKey'),
    timeoutMs: getInt('hs.timeoutMs', 10000),
    tlsSkipVerify: getBool('hs.tlsSkipVerify', false),
  });
  else client = next;
}

export interface ConnectionTestResult {
  ok: boolean;
  transport: string;
  address: string;
  hasApiKey: boolean;
  databaseConnectivity?: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  checkedAt: string;
  /** 附加诊断信息，便于排障 */
  diagnosis?: string[];
}

/**
 * 连通性自检。
 * 用 /api/v1/health 探活——该端点同样经过 API Key 校验，
 * 因此能一次性验证「网络可达 + Key 有效 + 数据库正常」三件事。
 */
export async function testConnection(): Promise<ConnectionTestResult> {
  const c = hs();
  const transport = getSetting('hs.transport') || 'rest';
  const address = transport === 'grpc' ? getSetting('hs.grpcAddr') : c.baseAddress;
  const base: ConnectionTestResult = {
    ok: false,
    transport,
    address,
    hasApiKey: c.hasApiKey(),
    checkedAt: nowIso(),
  };

  if (!base.hasApiKey) {
    return { ...base, errorCode: 'NO_API_KEY', error: '尚未配置 Headscale API Key', diagnosis: ['在「系统设置 → Headscale 连接」粘贴 API Key'] };
  }

  const t0 = Date.now();
  try {
    const r = await c.health();
    const diag: string[] = [];
    if (!r.databaseConnectivity) diag.push('Headscale 自身报告数据库连接异常');
    if (transport === 'grpc') diag.push('当前选择 gRPC 传输，但本面板实际通过 REST /api/v1 校验，gRPC 仅作参数留存');
    return {
      ...base,
      ok: true,
      databaseConnectivity: r.databaseConnectivity,
      latencyMs: Date.now() - t0,
      ...(diag.length ? { diagnosis: diag } : {}),
    };
  } catch (err) {
    const e = err as HeadscaleError;
    const diag: string[] = [];
    switch (e.code) {
      case 'TIMEOUT':
        diag.push('检查网络/防火墙，headscale 的 listen_addr 是否对面板可达');
        break;
      case 'UNREACHABLE':
        diag.push('地址或端口不可达，确认 hs.url 是否为 headscale 的 listen_addr（不是 grpc_listen_addr）');
        break;
      default:
        if (e.status === 401) diag.push('API Key 无效或已过期，重新执行 headscale apikeys create');
        else if (e.status === 404) diag.push('/api/v1/health 返回 404，确认 headscale 版本 >= 0.26（本面板面向 v0.29.x）');
        else if (e.status >= 500) diag.push('Headscale 服务端异常，查看 headscale 日志');
    }
    return {
      ...base,
      error: e.message,
      errorCode: e.code || String(e.status),
      latencyMs: Date.now() - t0,
      ...(diag.length ? { diagnosis: diag } : {}),
    };
  }
}

export { HeadscaleError };
