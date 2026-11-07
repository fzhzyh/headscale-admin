/**
 * ACL 访问检查求值引擎。
 *
 * headscale **不提供**「A 能否访问 B」的查询能力（`/api/v1/policy/check`
 * 只做语法与语义校验），所以这个引擎是面板自研的核心能力。
 *
 * 语义逐条对齐 headscale v0.29.6：
 *   - 别名解析顺序：alias.ts（对齐 types.go:1064 parseAlias）
 *   - 访问判定：node.go:406 canAccess —— src 可以是「节点自身 IP」或「其已批准的
 *     子网路由」；dst 可以是「对端 IP」「对端已批准的子网路由」，或（对端是出口
 *     节点时）「the internet」
 *   - 全通/全禁：model.ts interpretPolicy（对齐 policy.go:253 的 nil 判断）
 */

import { parseAlias, splitDestAndPort, parsePortRange, parseProtocol, portMatches } from './alias.ts';
import { interpretPolicy, type AclPolicy, type PolicyInterpretation, type PolicyMode } from './model.ts';

/**
 * 惰性 trace 写入器。
 *
 * 只把 `trace.push` 换成空操作是不够的：模板字符串在**调用前**就已经拼好并分配了，
 * 静默 trace 只是没把结果存进数组而已。批量求值（拓扑要对上万对跑）时，
 * 这里省下的是每对每条规则的中文说明 + `JSON.stringify(rule)`。
 * 传入 thunk，只有真需要 trace 时才求值字符串。
 */
type TraceWriter = (make: () => string) => void;
const NO_TRACE: TraceWriter = () => {};

/** 参与求值的节点视图（来自 /api/v1/node 的归一化结果） */
export interface EvalNode {
  id: number;
  /** 客户端上报的主机名 */
  name: string;
  /** 面板/CLI 设置的名字，优先用于展示与 hosts 匹配 */
  displayName: string;
  ips: string[];
  tags: string[];
  userName: string | null;
  /** 已批准的子网路由（作为 src/dst 身份之一） */
  approvedRoutes: string[];
  /** 是否为出口节点（0.0.0.0/0 或 ::/0 已批准） */
  isExitNode: boolean;
}

export interface EvalInput {
  policy: AclPolicy | null;
  nodes: EvalNode[];
  /** 已知的 Headscale 用户列表，用于 group: 与 user@ 解析 */
  users: { id: number; name: string; email?: string | null }[];
}

/**
 * 单次求值会话的缓存。
 *
 * ## 为什么需要
 * 访问检查本身是单对求值，但**拓扑页要做 O(N²) 对**，每对都会把
 * 「某用户/某标签/某组名下有哪些节点」重新 filter 一遍。
 * N=50 时这是 2450 对 × (规则数 × 别名数) 次全表扫描 + 集合重建。
 *
 * 这些结果在**同一次请求内**是完全不变的（策略、节点、用户都固定），
 * 所以按 (别名, 视角用户, src/dst) 记住即可，跨对复用。
 *
 * ## 边界
 * - 只在单次请求内有效，由调用方创建；不跨请求共享，
 *   这样策略一变就不可能有脏数据（无失效逻辑 = 无失效 bug）
 * - 缓存里的 ResolvedSet 一律视为**只读**，调用方不得修改
 * - 容量随「节点数 × 规则别名数」增长，天然有界
 */
export interface EvalCache {
  /** 别名解析结果：`S|D` + viewerUser + token → 集合 */
  alias: Map<string, ResolvedSet>;
  /** 主体（源/目的节点）构造结果，避免每对重复解析路由 */
  subjects: Map<string, Subject | { error: string }>;
  /** 节点集合查询：用户名/标签/是否打标签 → 节点数组 */
  nodeSets: Map<string, EvalNode[]>;
  /** 策略解释：同一次请求里 policy 不变，interpretPolicy 只需跑一次 */
  interpretation?: PolicyInterpretation;
}

export function createEvalCache(): EvalCache {
  return { alias: new Map(), subjects: new Map(), nodeSets: new Map() };
}

/**
 * 取「满足条件的节点」并缓存。
 * key 由调用方给（如 `user:labadmin` / `tag:tag:db`），保证不同维度不会撞键。
 */
function nodesMatching(nodes: EvalNode[], cache: EvalCache | undefined, key: string, pred: (n: EvalNode) => boolean): EvalNode[] {
  if (!cache) return nodes.filter(pred);
  const hit = cache.nodeSets.get(key);
  if (hit) return hit;
  const val = nodes.filter(pred);
  cache.nodeSets.set(key, val);
  return val;
}

