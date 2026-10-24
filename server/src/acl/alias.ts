/**
 * ACL 策略的别名（alias）解析。
 *
 * 本文件的解析与解析顺序**逐条对齐 headscale v0.29.6 的
 * hscontrol/policy/v2/types.go:parseAlias**，不是凭文档猜的。
 * 任何不一致都会让面板的「访问检查」给出错误结论，比没有更危险。
 */

/** 通配符：等价于「整个 tailnet 的 IP」 */
export const WILDCARD = '*' as const;

/** headscale 支持的 autogroup 全集（types.go:756） */
export const AUTOGROUPS = [
  'autogroup:internet',
  'autogroup:member',
  'autogroup:nonroot',
  'autogroup:tagged',
  'autogroup:self',
  'autogroup:danger-all',
] as const;
export type AutoGroup = (typeof AUTOGROUPS)[number];

/**
 * 各位置允许的 autogroup 白名单（types.go:2071-2077）。
 * 这是 headscale 的硬约束，面板保存前必须按此校验。
 */
export const AUTOGROUP_FOR_SRC: AutoGroup[] = ['autogroup:member', 'autogroup:tagged', 'autogroup:danger-all'];
export const AUTOGROUP_FOR_DST: AutoGroup[] = [
  'autogroup:internet',
  'autogroup:member',
  'autogroup:tagged',
  'autogroup:self',
];
export const AUTOGROUP_FOR_SSH_SRC: AutoGroup[] = ['autogroup:member', 'autogroup:tagged'];
export const AUTOGROUP_FOR_SSH_DST: AutoGroup[] = ['autogroup:member', 'autogroup:tagged', 'autogroup:self'];
export const AUTOGROUP_FOR_NODE_ATTRS: AutoGroup[] = ['autogroup:member', 'autogroup:tagged'];

/** headscale 未实现的 autogroup（types.go:2077 当前为空，保留以便将来对齐） */
export const AUTOGROUP_NOT_SUPPORTED: AutoGroup[] = [];

export type AliasKind = 'wildcard' | 'username' | 'group' | 'tag' | 'autogroup' | 'host' | 'prefix';

export interface PlainAlias {
  kind: AliasKind;
  /** 原始 token（已 trim） */
  raw: string;
  /** prefix 形式的规范化值：CIDR / host 名 / group:x / tag:x / autogroup:x / 用户名 */
  value: string;
}

/** IPv4/IPv6 字面量或 CIDR 判定（对应 Go 的 netip.ParsePrefix） */
function tryParsePrefix(s: string): { ok: boolean; normalized: string } {
  const m = /^(.+?)\/(\d{1,3})$/.exec(s);
  if (!m) return { ok: false, normalized: s };
  const addr = m[1]!;
  const bits = Number(m[2]);
  const isV6 = addr.includes(':');
  const max = isV6 ? 128 : 32;
  if (!(bits >= 0 && bits <= max)) return { ok: false, normalized: s };
  // 裸地址（无 /）也允许，headscale 的 parseString 接受 addr 与 addr/bits
  return { ok: validateAddr(addr, isV6), normalized: `${addr}/${bits}` };
}

/** 裸地址（无前缀长度）也视为合法 Prefix */
function tryParseAddr(s: string): { ok: boolean; normalized: string } {
  if (s.includes('/')) return { ok: false, normalized: s };
  const isV6 = s.includes(':');
  const ok = validateAddr(s, isV6);
  // headscale 会把裸地址规范化为 /32 或 /128
  return { ok, normalized: ok ? `${s}/${isV6 ? 128 : 32}` : s };
}

function validateAddr(addr: string, isV6: boolean): boolean {
  try {
    if (isV6) {
      const parts = addr.split('::');
      if (parts.length > 2) return false;
      const segs = parts.flatMap((p) => (p === '' ? [] : p.split(':')));
      if (parts.length === 1 && segs.length !== 8) return false;
      if (parts.length === 2 && segs.length > 7) return false;
      return segs.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g));
    }
    const segs = addr.split('.');
    if (segs.length !== 4) return false;
    return segs.every((g) => /^\d{1,3}$/.test(g) && Number(g) <= 255);
  } catch {
    return false;
  }
}

/**
 * 严格按 headscale 的顺序解析别名。
 *
 * 顺序（types.go:1064 parseAlias）：
 *   1. 先试 Prefix（CIDR 或裸地址）
 *   2. `*`            → wildcard
 *   3. 含 `@`         → username
 *   4. `group:` 前缀  → group
 *   5. `tag:` 前缀    → tag
 *   6. `autogroup:`   → autogroup
 *   7. 不含 `@` 且不含 `:` → host
 *   8. 否则非法
 */
