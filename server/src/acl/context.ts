/**
 * ACL 求值上下文的统一构造。
 *
 * 为什么单独抽出来：
 * 「把 headscale 的节点/用户 + 当前策略组装成 EvalInput」这件事，
 * 访问检查（/api/acl/check）和网络拓扑（/api/topology）都要做。
 * 两处各写一遍字段映射，早晚会出现「一处漏了 isExitNode」这类
 * 静默不一致——而这类不一致会直接导致连边判断和单点检查结论相反。
 *
 * 语义要点（都来自实测踩坑，改动前先看 docs/acl-semantics.md）：
 * · `displayName` 优先 `givenName`：headscale 的 RenameNode 改的是 givenName，
 *   而 ACL 的 hosts/user 匹配也用展示名，不能拿原始 name。
 * · `isExitNode` 必须显式判定 0.0.0.0/0 与 ::/0：出口节点的"能到所有地址"
 *   与普通节点的"路由覆盖"在求值里是两回事。
 * · 标签设备没有 user 归属（上游两接口不一致），userName 置 null，
 *   由求值引擎按 tags 身份处理。
 */

import { cachedNodes, cachedPolicy, cachedUsers } from '../services/hs-cache.ts';
import { interpretPolicy, type AclPolicy, type PolicyInterpretation } from './model.ts';
import type { EvalInput, EvalNode } from './evaluator.ts';
import type { HsNode } from '../headscale/client.ts';
import { readCurrentPolicy } from '../services/acl-versions.ts';

export interface AclEvalContext extends EvalInput {
  /** 策略模式（全通 / 全禁 / 规则） */
  mode: PolicyInterpretation['mode'];
  interpretation: PolicyInterpretation;
  /** 策略来源说明，用于告知用户看的是哪一份策略 */
  source: string;
  /** 原始节点列表（前端展示需要 online / expiry 等求值不需要的字段） */
  rawNodes: HsNode[];
}

/** 构造求值上下文；policy 可显式传入（用于草稿预览） */
export async function loadAclEvalContext(policy?: AclPolicy | null): Promise<AclEvalContext> {
  let effective: AclPolicy | null;
  let source = 'headscale 当前策略';
  if (policy !== undefined) {
    effective = policy;
    source = '草稿策略（实时预览）';
  } else {
    const cur = await readCurrentPolicy();
    effective = cur.parsed;
  }

  // 走共享读缓存：同一次请求里的节点/用户与采样器、其它页面共享同一份上游数据，
  // 且并发查询会合并成一次真实请求（单飞），不再每个调用方各拉一遍。
  const [nodes, users] = await Promise.all([cachedNodes(), cachedUsers()]);

  const evalNodes: EvalNode[] = nodes.map((n) => {
    const approved = n.approvedRoutes ?? [];
    return {
      id: Number(n.id),
      name: n.name,
      displayName: (n.givenName ?? '').trim() || n.name,
      ips: n.ipAddresses ?? [],
      tags: n.tags ?? [],
      userName: n.user?.name ?? null,
      approvedRoutes: approved,
      isExitNode: approved.some((r) => r === '0.0.0.0/0' || r === '::/0'),
    };
  });

  const interpretation = interpretPolicy(effective);

  return {
    policy: effective,
    nodes: evalNodes,
    users: users.map((u) => ({ id: Number(u.id), name: u.name, email: u.email ?? null })),
    mode: interpretation.mode,
    interpretation,
    source,
    rawNodes: nodes,
  };
}