export interface AccessCheckRequest {
  /** 源：节点 ID，或 { cidr } / { user } / { tag } 形式的虚拟主体 */
  from: { nodeId: number } | { cidr: string } | { user: string } | { tag: string };
  /** 目的：节点 ID、CIDR，或 { internet: true } */
  to: { nodeId: number } | { cidr: string } | { internet: true };
  /** 端口（可选）。不填则只判断是否存在任意放行规则 */
  port?: number;
  /** 协议（可选），默认 tcp */
  proto?: string;
}

export interface MatchedRule {
  index: number;
  rule: string;
  matchedSrc: string;
  matchedDst: string;
}

export interface AccessCheckResult {
  allowed: boolean;
  /** 结论依据：命中规则 / 默认全通 / 默认拒绝 */
  reason: 'matched-rule' | 'allow-all-default' | 'deny-all-default' | 'no-matching-rule';
  mode: PolicyMode;
  /** 命中的规则（可能多条） */
  matched: MatchedRule[];
  /** 人类可读的解释 */
  explanation: string;
  /** 求值过程的关键步骤，用于排障与「为什么不通」 */
  trace: string[];
  /** 请求本身是否非法（如引用了不存在的节点） */
  error?: string;
}

// ============================================================
// IP / CIDR 工具
// ============================================================

function ipToBigInt(ip: string): bigint | null {
  const cached = _ipMemo.get(ip);
  if (cached !== undefined) return cached;
  return memoSet(_ipMemo, ip, ipToBigIntUncached(ip));
}

