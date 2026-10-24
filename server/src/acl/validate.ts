/**
 * ACL 策略本地校验。
 *
 * 为什么要自己做：headscale 的 `POST /api/v1/policy/check` 确实会做语义校验
 * （实测：非法 action、未定义的 tag/host 引用都会返回 400），但它的报错是
 * Go 内部错误串，用户看不懂；而且要发一次网络请求。
 *
 * 这里实现**本地预校验**，把可判定的问题在保存前用人话告诉用户，
 * 同时保留用上游 check 做最终确认（本地校验通过 ≠ 上游一定接受）。
 *
 * 规则全部对齐 headscale v0.29.6 hscontrol/policy/v2/types.go。
 */

import {
  parseAlias,
  splitDestAndPort,
  parsePortRange,
  parseProtocol,
  isKnownAutoGroup,
  AUTOGROUP_FOR_SRC,
  AUTOGROUP_FOR_DST,
  AUTOGROUP_FOR_SSH_SRC,
  AUTOGROUP_FOR_SSH_DST,
  AUTOGROUP_FOR_NODE_ATTRS,
  AUTOGROUP_NOT_SUPPORTED,
  type AutoGroup,
} from './alias.ts';
import { interpretPolicy, type AclPolicy } from './model.ts';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  /** 定位：如 `acls[0].src[1]` */
  path: string;
  message: string;
  /** 修复建议 */
  hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: {
    acls: number;
    grants: number;
    ssh: number;
    groups: number;
    hosts: number;
    tagOwners: number;
    nodeAttrs: number;
    autoApproverRoutes: number;
    autoApproverExitNodes: number;
    bytes: number;
  };
}

/** 检查 autogroup 是否在白名单内 */
function checkAutogroup(
  token: AutoGroup,
  allowed: AutoGroup[],
  path: string,
  position: string,
  issues: ValidationIssue[],
): void {
  if (AUTOGROUP_NOT_SUPPORTED.includes(token)) {
    issues.push({
      severity: 'error',
      path,
      message: `${token} 在当前 Headscale 版本中不受支持`,
      hint: '请改用其它取值',
    });
    return;
  }
  if (!isKnownAutoGroup(token)) {
    issues.push({
      severity: 'error',
      path,
      message: `未知的 autogroup 取值 "${token}"`,
      hint: '可用值：autogroup:member / autogroup:tagged / autogroup:self / autogroup:internet / autogroup:danger-all',
    });
    return;
  }
  if (!allowed.includes(token)) {
    issues.push({
      severity: 'error',
      path,
      message: `${position} 不允许使用 ${token}`,
      hint: `${position}可用：${allowed.join(' / ')}`,
    });
  }
}

