/**
 * WebSocket 实时推送中枢。
 *
 * 背景：headscale v0.29.6 **没有任何流式/WebSocket API**（源码已确认），
 * 所以实时性只能由面板自己造：
 *
 *   轮询上游 → 计算差异 → 只把「变化」扇出给浏览器
 *
 * 设计取舍：
 *   - 不扇出全量快照。前端已有首屏数据，全量推送纯属浪费带宽，
 *     在几十台设备时还能忍，上百台就是每 15 秒一次 MB 级传输。
 *   - 每个客户端订阅「主题」（nodes / routes / metrics / audit），
 *     权限在订阅时校验一次，之后按主题过滤推送。
 *   - 服务端只保留一份最新快照，客户端重连后主动拉一次全量对齐。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AuthContext } from '../auth/session.ts';
import { loadSession } from '../auth/session.ts';
import { hs } from '../services/headscale.ts';
import { getBool, getInt } from '../services/settings.ts';
import { isNeverExpiring } from '../routes/nodes.ts';
import { nowIso } from '../util/time.ts';

export type Topic = 'nodes' | 'routes' | 'stats';

export interface WsEvent {
  /** 事件类型：hello | nodes | routes | stats | error | pong */
  type: string;
  /** 服务端时间，便于前端判断数据新鲜度 */
  ts: string;
  /** 本次变化的字段路径（仅用于日志/调试） */
  changed?: string[];
  data?: unknown;
  message?: string;
}

interface Client {
  id: number;
  socket: WebSocket;
  topics: Set<Topic>;
  userId: number;
  username: string;
  /** 是否已完成握手认证 */
  alive: boolean;
  lastPong: number;
}

let clientSeq = 0;
const clients = new Map<number, Client>();

/** 上一次快照，用于计算差异 */
let lastNodes = new Map<number, string>();
let lastRoutes = new Map<string, boolean>();
let lastStats = '';

export function wsClientCount(): number {
  return clients.size;
}

/** 模块内使用的简写 */
function clientCount(): number {
  return clients.size;
}

function send(client: Client, event: WsEvent): void {
  if (client.socket.readyState !== 1) return;
  try {
    client.socket.send(JSON.stringify(event));
  } catch {
    // 发送失败说明连接已坏，交给 close 事件清理
  }
}

/** 按主题广播 */
function broadcast(topic: Topic, event: WsEvent): void {
  for (const c of clients.values()) {
    if (!c.topics.has(topic)) continue;
    send(c, event);
  }
}

/** 用户可见的主题（按权限收敛） */
function topicsFor(ctx: AuthContext): Topic[] {
  const t: Topic[] = [];
  if (ctx.permissions.has('node:read') || ctx.permissions.has('metric:read')) t.push('nodes');
  if (ctx.permissions.has('route:read')) t.push('routes');
  if (ctx.permissions.has('metric:read') || ctx.permissions.has('node:read')) t.push('stats');
  return t;
}

// ============================================================
// 变更检测
// ============================================================

interface NodeLike {
  id: string;
  name: string;
  givenName: string;
  online: boolean;
  ipAddresses?: string[];
  tags?: string[];
  approvedRoutes?: string[];
  availableRoutes?: string[];
  expiry?: string;
  user?: { name: string } | null;
}

/** 把节点压缩成可比较的指纹，只有指纹变了才推送 */
function nodeFingerprint(n: NodeLike): string {
  return [
    n.online ? '1' : '0',
    n.givenName || '',
    (n.ipAddresses ?? []).join(','),
    (n.tags ?? []).join(','),
    (n.approvedRoutes ?? []).join(','),
    (n.availableRoutes ?? []).join(','),
    isNeverExpiring(n.expiry) ? 'never' : String(n.expiry),
    n.user?.name ?? '',
  ].join('|');
}

function shapeForClient(n: NodeLike): Record<string, unknown> {
  const neverExpires = isNeverExpiring(n.expiry);
  return {
    id: Number(n.id),
    name: n.name,
    givenName: n.givenName || '',
    displayName: (n.givenName || '').trim() || n.name,
    online: Boolean(n.online),
    ipAddresses: n.ipAddresses ?? [],
    tags: n.tags ?? [],
    approvedRoutes: n.approvedRoutes ?? [],
    availableRoutes: n.availableRoutes ?? [],
    expiry: neverExpires ? null : n.expiry,
    neverExpires,
    user: n.user ? { name: n.user.name } : null,
  };
}