export function parseAlias(input: string): PlainAlias | null {
  const raw = input.trim();
  if (raw === '') return null;

  // 1. Prefix 优先
  const asPrefix = tryParsePrefix(raw);
  if (asPrefix.ok) return { kind: 'prefix', raw, value: asPrefix.normalized };
  const asAddr = tryParseAddr(raw);
  if (asAddr.ok) return { kind: 'prefix', raw, value: asAddr.normalized };

  // 2. 通配符
  if (raw === WILDCARD) return { kind: 'wildcard', raw, value: raw };

  // 3-6. 前缀型
  if (raw.includes('@')) return { kind: 'username', raw, value: raw };
  if (raw.startsWith('group:')) return { kind: 'group', raw, value: raw };
  if (raw.startsWith('tag:')) return { kind: 'tag', raw, value: raw };
  if (raw.startsWith('autogroup:')) return { kind: 'autogroup', raw, value: raw };

  // 7. host：不含 @ 且不含 :
  if (!raw.includes('@') && !raw.includes(':')) return { kind: 'host', raw, value: raw };

  return null;
}

/** 是否是合法的 autogroup 取值 */
export function isKnownAutoGroup(v: string): v is AutoGroup {
  return (AUTOGROUPS as readonly string[]).includes(v);
}

/**
 * 解析 dst 的 `host:port` 形式（types.go:890 AliasWithPorts.UnmarshalJSON）。
 *
 * 规则：
 *   - dst 条目**必须含冒号**，否则 ErrHostportMissingColon
 *   - 端口分隔符是**最后一个**冒号（utils.go:36 用 LastIndex）
 *   - RFC3986 方括号 IPv6：`[fd7a::1]:22`，剥括号后按常规处理
 */
export function splitDestAndPort(input: string): { dest: string; port: string } | null {
  let s = input.trim();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    const host = s.slice(1, close);
    if (!validateAddr(host, true)) return null;
    const rest = s.slice(close + 1);
    if (rest === '' || (rest[0] !== ':' && rest[0] !== '/')) return null;
    s = host + rest;
  }
  const last = s.lastIndexOf(':');
  if (last <= 0 || last === s.length - 1) return null;
  const dest = s.slice(0, last);
  const port = s.slice(last + 1);
  if (dest === '' || port === '') return null;
  return { dest, port };
}

export interface PortRange {
  first: number;
  last: number;
}

/**
 * 解析端口定义（utils.go:86 parsePortRange）。
 * 支持单端口、区间、以及 `*`（0-65535）。
 */
export function parsePortRange(def: string, proto?: string): PortRange[] | null {
  const trimmed = def.trim();

  // 协议前缀，如 tcp:443
  let body = trimmed;
  let protoName: string | undefined;
  const withProto = /^([a-zA-Z0-9]+):(.+)$/.exec(trimmed);
  if (withProto) {
    protoName = withProto[1]!.toLowerCase();
    body = withProto[2]!;
  }

  if (body === '*') {
    return [{ first: 0, last: 65535 }];
  }

  const out: PortRange[] = [];
  for (const piece of body.split(',')) {
    const p = piece.trim();
    if (p === '') return null;
    if (p === '*') {
      out.push({ first: 0, last: 65535 });
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(p);
    if (range) {
      const first = Number(range[1]);
      const last = Number(range[2]);
      if (first > last || last > 65535) return null;
      out.push({ first, last });
      continue;
    }
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n > 65535) return null;
    out.push({ first: n, last: n });
  }

  void proto;
  void protoName;
  return out.length ? out : null;
}

/** 判断某端口是否落在端口区间集合内 */
export function portMatches(ranges: PortRange[], port: number): boolean {
  return ranges.some((r) => port >= r.first && port <= r.last);
}

/** 协议名 → IANA 编号（types.go:1909） */
export const PROTOCOL_NUMBERS: Record<string, number> = {
  icmp: 1,
  igmp: 2,
  ipv4: 4,
  tcp: 6,
  egp: 8,
  igp: 9,
  udp: 17,
  gre: 47,
  esp: 50,
  ah: 51,
  ipv6icmp: 58,
  sctp: 132,
  fc: 133,
};

export const PROTOCOL_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(PROTOCOL_NUMBERS).map(([k, v]) => [v, k]),
);

/**
 * 解析 proto 字段。
 * headscale 支持协议名、IANA 编号，以及 `*`（但 `*` 会报错：
 * errUnknownProtocolWildcard，要求明确写 0-255 或名称）。
 */
export function parseProtocol(v: string | undefined): { number: number; name: string } | null {
  if (v === undefined || v === '') {
    // 缺省视为 tcp？headscale 的 ACL.Protocol 有默认值，见 Validate
    return { number: PROTOCOL_NUMBERS['tcp']!, name: 'tcp' };
  }
  const s = v.trim().toLowerCase();
  if (s === '*') return null; // 上游明确拒绝
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n < 0 || n > 255) return null;
    return { number: n, name: PROTOCOL_NAMES[n] ?? String(n) };
  }
  const n = PROTOCOL_NUMBERS[s];
  if (n === undefined) return null;
  return { number: n, name: s };
}