/** 校验一组别名（src 或 dst 的裸别名部分） */
function checkAliases(
  aliases: string[],
  policy: AclPolicy,
  pathBase: string,
  opts: { position: 'src' | 'dst'; isSsh?: boolean; issues: ValidationIssue[]; knownTags?: Set<string> },
): void {
  const { position, issues } = opts;
  const allowedAuto = opts.isSsh
    ? position === 'src'
      ? AUTOGROUP_FOR_SSH_SRC
      : AUTOGROUP_FOR_SSH_DST
    : position === 'src'
      ? AUTOGROUP_FOR_SRC
      : AUTOGROUP_FOR_DST;

  let hasAutoGroupSelf = false;

  aliases.forEach((raw, i) => {
    const path = `${pathBase}[${i}]`;
    if (typeof raw !== 'string' || raw.trim() === '') {
      issues.push({ severity: 'error', path, message: '别名为空' });
      return;
    }
    const parsed = parseAlias(raw);
    if (!parsed) {
      issues.push({
        severity: 'error',
        path,
        message: `无法识别的别名 "${raw}"`,
        hint: '支持：* / user@ / group:x / tag:x / autogroup:x / hosts 名 / CIDR',
      });
      return;
    }

    switch (parsed.kind) {
      case 'autogroup': {
        const ag = parsed.value as AutoGroup;
        if (ag === 'autogroup:self') hasAutoGroupSelf = true;
        checkAutogroup(ag, allowedAuto, path, position === 'src' ? '源' : '目的', issues);
        break;
      }
      case 'group': {
        if (!policy.groups || !(parsed.value in policy.groups)) {
          issues.push({
            severity: 'error',
            path,
            message: `groups 中未定义 "${parsed.value}"`,
            hint: '请先在「主机与分组」中定义该分组',
          });
        }
        break;
      }
      case 'host': {
        if (!policy.hosts || !(parsed.value in policy.hosts)) {
          issues.push({
            severity: 'error',
            path,
            message: `hosts 中未定义 "${parsed.value}"`,
            hint: '请先在「主机与分组」中定义该主机，或直接写 IP/CIDR',
          });
        }
        break;
      }
      case 'tag': {
        if (opts.knownTags && !opts.knownTags.has(parsed.value)) {
          issues.push({
            severity: 'warning',
            path,
            message: `标签 "${parsed.value}" 未在 tagOwners 中声明归属`,
            hint: '未声明归属的标签无法被设备获取，规则可能永远不生效',
          });
        }
        break;
      }
      default:
        break;
    }
  });

  // autogroup:self 的源侧约束（types.go:2288）
  // 规则含 autogroup:self 作为目的时，源只能是 user / group / * / autogroup:member
  return void hasAutoGroupSelf;
}

/** 校验含 autogroup:self 的规则：源侧受严格限制 */
function checkSelfRuleConstraint(rule: { src: string[]; dst: string[] }, pathBase: string, issues: ValidationIssue[]): void {
  const dstHasSelf = rule.dst.some((d) => {
    const split = splitDestAndPort(d);
    return split !== null && split.dest.trim() === 'autogroup:self';
  });
  if (!dstHasSelf) return;

  rule.src.forEach((raw, i) => {
    const parsed = parseAlias(raw);
    if (!parsed) return;
    const okKinds = ['username', 'group', 'wildcard'];
    if (parsed.kind === 'autogroup' && parsed.value === 'autogroup:member') return;
    if (okKinds.includes(parsed.kind)) return;
    issues.push({
      severity: 'error',
      path: `${pathBase}.src[${i}]`,
      message: `规则目的含 autogroup:self 时，源不能是 "${raw}"`,
      hint: 'autogroup:self 的源只允许：user@（用户）、group:x（分组）、*（通配）、autogroup:member',
    });
  });
}