export interface PollResult {
  nodesTotal: number;
  nodesOnline: number;
  nodeChanges: string[];
  routeChanges: string[];
  pushed: number;
}

/**
 * 执行一次采样：拉上游 → 算差异 → 推送。
 * 同时作为时序采样的数据来源（P4 会在此基础上落 InfluxDB）。
 */
export async function pollOnce(): Promise<PollResult> {
  const nodes = (await hs().listNodes()) as unknown as NodeLike[];

  // ---------- 节点差异 ----------
  const nextNodes = new Map<number, string>();
  const changedNodes: string[] = [];

  for (const n of nodes) {
    const id = Number(n.id);
    const fp = nodeFingerprint(n);
    nextNodes.set(id, fp);
    const prev = lastNodes.get(id);
    if (prev === undefined) changedNodes.push(`${n.name}:新增`);
    else if (prev !== fp) changedNodes.push(`${n.name}:变化`);
  }
  for (const id of lastNodes.keys()) {
    if (!nextNodes.has(id)) changedNodes.push(`#${id}:移除`);
  }

  // ---------- 路由差异 ----------
  const nextRoutes = new Map<string, boolean>();
  const changedRoutes: string[] = [];
  for (const n of nodes) {
    const approved = new Set(n.approvedRoutes ?? []);
    const all = new Set<string>([...(n.availableRoutes ?? []), ...(n.approvedRoutes ?? [])]);
    for (const r of all) {
      const key = `${n.id}|${r}`;
      const on = approved.has(r);
      nextRoutes.set(key, on);
      if (lastRoutes.has(key) && lastRoutes.get(key) !== on) changedRoutes.push(key);
    }
  }

  // ---------- 统计 ----------
  const online = nodes.filter((n) => n.online).length;
  const stats = {
    nodesTotal: nodes.length,
    nodesOnline: online,
    nodesOffline: nodes.length - online,
    routesEnabled: Array.from(nextRoutes.values()).filter(Boolean).length,
    routesAvailable: nextRoutes.size,
    expiringSoon: nodes.filter((n) => {
      if (isNeverExpiring(n.expiry)) return false;
      const t = new Date(n.expiry!).getTime();
      return t > Date.now() && t - Date.now() < 7 * 86400_000;
    }).length,
    expired: nodes.filter((n) => !isNeverExpiring(n.expiry) && new Date(n.expiry!).getTime() <= Date.now()).length,
  };

  const firstRun = lastNodes.size === 0 && lastRoutes.size === 0;
  const statsChanged = JSON.stringify(stats) !== lastStats;

  let pushed = 0;
  const ts = nowIso();

  // 首次采样不算「变化」，但要把当前状态建立起来供前端重连对齐
  if (!firstRun && changedNodes.length > 0) {
    // 只推变化的节点（含详情），避免全量快照
    const delta = nodes
      .filter((n) => {
        const id = Number(n.id);
        const prev = lastNodes.get(id);
        return prev === undefined || prev !== nextNodes.get(id);
      })
      .map(shapeForClient);
    broadcast('nodes', { type: 'nodes.changed', ts, changed: changedNodes, data: { changed: delta } });
    pushed++;
  }

  if (!firstRun && changedRoutes.length > 0) {
    broadcast('routes', {
      type: 'routes.changed',
      ts,
      changed: changedRoutes,
      data: { keys: changedRoutes, routes: Object.fromEntries(nextRoutes) },
    });
    pushed++;
  }

  if (statsChanged) {
    broadcast('stats', { type: 'stats', ts, data: stats });
    pushed++;
  }

  lastNodes = nextNodes;
  lastRoutes = nextRoutes;
  lastStats = JSON.stringify(stats);

  return { nodesTotal: nodes.length, nodesOnline: online, nodeChanges: changedNodes, routeChanges: changedRoutes, pushed };
}

/** 手动通知：写操作后立即让相关客户端刷新，不必等下一个采样周期 */
export function notifyChanged(topic: Topic, type: string, data?: unknown): void {
  broadcast(topic, { type, ts: nowIso(), ...(data === undefined ? {} : { data }) });
}

// ============================================================
// 采样器生命周期
// ============================================================

let timer: NodeJS.Timeout | null = null;

