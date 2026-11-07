/**
 * 上游读缓存（共享 + 单飞）。
 *
 * ## 要解决的问题
 * 同一次「看板刷新」里，面板会并发发出：
 *   - 采样器每 15s 的 `listNodes()`（实时推送）
 *   - 拓扑页 30s 的 `listNodes()` + `listUsers()` + `getPolicy()`
 *   - 设备页、路由页各自的 `listNodes()` / `listUsers()`
 * 每个浏览器标签都独立打一遍。3 个标签 + 采样器 = 同一秒内 6+ 次完全相同的上游请求。
 * headscale 的 REST 是每请求开一次 TCP + TLS + 反序列化整张节点表，
 * 在几十台设备时这只是浪费，在几百台设备时就是实打实的延迟与内存峰值。
 *
 * ## 做法
 * 1. **单飞（single-flight）**：同一份数据同一时刻只允许一个在途请求，
 *    其余调用方等同一个 Promise。这是比 TTL 更重要的部分——它消灭的是**并发重复**，
 *    而不是「稍微旧一点的数据」。
 * 2. **短 TTL**：默认 2 秒。足够把一次页面加载里的多个查询合并，
 *    又短到不影响「运维点了保存后看结果」的体感。
 * 3. **写操作自动失效**：缓存条目记着取数时的 `writeEpoch`，
 *    任何上游写操作成功都会推进纪元，于是缓存自然失效。
 *    这比在每个写路由里手工调 invalidate 可靠得多（漏一个就是脏数据）。
 *
 * ## 边界（必须诚实告知）
 * 缓存只影响**读**。写操作永远是直连上游，绝不排队、绝不合并。
 * 若上游 headscale 本身被别处（CLI / 另一个面板）改过，
 * 这里最多陈旧 2 秒——与手动点「刷新」的差距在这个量级可以接受。
 */
import type { HsApiKey, HsNode, HsUser } from '../headscale/client.ts';

/** 策略读取结果（与 HeadscaleClient.getPolicy 的返回形状一致） */
export interface HsPolicy {
  policy: string;
  updatedAt?: string;
}
import { currentWriteEpoch } from '../headscale/client.ts';
import { hs } from './headscale.ts';

/** 默认 TTL：足够合并一次页面加载里的并发查询，又不影响体感 */
const DEFAULT_TTL_MS = 2_000;

interface Entry<T> {
  /** 取数时刻 */
  at: number;
  /** 取数时的写纪元；纪元变化即视为失效 */
  epoch: number;
  value: T;
}

interface Cell<T> {
  entry: Entry<T> | null;
  /** 在途请求（单飞用） */
  inflight: Promise<T> | null;
}

function cell<T>(): Cell<T> {
  return { entry: null, inflight: null };
}

const nodesCell = cell<HsNode[]>();
const usersCell = cell<HsUser[]>();
const policyCell = cell<HsPolicy>();
const apiKeysCell = cell<HsApiKey[]>();

/** 命中判定：纪元未变 且 在 TTL 内 */
function fresh<T>(e: Entry<T>, ttlMs: number, now: number): boolean {
  return e.epoch === currentWriteEpoch() && now - e.at <= ttlMs;
}

/**
 * 通用的「读并缓存」执行器。
 * @param force 忽略缓存（例如采样器希望拿到尽可能新的数据时可用）
 */
async function readThrough<T>(c: Cell<T>, ttlMs: number, force: boolean, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  if (!force && c.entry && fresh(c.entry, ttlMs, now)) return c.entry.value;
  // 单飞：已有在途请求就等它，不再发新请求
  if (c.inflight) return c.inflight;

  const epoch = currentWriteEpoch();
  const p = load()
    .then((value) => {
      c.entry = { at: Date.now(), epoch, value };
      return value;
    })
    .finally(() => {
      c.inflight = null;
    });
  c.inflight = p;
  return p;
}

/** 节点列表（可选按上游用户过滤；带过滤的走独立缓存键，避免串味） */
const nodesByUser = new Map<string, Cell<HsNode[]>>();

export function cachedNodes(opts: { user?: string; ttlMs?: number; force?: boolean } = {}): Promise<HsNode[]> {
  const { user, ttlMs = DEFAULT_TTL_MS, force = false } = opts;
  if (user) {
    let c = nodesByUser.get(user);
    if (!c) {
      c = cell<HsNode[]>();
      nodesByUser.set(user, c);
    }
    return readThrough(c, ttlMs, force, () => hs().listNodes(user));
  }
  return readThrough(nodesCell, ttlMs, force, () => hs().listNodes());
}

export function cachedUsers(opts: { ttlMs?: number; force?: boolean } = {}): Promise<HsUser[]> {
  const { ttlMs = DEFAULT_TTL_MS, force = false } = opts;
  return readThrough(usersCell, ttlMs, force, () => hs().listUsers());
}

/**
 * 当前策略。
 *
 * 注意：`getPolicy()` 在上游「从未设置过策略」时返回 400（正常初始状态），
 * 客户端已把它归一成空策略；缓存的是归一后的结果，不要在这里再判断一次。
 */
export function cachedPolicy(opts: { ttlMs?: number; force?: boolean } = {}): Promise<HsPolicy> {
  const { ttlMs = DEFAULT_TTL_MS, force = false } = opts;
  return readThrough(policyCell, ttlMs, force, () => hs().getPolicy());
}

export function cachedApiKeys(opts: { ttlMs?: number; force?: boolean } = {}): Promise<HsApiKey[]> {
  const { ttlMs = DEFAULT_TTL_MS, force = false } = opts;
  return readThrough(apiKeysCell, ttlMs, force, () => hs().listApiKeys());
}

/** 手工清空（例如改完 Headscale 连接参数后） */
export function clearUpstreamCache(): void {
  nodesCell.entry = null;
  usersCell.entry = null;
  policyCell.entry = null;
  apiKeysCell.entry = null;
  nodesByUser.clear();
}

/** 观测用：缓存当前状态（便于 /api/system/overview 暴露「是否有在途请求」） */
export function upstreamCacheStats(): {
  nodes: { cached: boolean; ageMs: number | null; inflight: boolean };
  users: { cached: boolean; ageMs: number | null; inflight: boolean };
} {
  const now = Date.now();
  const describe = <T,>(c: Cell<T>) => ({
    cached: Boolean(c.entry),
    ageMs: c.entry ? now - c.entry.at : null,
    inflight: Boolean(c.inflight),
  });
  return { nodes: describe(nodesCell), users: describe(usersCell) };
}
