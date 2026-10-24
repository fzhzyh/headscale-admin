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
import { interpretPolicy, type AclPolicy, type PolicyMode } from './model.ts';

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

function parseCidr(s: string): Cidr | null {
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

/** 某 IP 是否落在 CIDR 内 */
function ipInCidr(ip: string, cidr: Cidr): boolean {
  const n = ipToBigInt(ip);
  if (n === null) return false;
  const isV6 = ip.includes(':');
  if (isV6 !== cidr.isV6) return false;
  const total = cidr.isV6 ? 128 : 32;
  const shift = BigInt(total - cidr.bits);
  const mask = shift === 0n ? ~0n : ((1n << BigInt(total)) - 1n) ^ ((1n << shift) - 1n);
  return (n & mask) === (cidr.base & mask);
}

/** 两个 CIDR 是否有交集 */
function cidrOverlaps(a: Cidr, b: Cidr): boolean {
  if (a.isV6 !== b.isV6) return false;
  const total = a.isV6 ? 128 : 32;
  const bits = Math.min(a.bits, b.bits);
  const shift = BigInt(total - bits);
  const mask = shift === 0n ? ~0n : ((1n << BigInt(total)) - 1n) ^ ((1n << shift) - 1n);
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
      const sub = resolveAlias(hostValue, policy, nodes, users, viewerUser, asSource);
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
      const owned = nodes.filter((n) => n.userName === user.name);
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
      const taggedCount = nodes.filter((n) => n.tags.length > 0).length;
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
        const sub = resolveAlias(m, policy, nodes, users, viewerUser, asSource);
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
      const tagged = nodes.filter((n) => n.tags.includes(parsed.value));
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
          const members = nodes.filter((n) => n.tags.length === 0);
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
          const tagged = nodes.filter((n) => n.tags.length > 0);
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
function applySelfScope(set: ResolvedSet, nodes: EvalNode[], viewerUser: string | null): ResolvedSet {
  if (!set.selfScoped) return set;
  const out = emptySet();
  out.notes = [...set.notes];
  out.unresolved = [...set.unresolved];
  if (!viewerUser) {
    out.notes.push('缺少查看者身份，autogroup:self 无法解析');
    return out;
  }
  const owned = nodes.filter((n) => n.userName === viewerUser);
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
  trace: string[],
): Subject | { error: string } {
  if ('nodeId' in side) {
    const n = nodes.find((x) => x.id === side.nodeId);
    if (!n) return { error: `节点 #${side.nodeId} 不存在` };
    const cidrs: Cidr[] = [];
    for (const r of n.approvedRoutes) {
      if (isDefaultRoute(r)) continue;
      const c = parseCidr(r);
      if (c) cidrs.push(c);
    }
    trace.push(
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
    trace.push(`${isSource ? '源' : '目的'}地址段 ${side.cidr}`);
    return { ips: [], cidrs: [c], everything: false, isExitNode: false, label: side.cidr };
  }

  if ('internet' in side) {
    trace.push('目的为「互联网」；只有对端是出口节点时才可能命中');
    return { ips: [], cidrs: [], everything: false, isExitNode: true, label: '互联网' };
  }

  if ('user' in side) {
    const user = users.find((u) => u.name === side.user);
    if (!user) return { error: `用户「${side.user}」不存在` };
    const owned = nodes.filter((n) => n.userName === user.name);
    const ips = owned.flatMap((n) => n.ips);
    const cidrs: Cidr[] = [];
    for (const n of owned) {
      for (const r of n.approvedRoutes) {
        if (isDefaultRoute(r)) continue;
        const c = parseCidr(r);
        if (c) cidrs.push(c);
      }
    }
    trace.push(`用户「${side.user}」名下 ${owned.length} 台设备：${ips.join(', ') || '无 IP'}`);
    return {
      ips,
      cidrs,
      everything: false,
      isExitNode: owned.some((n) => n.isExitNode),
      label: `user:${side.user}`,
    };
  }

  if ('tag' in side) {
    const tagged = nodes.filter((n) => n.tags.includes(side.tag));
    const ips = tagged.flatMap((n) => n.ips);
    const cidrs: Cidr[] = [];
    for (const n of tagged) {
      for (const r of n.approvedRoutes) {
        if (isDefaultRoute(r)) continue;
        const c = parseCidr(r);
        if (c) cidrs.push(c);
      }
    }
    trace.push(`标签「${side.tag}」命中 ${tagged.length} 台设备`);
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
export function checkAccess(input: EvalInput, req: AccessCheckRequest): AccessCheckResult {
  const trace: string[] = [];
  const interp = interpretPolicy(input.policy);
  trace.push(`策略模式：${interp.mode} —— ${interp.explanation}`);

  const base: Omit<AccessCheckResult, 'allowed' | 'reason' | 'explanation' | 'matched'> = {
    mode: interp.mode,
    trace,
  };

  const srcSubj = buildSubject(req.from, input.nodes, input.users, true, trace);
  if ('error' in srcSubj) {
    return { ...base, allowed: false, reason: 'no-matching-rule', matched: [], explanation: srcSubj.error, error: srcSubj.error };
  }
  const dstSubj = buildSubject(req.to, input.nodes, input.users, false, trace);
  if ('error' in dstSubj) {
    return { ...base, allowed: false, reason: 'no-matching-rule', matched: [], explanation: dstSubj.error, error: dstSubj.error };
  }

  // ---------- 全通模式：不需要任何规则 ----------
  if (interp.mode === 'allow-all') {
    trace.push('策略处于「全通」模式，无需匹配任何规则即放行');
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
    trace.push('策略处于「全禁」模式（规则列表为空），任何流量都不放行');
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
    trace.push(msg);
    return { ...base, allowed: false, reason: 'no-matching-rule', matched: [], explanation: msg, error: msg };
  }
  trace.push(`协议：${proto.name}（${proto.number}）${port !== undefined ? `，端口 ${port}` : '，端口未限定'}`);

  const matched: MatchedRule[] = [];

  (policy.acls ?? []).forEach((rule, idx) => {
    const desc = `acls[${idx}] ${rule.action} proto=${rule.proto} src=${JSON.stringify(rule.src)} dst=${JSON.stringify(rule.dst)}`;

    // 协议匹配
    const ruleProto = parseProtocol(rule.proto);
    if (ruleProto === null) {
      trace.push(`${desc} —— 规则协议非法，跳过`);
      return;
    }
    if (ruleProto.number !== 0 && ruleProto.number !== proto.number) {
      trace.push(`${desc} —— 协议不匹配（规则 ${ruleProto.name} vs 请求 ${proto.name}）`);
      return;
    }

    // src 匹配
    let srcHit: ResolvedSet | null = null;
    let srcToken = '';
    for (const t of rule.src) {
      const set = applySelfScope(resolveAlias(t, policy, input.nodes, input.users, viewerUser, true), input.nodes, viewerUser);
      if (
        setsOverlap(
          set,
          {
            ips: new Set(srcSubj.ips),
            cidrs: srcSubj.cidrs,
            everything: srcSubj.everything,
            internet: false,
            selfScoped: false,
            notes: [],
            unresolved: [],
          },
          dstSubj.isExitNode,
        )
      ) {
        srcHit = set;
        srcToken = t;
        break;
      }
    }
    if (!srcHit) {
      trace.push(`${desc} —— 源不匹配`);
      return;
    }

    // dst 匹配（含端口）
    let dstToken = '';
    let dstOk = false;
    for (const d of rule.dst) {
      const split = splitDestAndPort(d);
      if (!split) {
        trace.push(`${desc} —— dst 条目 "${d}" 缺少端口或格式非法`);
        continue;
      }
      const ranges = parsePortRange(split.port, rule.proto);
      if (!ranges) {
        trace.push(`${desc} —— dst 端口 "${split.port}" 非法`);
        continue;
      }
      // 端口匹配
      if (port !== undefined && !portMatches(ranges, port)) continue;

      const set = applySelfScope(
        resolveAlias(split.dest, policy, input.nodes, input.users, viewerUser, false),
        input.nodes,
        viewerUser,
      );
      const dstSet: ResolvedSet = {
        ips: new Set(dstSubj.ips),
        cidrs: dstSubj.cidrs,
        everything: dstSubj.everything,
        internet: false,
        selfScoped: false,
        notes: [],
        unresolved: [],
      };
      if (setsOverlap(set, dstSet, dstSubj.isExitNode)) {
        dstOk = true;
        dstToken = d;
        break;
      }
    }
    if (!dstOk) {
      trace.push(`${desc} —— 目的或端口不匹配`);
      return;
    }

    trace.push(`${desc} —— ✓ 命中`);
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