export function startPoller(log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void }): void {
  if (timer) return;
  const enabled = getBool('poll.enabled', true);
  if (!enabled) {
    log.info({}, '状态采样器已关闭（settings: poll.enabled=false）');
    return;
  }
  const intervalSec = getInt('poll.intervalSec', 15);

  const tick = async (): Promise<void> => {
    try {
      const r = await pollOnce();
      if (r.nodeChanges.length > 0 || r.routeChanges.length > 0) {
        log.info(
          { nodes: r.nodesTotal, online: r.nodesOnline, nodeChanges: r.nodeChanges, routeChanges: r.routeChanges },
          '检测到状态变化并已推送',
        );
      }
    } catch (err) {
      // 上游不可达时不能刷屏，降级为 warn 并继续下一轮
      log.warn({ err: err instanceof Error ? err.message : String(err) }, '采样失败，将在下一周期重试');
    }
  };

  void tick();
  timer = setInterval(() => void tick(), intervalSec * 1000);
  timer.unref();
  log.info({ intervalSec, clients: clients.size }, '状态采样器已启动');
}

export function stopPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** 设置变更后重启采样器（间隔可能改了） */
export function restartPoller(log: Parameters<typeof startPoller>[0]): void {
  stopPoller();
  startPoller(log);
}

// ============================================================
// 路由注册
// ============================================================

function extractSessionId(req: FastifyRequest): string {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'hsa_sid') return v.join('=');
  }
  return '';
}

export async function registerRealtimeRoutes(app: FastifyInstance): Promise<void> {
  /** 实时通道状态，供前端与运维排障查看 */
  app.get('/api/realtime/status', async (_req, reply) =>
    reply.send({
      wsClients: clientCount(),
      serverTime: nowIso(),
    }),
  );

  app.get('/api/ws', { websocket: true }, (socket, req) => {
    // 浏览器 WebSocket 无法自定义请求头，只能靠 Cookie 鉴权
    const sid = extractSessionId(req);
    const ctx = sid ? loadSession(sid) : null;

    if (!ctx) {
      try {
        socket.send(JSON.stringify({ type: 'error', ts: nowIso(), message: '未认证' } satisfies WsEvent));
      } catch {
        /* 忽略 */
      }
      socket.close(4401, 'unauthorized');
      return;
    }

    const id = ++clientSeq;
    const client: Client = {
      id,
      socket,
      topics: new Set(topicsFor(ctx)),
      userId: ctx.user.id,
      username: ctx.user.username,
      alive: true,
      lastPong: Date.now(),
    };
    clients.set(id, client);

    req.log.debug({ clientId: id, username: ctx.user.username, topics: [...client.topics] }, 'WebSocket 客户端已连接');

    send(client, {
      type: 'hello',
      ts: nowIso(),
      data: {
        clientId: id,
        topics: [...client.topics],
        pollIntervalSec: getInt('poll.intervalSec', 15),
        stats: lastStats ? (JSON.parse(lastStats) as unknown) : null,
      },
    });

    socket.on('message', (raw: Buffer) => {
      const text = raw.toString().slice(0, 512);
      if (text === 'ping' || text === '"ping"') {
        client.lastPong = Date.now();
        send(client, { type: 'pong', ts: nowIso() });
        return;
      }
      try {
        const msg = JSON.parse(text) as { type?: string };
        if (msg.type === 'ping') {
          client.lastPong = Date.now();
          send(client, { type: 'pong', ts: nowIso() });
        }
      } catch {
        /* 非 JSON 消息直接忽略，不因为脏数据断连 */
      }
    });

    socket.on('pong', () => {
      client.lastPong = Date.now();
    });

    socket.on('close', () => {
      clients.delete(id);
      req.log.debug({ clientId: id }, 'WebSocket 客户端已断开');
    });

    socket.on('error', () => {
      clients.delete(id);
    });
  });

  // 心跳：清理僵死连接，防止 fd 泄漏
  const hb = setInterval(() => {
    const now = Date.now();
    for (const [id, c] of clients) {
      if (now - c.lastPong > 120_000) {
        try {
          c.socket.terminate();
        } catch {
          /* 忽略 */
        }
        clients.delete(id);
        continue;
      }
      try {
        c.socket.ping();
      } catch {
        clients.delete(id);
      }
    }
  }, 30_000);
  hb.unref();
}
