/**
 * ACL 策略模型与解析。
 *
 * ⚠️ 至关重要的一处语义（已在真实 headscale v0.29.6 上实证）：
 *
 *   策略 {"acls":[]} 与 {"hosts":{...}} 都是「没有规则」，但编译结果相反：
 *
 *     策略                          编译后的 filter          实际语义
 *     {}（acls 键不存在）           SrcIPs:["*"], 0-65535    全通
 *     {"acls":[]}（空数组）         null                     全禁
 *     {"hosts":{...}}（无 acls 键） SrcIPs:["*"], 0-65535    全通
 *
 *   依据 headscale v0.29.6 hscontrol/policy/v2/policy.go:253
 *     if pm.pol == nil || (pm.pol.ACLs == nil && pm.pol.Grants == nil) {
 *         filter = tailcfg.FilterAllowAll
 *     }
 *   Go 里「键不存在」是 nil，「空数组」是非 nil 空切片——两者不等价。
 *
 *   因此本模块**必须保留 undefined 与 [] 的区别**，绝不能做「归一化」。
 *   面板若把 {} 补成 {"acls":[]}，会把整张网络从全通静默翻成全禁，全网断联。
 */

export interface AclRule {
  /**
   * ⚠️ 实测（v0.29.6 types.go:1685 Action.UnmarshalJSON）：
   * ACL 的 action **只支持 "accept"**，没有 "deny"。
   * 传其它值上游直接报 `action="deny" is not supported: invalid ACL action`。
   *
   * 「拒绝」是靠**默认策略**实现的：未命中任何 accept 规则的流量一律被拒绝。
   * 面板编辑器因此不能提供 deny 选项，否则保存必然失败。
   */
  action: 'accept';
  proto: string;
  src: string[];
  dst: string[];
}

export interface Grant {
  src: string[];
  dst: string[];
  ip?: string[];
  app?: Record<string, unknown>;
  via?: string[];
}

export interface SshRule {
  action: 'accept' | 'check' | 'deny';
  src: string[];
  dst: string[];
  users: string[];
  checkPeriod?: string;
  acceptEnv?: string[];
}

export interface NodeAttrGrant {
  target: string[];
  attr?: string[];
  ipPool?: string[];
}

export interface AutoApproverPolicy {
  routes?: Record<string, string[]>;
  exitNode?: string[];
}

/**
 * 策略模型。**注意所有字段都是可选的**，且 undefined 与空数组语义不同。
 */
export interface AclPolicy {
  groups?: Record<string, string[]>;
  hosts?: Record<string, string>;
  tagOwners?: Record<string, string[]>;
  acls?: AclRule[];
  grants?: Grant[];
  nodeAttrs?: NodeAttrGrant[];
  autoApprovers?: AutoApproverPolicy;
  ssh?: SshRule[];
  randomizeClientPort?: boolean;
  tests?: unknown[];
  sshTests?: unknown[];
}

/**
 * 策略的生效模式——这是面板最需要向用户解释清楚的一件事。
 */
export type PolicyMode =
  /** 全通：acls 与 grants 键都不存在（含策略为 null 的情形） */
  | 'allow-all'
  /** 全禁：acls 或 grants 存在但没有任何规则 */
  | 'deny-all'
  /** 按规则：至少有一条 acl 或 grant */
  | 'rules';

export interface PolicyInterpretation {
  mode: PolicyMode;
  /** 给用户看的解释 */
  explanation: string;
  /** 是否处于「危险高影响」状态，UI 需显著提示 */
  highImpact: boolean;
}

/**
 * 判定策略模式，严格复刻 headscale 的 nil 判断。
 *
 * 注意：策略为空字符串（headscale 里完全没设置过策略）同样等价于全通——
 * 此时 PolicyManager 的 pm.pol 为 nil。
 */
export function interpretPolicy(policy: AclPolicy | null | undefined): PolicyInterpretation {
  if (policy === null || policy === undefined) {
    return {
      mode: 'allow-all',
      explanation:
        '当前未设置任何 ACL 策略，Headscale 默认放行全部流量。任何人都能访问任何设备。',
      highImpact: true,
    };
  }

  // 精确复刻：两个键都不存在 → 全通
  const aclsAbsent = policy.acls === undefined;
  const grantsAbsent = policy.grants === undefined;
  if (aclsAbsent && grantsAbsent) {
    return {
      mode: 'allow-all',
      explanation:
        '策略中既没有 acls 也没有 grants 字段，Headscale 视为「未配置策略」，默认放行全部流量。' +
        '注意：这与空规则列表 ' +
        '{"acls":[]} 的语义完全相反。',
      highImpact: true,
    };
  }

  const aclCount = policy.acls?.length ?? 0;
  const grantCount = policy.grants?.length ?? 0;
  if (aclCount + grantCount === 0) {
    return {
      mode: 'deny-all',
      explanation:
        '策略包含 acls 或 grants 字段但没有任何规则，Headscale 将拒绝全部流量。所有设备之间无法互访。',
      highImpact: true,
    };
  }

  return {
    mode: 'rules',
    explanation: `已配置 ${aclCount} 条 ACL 规则${grantCount ? ` 与 ${grantCount} 条 grants` : ''}，未命中规则的流量默认拒绝。`,
    highImpact: false,
  };
}

/** 兼容 HuJSON 的宽松解析：去注释、容忍尾逗号 */
export function parseHuJsonLoose(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const stripped = stripJsonComments(text);
  const noTrailing = stripped.replace(/,(\s*[}\]])/g, '$1');
  try {
    return { ok: true, value: JSON.parse(noTrailing) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 去掉 // 与 /* *​/ 注释，但保留字符串内的内容 */
function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** 把策略对象序列化为可读 JSON（面板内部统一用 2 空格缩进存储） */
export function stringifyPolicy(policy: AclPolicy): string {
  return JSON.stringify(policy, null, 2);
}

/** 从 HuJSON 文本解析为策略对象；失败返回错误信息 */
export function parsePolicy(text: string): { ok: true; policy: AclPolicy } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    // 空文本 = 未设置策略 → 全通，保持不变
    return { ok: true, policy: {} };
  }
  const parsed = parseHuJsonLoose(trimmed);
  if (!parsed.ok) return { ok: false, error: `JSON 解析失败：${parsed.error}` };
  if (typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, error: '策略必须是一个 JSON 对象' };
  }
  return { ok: true, policy: parsed.value as AclPolicy };
}