function ipToBigIntUncached(ip: string): bigint | null {
  if (ip.includes(':')) {
    // 简化 IPv6 处理：展开为 128 位
    const expanded = expandV6(ip);
    if (!expanded) return null;
    return BigInt(`0x${expanded}`);
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

function expandV6(ip: string): string | null {
  const zone = ip.indexOf('%');
  const clean = zone >= 0 ? ip.slice(0, zone) : ip;
  const dbl = clean.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [...head, ...Array(dbl.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

interface Cidr {
  base: bigint;
  bits: number;
  isV6: boolean;
}

/**
 * IP / CIDR 解析记忆化。
 *
 * 求值是纯函数且**输入高度重复**：同一条规则里的同一个 CIDR，
 * 会在每一对节点求值时被重新解析一次；拓扑的 O(N²) 循环里
 * 同一个 CIDR 可能被解析上万次，每次都做 BigInt 位移与正则。
 *
 * 加缓存后这块成本从「每对每规则」降到「进程内一次」。
 * 失败结果（null）也缓存——非法 CIDR 同样会被反复命中，
 * 缓存它能避免重复走失败分支。
 * 容量上限防止恶意/畸形策略把内存撑爆。
 */
const PARSE_CACHE_MAX = 4096;
const _cidrMemo = new Map<string, Cidr | null>();
const _ipMemo = new Map<string, bigint | null>();

/** 有界记忆化：满了直接清空（缓存只是加速，清空不影响正确性） */
function memoSet<T>(m: Map<string, T>, k: string, v: T): T {
  if (m.size >= PARSE_CACHE_MAX) m.clear();
  m.set(k, v);
  return v;
}

function parseCidr(s: string): Cidr | null {
  const cached = _cidrMemo.get(s);
  if (cached !== undefined) return cached;
  return memoSet(_cidrMemo, s, parseCidrUncached(s));
}

function parseCidrUncached(s: string): Cidr | null {
  const m = /^(.+?)\/(\d{1,3})$/.exec(s);
  const addr = m ? m[1]! : s;
  const isV6 = addr.includes(':');
  const bits = m ? Number(m[2]) : isV6 ? 128 : 32;
  if (isV6 && (bits < 0 || bits > 128)) return null;
  if (!isV6 && (bits < 0 || bits > 32)) return null;
  const n = ipToBigInt(addr);
  if (n === null) return null;
  return { base: n, bits, isV6 };
}

/**
 * 掩码缓存：按 (isV6, 前缀长度) 只构造一次。
 *
 * 掩码是 BigInt 位移的结果，每次比较都重算两个大整数移位在 O(N²×规则)
 * 的拓扑求值里是可观的纯开销。掩码只依赖位宽，与具体地址无关 —— 天然可缓存。
 */
const _maskMemo = new Map<string, bigint>();
function netMask(isV6: boolean, bits: number): bigint {
  const key = isV6 ? `6:${bits}` : `4:${bits}`;
  const hit = _maskMemo.get(key);
  if (hit !== undefined) return hit;
  const total = isV6 ? 128 : 32;
  const shift = BigInt(total - bits);
  const mask = shift === 0n ? ~0n : ((1n << BigInt(total)) - 1n) ^ ((1n << shift) - 1n);
  if (_maskMemo.size > 512) _maskMemo.clear();
  _maskMemo.set(key, mask);
  return mask;
}

/** 某 IP 是否落在 CIDR 内 */
function ipInCidr(ip: string, cidr: Cidr): boolean {
  const n = ipToBigInt(ip);
  if (n === null) return false;
  if (ip.includes(':') !== cidr.isV6) return false;
  const mask = netMask(cidr.isV6, cidr.bits);
  return (n & mask) === (cidr.base & mask);
}

/** 两个 CIDR 是否有交集（取较短前缀的掩码对齐即可） */
function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  if (a.isV6 !== b.isV6) return false;
  const mask = netMask(a.isV6, Math.min(a.bits, b.bits));
  return (a.base & mask) === (b.base & mask);
}

/** 通配 `*` 与 autogroup:danger-all 视为覆盖全部地址 */
function cidrIsEverything(c: Cidr): boolean {
  return c.bits === 0;
}

// ============================================================
// 别名 → IP / CIDR 集合 解析
// ============================================================

interface ResolvedSet {
  /** 具体 IP（含节点自身 IP） */
  ips: Set<string>;
  /** CIDR 前缀（子网路由、hosts 条目、字面 CIDR） */
  cidrs: Cidr[];
  /**
   * 是否代表「全部地址」。
   * ⚠️ 只由 `*` 与 autogroup:danger-all 触发。
   * **不能**由字面 `0.0.0.0/0` 触发——那是出口节点的路由，语义是「互联网」，
   * 与「所有地址」是不同维度（headscale 的 canAccess 里 DestsIsTheInternet
   * 是独立分支）。曾因把出口路由当 everything 导致「任何源都命中」的误判。
   */
  everything: boolean;
  /**
   * 是否为 autogroup:internet。
   * 仅在作为 dst、且目标是出口节点时才算命中，不能退化为 everything。
   */
  internet: boolean;
  /** 是否需要按节点上下文解析（autogroup:self） */
  selfScoped: boolean;
  /** 解析过程中的提示/警告 */
  notes: string[];
  /** 引用了不存在的实体 */
  unresolved: string[];
}

function emptySet(): ResolvedSet {
  return {
    ips: new Set(),
    cidrs: [],
    everything: false,
    internet: false,
    selfScoped: false,
    notes: [],
    unresolved: [],
  };
}

/** 出口路由（0.0.0.0/0、::/0）不参与普通 CIDR 匹配，单独由 isExitNode 表达 */
function isDefaultRoute(prefix: string): boolean {
  return prefix === '0.0.0.0/0' || prefix === '::/0';
}

/**
 * 把单个别名解析为地址集合。
 *
 * @param viewerUser 当别名为 autogroup:self 时，用于限定「同一用户名下的设备」
 * @param asSource   作为 src（true）还是 dst（false）解析，影响 autogroup 语义
 */
function resolveAlias(
  token: string,
  policy: AclPolicy | null,
  nodes: EvalNode[],
  users: { id: number; name: string; email?: string | null }[],
  viewerUser: string | null,
  asSource: boolean,
  cache?: EvalCache,
): ResolvedSet {
  // 记忆化：同一请求内同一个别名的解析结果完全不变
  if (cache) {
    const key = `${asSource ? 'S' : 'D'}|${viewerUser ?? ''}|${token}`;
    const hit = cache.alias.get(key);
    if (hit) return hit;
    const fresh = resolveAliasUncached(token, policy, nodes, users, viewerUser, asSource, cache);
    cache.alias.set(key, fresh);
    return fresh;
  }
  return resolveAliasUncached(token, policy, nodes, users, viewerUser, asSource, undefined);
}

function resolveAliasUncached(
  token: string,
  policy: AclPolicy | null,
  nodes: EvalNode[],
  users: { id: number; name: string; email?: string | null }[],
  viewerUser: string | null,
  asSource: boolean,
  cache?: EvalCache,
): ResolvedSet {
  const out = emptySet();
  const parsed = parseAlias(token);
  if (!parsed) {
    out.unresolved.push(token);
    return out;
  }

  switch (parsed.kind) {
    case 'wildcard': {
      out.everything = true;
      out.notes.push('`*` 表示整个 tailnet 内的地址');
      return out;
    }

    case 'prefix': {
      const c = parseCidr(parsed.value);
      if (!c) {
        out.unresolved.push(token);
        return out;
      }
      out.cidrs.push(c);
      return out;
    }

    case 'host': {
      const hostValue = policy?.hosts?.[parsed.value];
      if (hostValue === undefined) {
        out.unresolved.push(token);
        out.notes.push(`hosts 中未定义 "${parsed.value}"`);
        return out;
      }
      // hosts 条目本身可能是 CIDR、IP，或指向另一个别名
      const inner = parseAlias(hostValue);
      if (!inner) {
        out.unresolved.push(`${token} → ${hostValue}`);
        return out;
      }
      if (inner.kind === 'prefix' || inner.kind === 'wildcard') {
        const c = inner.kind === 'wildcard' ? null : parseCidr(inner.value);
        if (inner.kind === 'wildcard') out.everything = true;
        else if (c) out.cidrs.push(c);
        out.notes.push(`hosts["${parsed.value}"] = ${hostValue}`);
        return out;
      }
      // hosts 指向 tag / user / group 等身份别名：递归解析
      const sub = resolveAlias(hostValue, policy, nodes, users, viewerUser, asSource, cache);
      out.ips = sub.ips;
      out.cidrs = sub.cidrs;
      out.everything = sub.everything;
      out.internet = sub.internet;
      out.unresolved.push(...sub.unresolved);
      out.notes.push(`hosts["${parsed.value}"] → ${hostValue}`);
      out.notes.push(...sub.notes);
      return out;
    }

    case 'username': {
      const name = parsed.value.replace(/@$/, '');
      const user = users.find((u) => u.name === name || (u.email ?? '') === name);
      if (!user) {
        // headscale 对「策略里先写了用户、用户尚未注册」是容忍的（空集合）
        out.notes.push(`用户 "${name}" 尚未注册，解析为空集合（headscale 同样容忍）`);
        return out;
      }
      const owned = nodesMatching(nodes, cache, `user:${user.name}`, (n) => n.userName === user.name);
      for (const n of owned) {
        for (const ip of n.ips) out.ips.add(ip);
        for (const r of n.approvedRoutes) {
          if (isDefaultRoute(r)) continue; // 出口路由不算普通子网路由
          const c = parseCidr(r);
          if (c) out.cidrs.push(c);
        }
      }
      out.notes.push(`用户 ${user.name} 名下 ${owned.length} 台设备`);
      // ⚠️ 关键语义：打了标签的设备会脱离用户归属。
      // headscale 在 API 表现层把这类节点的 user 重写为虚拟用户 "tagged-devices"
      // （types/users.go:37 TaggedDevicesUserID = 2147455555，
      //   grpcv1.go:557 "Tags-as-identity: tagged nodes show as TaggedDevices user"）。
      // 因此 user@ 永远**不会**命中已打标签的设备——这是 headscale 的真实行为，
      // 不是本引擎的限制。用户最常见的困惑是「给设备打了标签后按用户的规则就失效了」。
      const taggedCount = nodesMatching(nodes, cache, '__tagged__', (n) => n.tags.length > 0).length;
      if (taggedCount > 0) {
        out.notes.push(
          `注意：当前有 ${taggedCount} 台设备已打标签，它们已脱离用户归属，` +
            `不会被 ${name}@ 命中（需改用 tag: 或 autogroup:tagged 引用）`,
        );
      }
      return out;
    }

    case 'group': {
      const members = policy?.groups?.[parsed.value];
      if (!members) {
        out.unresolved.push(token);
        out.notes.push(`groups 中未定义 "${parsed.value}"`);
        return out;
      }
      for (const m of members) {
        const sub = resolveAlias(m, policy, nodes, users, viewerUser, asSource, cache);
        for (const ip of sub.ips) out.ips.add(ip);
        out.cidrs.push(...sub.cidrs);
        if (sub.everything) out.everything = true;
        if (sub.internet) out.internet = true;
        out.unresolved.push(...sub.unresolved);
      }
      out.notes.push(`group ${parsed.value} 含 ${members.length} 个成员别名`);
      return out;
    }

    case 'tag': {
      const tagged = nodesMatching(nodes, cache, `tag:${parsed.value}`, (n) => n.tags.includes(parsed.value));
      for (const n of tagged) {
        for (const ip of n.ips) out.ips.add(ip);
        for (const r of n.approvedRoutes) {
          if (isDefaultRoute(r)) continue;
          const c = parseCidr(r);
          if (c) out.cidrs.push(c);
        }
      }
      out.notes.push(`标签 ${parsed.value} 命中 ${tagged.length} 台设备`);
      return out;
    }

    case 'autogroup': {
      const ag = parsed.value;
      switch (ag) {
        case 'autogroup:internet': {
          // 不能设为 everything：它只在「目的 = 出口节点」时命中，
          // 否则会退化成「任何目标都放行」，把访问检查结论完全带偏。
          out.internet = true;
          out.notes.push('autogroup:internet 表示「经出口节点访问互联网」，仅当对端是出口节点时命中');
          return out;
        }
        case 'autogroup:danger-all': {
          out.everything = true;
          out.notes.push('autogroup:danger-all 覆盖全部地址（含非 tailnet 地址）');
          return out;
        }
        case 'autogroup:member': {
          const members = nodesMatching(nodes, cache, '__untagged__', (n) => n.tags.length === 0);
          for (const n of members) {
            for (const ip of n.ips) out.ips.add(ip);
            for (const r of n.approvedRoutes) {
              if (isDefaultRoute(r)) continue;
              const c = parseCidr(r);
              if (c) out.cidrs.push(c);
            }
          }
          out.notes.push(`autogroup:member 命中 ${members.length} 台未打标签设备`);
          return out;
        }
        case 'autogroup:tagged': {
          const tagged = nodesMatching(nodes, cache, '__tagged__', (n) => n.tags.length > 0);
          for (const n of tagged) {
            for (const ip of n.ips) out.ips.add(ip);
            for (const r of n.approvedRoutes) {
              if (isDefaultRoute(r)) continue;
              const c = parseCidr(r);
              if (c) out.cidrs.push(c);
            }
          }
          out.notes.push(`autogroup:tagged 命中 ${tagged.length} 台已打标签设备`);
          return out;
        }
        case 'autogroup:self': {
          out.selfScoped = true;
          out.notes.push('autogroup:self 需按查看者所属用户逐节点解析（headscale 内部也是 per-node 处理）');
          return out;
        }
        case 'autogroup:nonroot': {
          out.notes.push('autogroup:nonroot 在 headscale 中不支持（需 OS 级用户识别）');
          return out;
        }
        default: {
          out.unresolved.push(token);
          return out;
        }
      }
    }

    default: {
      out.unresolved.push(token);
      return out;
    }
  }
}

/** 展开 autogroup:self —— 限定为查看者用户名下的设备 */
function applySelfScope(
  set: ResolvedSet,
  nodes: EvalNode[],
  viewerUser: string | null,
  cache?: EvalCache,
): ResolvedSet {
  if (!set.selfScoped) return set;
  const out = emptySet();
  out.notes = [...set.notes];
  out.unresolved = [...set.unresolved];
  if (!viewerUser) {
    out.notes.push('缺少查看者身份，autogroup:self 无法解析');
    return out;
  }
  const owned = nodesMatching(nodes, cache, `self:${viewerUser}`, (n) => n.userName === viewerUser);
  for (const n of owned) {
    for (const ip of n.ips) out.ips.add(ip);
    for (const r of n.approvedRoutes) {
      if (isDefaultRoute(r)) continue;
      const c = parseCidr(r);
      if (c) out.cidrs.push(c);
    }
  }
  out.notes.push(`autogroup:self 解析为 ${viewerUser} 名下 ${owned.length} 台设备`);
  return out;
}

// ============================================================
// 访问判定
// ============================================================

interface Subject {
  ips: string[];
  cidrs: Cidr[];
  everything: boolean;
  /** 该主体是否包含出口节点（决定 autogroup:internet 能否命中） */
  isExitNode: boolean;
  label: string;
}

/** 构造请求方的地址集合 */
function buildSubject(
  side: AccessCheckRequest['from'] | AccessCheckRequest['to'],
  nodes: EvalNode[],
  users: { id: number; name: string; email?: string | null }[],
  isSource: boolean,
  tpush: TraceWriter,
  cache?: EvalCache,
): Subject | { error: string } {
  // 注意：主体构造会写 trace，所以不缓存「主体」本身（否则 trace 会丢），
  // 只缓存它用到的节点集合查询（见 nodesMatching）——那才是 O(N²) 里的大头。
  if ('nodeId' in side) {
    const n = nodes.find((x) => x.id === side.nodeId);
    if (!n) return { error: `节点 #${side.nodeId} 不存在` };
    const cidrs: Cidr[] = [];
    for (const r of n.approvedRoutes) {
      if (isDefaultRoute(r)) continue;
      const c = parseCidr(r);
      if (c) cidrs.push(c);
    }
    tpush(
      () =>
        `${isSource ? '源' : '目的'}节点「${n.displayName}」：IP ${n.ips.join(', ') || '无'}` +
        (n.approvedRoutes.length ? `；已批准子网路由 ${n.approvedRoutes.join(', ')}` : '') +
        (n.isExitNode ? '；是出口节点' : '') +
        (n.tags.length
          ? `；已打标签 ${n.tags.join(', ')} —— 该设备已脱离用户归属，只能用 tag: / autogroup:tagged 引用`
          : ''),
    );
    return { ips: n.ips, cidrs, everything: false, isExitNode: n.isExitNode, label: n.displayName };
  }

  if ('cidr' in side) {
    const c = parseCidr(side.cidr);
    if (!c) return { error: `CIDR 格式不正确：${side.cidr}` };
    tpush(() => `${isSource ? '源' : '目的'}地址段 ${side.cidr}`);
    return { ips: [], cidrs: [c], everything: false, isExitNode: false, label: side.cidr };
  }

  if ('internet' in side) {
    tpush(() => '目的为「互联网」；只有对端是出口节点时才可能命中');
    return { ips: [], cidrs: [], everything: false, isExitNode: true, label: '互联网' };
  }

  if ('user' in side) {
    const user = users.find((u) => u.name === side.user);
    if (!user) return { error: `用户「${side.user}」不存在` };
    const owned = nodesMatching(nodes, cache, `user:${user.name}`, (n) => n.userName === user.name);
    const ips = owned.flatMap((n) => n.ips);
    const cidrs: Cidr[] = [];
    for (const n of owned) {
      for (const r of n.approvedRoutes) {
        if (isDefaultRoute(r)) continue;
        const c = parseCidr(r);
        if (c) cidrs.push(c);
      }
    }
    tpush(() => `用户「${side.user}」名下 ${owned.length} 台设备：${ips.join(', ') || '无 IP'}`);
    return {
      ips,
      cidrs,
      everything: false,
      isExitNode: owned.some((n) => n.isExitNode),
      label: `user:${side.user}`,
    };
  }

  if ('tag' in side) {
    const tagged = nodesMatching(nodes, cache, `tag:${side.tag}`, (n) => n.tags.includes(side.tag));
    const ips = tagged.flatMap((n) => n.ips);
    const cidrs: Cidr[] = [];
    for (const n of tagged) {
      for (const r of n.approvedRoutes) {
        if (isDefaultRoute(r)) continue;
        const c = parseCidr(r);
        if (c) cidrs.push(c);
      }
    }
    tpush(() => `标签「${side.tag}」命中 ${tagged.length} 台设备`);
    return {
      ips,
      cidrs,
      everything: false,
      isExitNode: tagged.some((n) => n.isExitNode),
      label: side.tag,
    };
  }

  return { error: '不支持的请求形式' };
}

/**
 * src 集合与 dst 集合是否存在重叠。
 *
 * @param dstIsExit 目的侧是否包含出口节点。autogroup:internet 只有在
 *                  目的侧是出口节点时才算命中（对齐 node.go canAccess 的
 *                  `dstIsExit && m.DestsIsTheInternet()` 分支）。
 */
function setsOverlap(src: ResolvedSet, dst: ResolvedSet, dstIsExit = false): boolean {
  // autogroup:internet 只对「出口节点」生效，不能退化为通配。
  // 注意：该标志可能出现在任一参数上——目的匹配时规则别名作为 src 传入，
  // 源匹配时它作为 dst 传入，两侧都要判。
  if (src.internet || dst.internet) return dstIsExit;
  if (src.everything || dst.everything) return true;
  for (const a of src.ips) {
    if (dst.ips.has(a)) return true;
    for (const c of dst.cidrs) if (ipInCidr(a, c)) return true;
  }
  for (const b of dst.ips) {
    for (const c of src.cidrs) if (ipInCidr(b, c)) return true;
  }
  for (const c1 of src.cidrs) {
    for (const c2 of dst.cidrs) if (cidrOverlaps(c1, c2)) return true;
  }
  return false;
}

/**
 * 判定「源能否访问目的」。
 */
export interface CheckOptions {
  /** 复用缓存（O(N²) 批量求值时必传，否则每对都重算） */
  cache?: EvalCache;
  /**
   * 是否构建 trace（默认 true）。
   *
   * 拓扑页要对 N×(N-1) 对求值，但**根本不展示 trace**。
   * 每对都拼十几条中文说明字符串，在 N=50 时是 2450 次 × 十几条 = 数万次字符串分配，
   * 纯属给 GC 加压。批量场景传 false 即可跳过。
   */
  trace?: boolean;
}

/**
 * 判定「源能否访问目的」。
 *
 * 单对调用不必传 options；批量（拓扑/矩阵）请传同一个 cache 且 trace=false。
 */
export function checkAccess(input: EvalInput, req: AccessCheckRequest, opts: CheckOptions = {}): AccessCheckResult {
  const wantTrace = opts.trace !== false;
  const trace: string[] = [];
  const tpush: TraceWriter = wantTrace ? (make) => { trace.push(make()); } : NO_TRACE;
  const cache = opts.cache;

  // 策略解释在一次批量会话里恒定，没必要每对重跑一遍 interpretPolicy。
  let interp = cache?.interpretation;
  if (!interp) {
    interp = interpretPolicy(input.policy);
    if (cache) cache.interpretation = interp;
  }
  tpush(() => `策略模式：${interp!.mode} —— ${interp!.explanation}`);

  const base: Omit<AccessCheckResult, 'allowed' | 'reason' | 'explanation' | 'matched'> = {
    mode: interp.mode,
    trace,
  };

  // 主体构造的缓存键：同一节点在批量求值里会被当作 src 和 dst 各 N-1 次。
  // 仅在静默 trace 时缓存（因为主体构造会写 trace，缓存会丢诊断信息）。
  const subjectOf = (side: AccessCheckRequest['from'] | AccessCheckRequest['to'], isSource: boolean) => {
    if (!cache || wantTrace) {
      return buildSubject(side, input.nodes, input.users, isSource, tpush, cache);
    }
    const key = isSource ? `S|${JSON.stringify(side)}` : `D|${JSON.stringify(side)}`;
    const hit = cache.subjects.get(key);
    if (hit) return hit;
    const built = buildSubject(side, input.nodes, input.users, isSource, tpush, cache);
    cache.subjects.set(key, built);
    return built;
  };

  const srcSubj = subjectOf(req.from, true);
  if ('error' in srcSubj) {
    return { ...base, allowed: false, reason: 'no-matching-rule', matched: [], explanation: srcSubj.error, error: srcSubj.error };
  }
  const dstSubj = subjectOf(req.to, false);
  if ('error' in dstSubj) {
    return { ...base, allowed: false, reason: 'no-matching-rule', matched: [], explanation: dstSubj.error, error: dstSubj.error };
  }

  // ---------- 全通模式：不需要任何规则 ----------
  if (interp.mode === 'allow-all') {
    tpush(() => '策略处于「全通」模式，无需匹配任何规则即放行');
    return {
      ...base,
      allowed: true,
      reason: 'allow-all-default',
      matched: [],
      explanation: `${srcSubj.label} → ${dstSubj.label}：允许。当前策略为「全通」模式（未配置 acls/grants），Headscale 放行全部流量。`,
    };
  }

  // ---------- 全禁模式 ----------
  if (interp.mode === 'deny-all') {
    tpush(() => '策略处于「全禁」模式（规则列表为空），任何流量都不放行');
    return {
      ...base,
      allowed: false,
      reason: 'deny-all-default',
      matched: [],
      explanation: `${srcSubj.label} → ${dstSubj.label}：拒绝。当前策略包含空的规则列表，Headscale 拒绝全部流量。`,
    };
  }

  // ---------- 规则模式：逐条匹配 ----------
  const policy = input.policy!;
  const fromSide = req.from;
  const viewerUser =
    'nodeId' in fromSide ? (input.nodes.find((n) => n.id === fromSide.nodeId)?.userName ?? null) : null;

  const port = req.port;
  const proto = parseProtocol(req.proto);
  if (proto === null) {
    const msg = `协议不合法："${req.proto}"（headscale 不支持通配符 *，请写协议名或 IANA 编号）`;
    tpush(() => msg);
    return { ...base, allowed: false, reason: 'no-matching-rule', matched: [], explanation: msg, error: msg };
  }
  tpush(() => `协议：${proto.name}（${proto.number}）${port !== undefined ? `，端口 ${port}` : '，端口未限定'}`);

  // 主体地址集合在一次求值里恒定：旧实现在**每条规则、每个别名**上都重建
  // 一次 `new Set(ips)` 与整个 ResolvedSet 对象，是批量求值的主要分配源之一。
  const srcSet: ResolvedSet = {
    ips: new Set(srcSubj.ips),
    cidrs: srcSubj.cidrs,
    everything: srcSubj.everything,
    internet: false,
    selfScoped: false,
    notes: [],
    unresolved: [],
  };
  const dstSet: ResolvedSet = {
    ips: new Set(dstSubj.ips),
    cidrs: dstSubj.cidrs,
    everything: dstSubj.everything,
    internet: false,
    selfScoped: false,
    notes: [],
    unresolved: [],
  };

  const matched: MatchedRule[] = [];

  (policy.acls ?? []).forEach((rule, idx) => {
    // desc 含两次 JSON.stringify，静默 trace 时绝不能构造
    const desc = () => `acls[${idx}] ${rule.action} proto=${rule.proto} src=${JSON.stringify(rule.src)} dst=${JSON.stringify(rule.dst)}`;

    // 协议匹配
    const ruleProto = parseProtocol(rule.proto);
    if (ruleProto === null) {
      tpush(() => `${desc()} —— 规则协议非法，跳过`);
      return;
    }
    if (ruleProto.number !== 0 && ruleProto.number !== proto.number) {
      tpush(() => `${desc()} —— 协议不匹配（规则 ${ruleProto.name} vs 请求 ${proto.name}）`);
      return;
    }

    // src 匹配
    let srcHit = false;
    let srcToken = '';
    for (const t of rule.src) {
      const set = applySelfScope(
        resolveAlias(t, policy, input.nodes, input.users, viewerUser, true, cache),
        input.nodes,
        viewerUser,
        cache,
      );
      if (setsOverlap(set, srcSet, dstSubj.isExitNode)) {
        srcHit = true;
        srcToken = t;
        break;
      }
    }
    if (!srcHit) {
      tpush(() => `${desc()} —— 源不匹配`);
      return;
    }

    // dst 匹配（含端口）
    let dstToken = '';
    let dstOk = false;
    for (const d of rule.dst) {
      const split = splitDestAndPort(d);
      if (!split) {
        tpush(() => `${desc()} —— dst 条目 "${d}" 缺少端口或格式非法`);
        continue;
      }
      const ranges = parsePortRange(split.port, rule.proto);
      if (!ranges) {
        tpush(() => `${desc()} —— dst 端口 "${split.port}" 非法`);
        continue;
      }
      // 端口匹配
      if (port !== undefined && !portMatches(ranges, port)) continue;

      const set = applySelfScope(
        resolveAlias(split.dest, policy, input.nodes, input.users, viewerUser, false, cache),
        input.nodes,
        viewerUser,
        cache,
      );
      if (setsOverlap(set, dstSet, dstSubj.isExitNode)) {
        dstOk = true;
        dstToken = d;
        break;
      }
    }
    if (!dstOk) {
      tpush(() => `${desc()} —— 目的或端口不匹配`);
      return;
    }

    tpush(() => `${desc()} —— ✓ 命中`);
    matched.push({
      index: idx,
      rule: `${rule.action} ${rule.proto} ${rule.src.join(', ')} → ${rule.dst.join(', ')}`,
      matchedSrc: srcToken,
      matchedDst: dstToken,
    });
  });

  if (matched.length > 0) {
    return {
      ...base,
      allowed: true,
      reason: 'matched-rule',
      matched,
      explanation: `${srcSubj.label} → ${dstSubj.label}${port !== undefined ? `:${port}` : ''}：允许。命中 ${matched.length} 条规则，例如 ${matched[0]!.rule}。`,
    };
  }

  return {
    ...base,
    allowed: false,
    reason: 'no-matching-rule',
    matched: [],
    explanation:
      `${srcSubj.label} → ${dstSubj.label}${port !== undefined ? `:${port}` : ''}：拒绝。` +
      '策略已配置规则但没有任何一条匹配该组合，未命中即拒绝（headscale 的默认行为）。',
  };
}