/** 主校验入口 */
export function validatePolicy(policy: AclPolicy | null, rawText: string): ValidationResult {
  const issues: ValidationIssue[] = [];
  const p = policy ?? {};

  // ---------- 结构级：acls / grants 的存在性决定全网放行还是全禁 ----------
  const interp = interpretPolicy(p);
  if (interp.highImpact) {
    issues.push({
      severity: 'warning',
      path: 'acls',
      message: interp.explanation,
      hint:
        interp.mode === 'allow-all'
          ? '若要收紧访问，请至少写一条 acls 规则；保存后未命中规则的流量会被拒绝。'
          : '空规则列表会导致所有设备之间无法互访。若这是有意为之，请确认。',
    });
  }

  const knownTags = new Set(Object.keys(p.tagOwners ?? {}));

  // ---------- tagOwners ----------
  Object.entries(p.tagOwners ?? {}).forEach(([tag, owners]) => {
    if (!/^tag:[a-zA-Z0-9._-]+$/.test(tag)) {
      issues.push({
        severity: 'error',
        path: `tagOwners["${tag}"]`,
        message: `标签名 "${tag}" 格式非法`,
        hint: '需形如 tag:name，只允许字母、数字与 . _ -',
      });
    }
    if (!Array.isArray(owners) || owners.length === 0) {
      issues.push({
        severity: 'error',
        path: `tagOwners["${tag}"]`,
        message: '标签必须至少有一个归属者',
        hint: '填写 user@ / group:x / autogroup:member 等',
      });
      return;
    }
    owners.forEach((o, i) => {
      const parsed = parseAlias(o);
      if (!parsed) {
        issues.push({ severity: 'error', path: `tagOwners["${tag}"][${i}]`, message: `无法识别的归属者 "${o}"` });
        return;
      }
      if (parsed.kind === 'wildcard' || parsed.kind === 'prefix' || parsed.kind === 'host') {
        issues.push({
          severity: 'error',
          path: `tagOwners["${tag}"][${i}]`,
          message: `归属者不能是 "${o}"（${parsed.kind}）`,
          hint: '只能填用户、分组或 autogroup',
        });
      }
    });
  });

  // ---------- 被 acls/ssh 引用的标签应已在 tagOwners 声明 ----------
  // （headscale 对未声明的标签并不报错，但那条规则永远不会命中，属于静默失效）

  // ---------- acls ----------
  (p.acls ?? []).forEach((rule, idx) => {
    const base = `acls[${idx}]`;

    if (rule.action !== 'accept') {
      issues.push({
        severity: 'error',
        path: `${base}.action`,
        message: `action 只能是 "accept"，当前是 "${String(rule.action)}"`,
        hint: 'headscale 不支持 deny 动作；「拒绝」由默认策略实现（未命中即拒绝）',
      });
    }

    const proto = parseProtocol(rule.proto);
    if (proto === null) {
      issues.push({
        severity: 'error',
        path: `${base}.proto`,
        message: `协议 "${rule.proto}" 不合法`,
        hint: 'headscale 不接受通配符 *，请写协议名（tcp/udp/icmp…）或 IANA 编号 0-255',
      });
    }

    if (!Array.isArray(rule.src) || rule.src.length === 0) {
      issues.push({ severity: 'error', path: `${base}.src`, message: '源不能为空' });
    } else {
      checkAliases(rule.src, p, `${base}.src`, { position: 'src', issues, knownTags });
    }

    if (!Array.isArray(rule.dst) || rule.dst.length === 0) {
      issues.push({ severity: 'error', path: `${base}.dst`, message: '目的不能为空' });
    } else {
      rule.dst.forEach((d, i) => {
        const path = `${base}.dst[${i}]`;
        const split = splitDestAndPort(d);
        if (!split) {
          issues.push({
            severity: 'error',
            path,
            message: `目的 "${d}" 格式非法`,
            hint: 'ACL 的 dst 必须带端口，形如 host:443、192.168.1.0/24:80,443 或 *:*',
          });
          return;
        }
        if (parsePortRange(split.port, rule.proto) === null) {
          issues.push({
            severity: 'error',
            path,
            message: `端口 "${split.port}" 非法`,
            hint: '支持单端口 443、区间 8000-8100、多个 80,443，或 *',
          });
        }
        const parsed = parseAlias(split.dest);
        if (!parsed) {
          issues.push({ severity: 'error', path, message: `目的别名 "${split.dest}" 无法识别` });
          return;
        }
        if (parsed.kind === 'autogroup') {
          checkAutogroup(parsed.value as AutoGroup, AUTOGROUP_FOR_DST, path, '目的', issues);
        }
        if (parsed.kind === 'group' && !(parsed.value in (p.groups ?? {}))) {
          issues.push({ severity: 'error', path, message: `groups 中未定义 "${parsed.value}"` });
        }
        if (parsed.kind === 'host' && !(parsed.value in (p.hosts ?? {}))) {
          issues.push({ severity: 'error', path, message: `hosts 中未定义 "${parsed.value}"` });
        }
      });
    }

    checkSelfRuleConstraint(
      { src: rule.src ?? [], dst: rule.dst ?? [] },
      base,
      issues,
    );
  });

  // ---------- ssh ----------
  (p.ssh ?? []).forEach((rule, idx) => {
    const base = `ssh[${idx}]`;
    if (!['accept', 'check', 'deny'].includes(rule.action)) {
      issues.push({
        severity: 'error',
        path: `${base}.action`,
        message: `SSH 动作 "${rule.action}" 非法`,
        hint: 'SSH 支持 accept / check / deny（与 ACL 不同）',
      });
    }
    if (!Array.isArray(rule.src) || rule.src.length === 0) {
      issues.push({ severity: 'error', path: `${base}.src`, message: '源不能为空' });
    } else {
      checkAliases(rule.src, p, `${base}.src`, { position: 'src', isSsh: true, issues, knownTags });
    }
    if (!Array.isArray(rule.dst) || rule.dst.length === 0) {
      issues.push({ severity: 'error', path: `${base}.dst`, message: '目的不能为空' });
    } else {
      checkAliases(rule.dst, p, `${base}.dst`, { position: 'dst', isSsh: true, issues, knownTags });
    }
    if (!Array.isArray(rule.users) || rule.users.length === 0) {
      issues.push({
        severity: 'error',
        path: `${base}.users`,
        message: 'SSH 规则必须指定 users',
        hint: '例如 ["root"]、["autogroup:nonroot"] 或 ["*"]',
      });
    }
  });

  // ---------- nodeAttrs ----------
  (p.nodeAttrs ?? []).forEach((grant, idx) => {
    const base = `nodeAttrs[${idx}]`;
    if (!Array.isArray(grant.target) || grant.target.length === 0) {
      issues.push({ severity: 'error', path: `${base}.target`, message: 'target 不能为空' });
    } else {
      grant.target.forEach((t, i) => {
        const parsed = parseAlias(t);
        if (!parsed) {
          issues.push({ severity: 'error', path: `${base}.target[${i}]`, message: `无法识别的 target "${t}"` });
          return;
        }
        if (parsed.kind === 'autogroup') {
          checkAutogroup(parsed.value as AutoGroup, AUTOGROUP_FOR_NODE_ATTRS, `${base}.target[${i}]`, 'nodeAttrs 目标', issues);
        }
      });
    }
    if ((!grant.attr || grant.attr.length === 0) && (!grant.ipPool || grant.ipPool.length === 0)) {
      issues.push({
        severity: 'warning',
        path: base,
        message: '该 nodeAttrs 条目既没有 attr 也没有 ipPool，不会产生任何效果',
      });
    }
  });

  // ---------- autoApprovers ----------
  Object.entries(p.autoApprovers?.routes ?? {}).forEach(([route, approvers]) => {
    const path = `autoApprovers.routes["${route}"]`;
    if (!/^[0-9a-fA-F.:]+\/\d{1,3}$/.test(route)) {
      issues.push({ severity: 'error', path, message: `路由 "${route}" 不是合法的 CIDR` });
    }
    if (!Array.isArray(approvers) || approvers.length === 0) {
      issues.push({ severity: 'error', path, message: '自动批准者不能为空' });
    }
  });

  // ---------- 通用：整体可解析性 ----------
  const stats = {
    acls: p.acls?.length ?? 0,
    grants: p.grants?.length ?? 0,
    ssh: p.ssh?.length ?? 0,
    groups: Object.keys(p.groups ?? {}).length,
    hosts: Object.keys(p.hosts ?? {}).length,
    tagOwners: Object.keys(p.tagOwners ?? {}).length,
    nodeAttrs: p.nodeAttrs?.length ?? 0,
    autoApproverRoutes: Object.keys(p.autoApprovers?.routes ?? {}).length,
    autoApproverExitNodes: (p.autoApprovers?.exitNode ?? []).length,
    bytes: Buffer.byteLength(rawText, 'utf8'),
  };

  return { ok: !issues.some((i) => i.severity === 'error'), issues, stats };
}
