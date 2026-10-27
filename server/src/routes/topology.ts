/**
 * 网络拓扑路由（P4）
 *
 * 产出「设备 + 用户 + 允许的访问边」，供前端画拓扑图。
 *
 * ## 为什么边要从 ACL 求值算，而不是照抄策略文本
 * 策略里的 `src`/`dst` 是选择器（`user@`、`tag:x`、`group:g`、CIDR、hosts 别名），
 * 一条规则可能横跨多台设备，也可能一条都命中不了；再叠加 `autogroup:self`、
 * 出口节点、子网路由这些语义，**手工在图上画规则是画不准的**。
 * 所以这里逐对调用 P3 的 `checkAccess()`——它已经把这些语义调对了，
 * 拓扑与「访问检查」用同一套引擎，结论才不会自相矛盾。
 *
 * ## 复杂度与上限
 * 逐对求值是 O(N²)。检查本身是纯内存集合运算（微秒级），
 * N=50 → 2450 对，实测 < 50ms，完全够用。
 * 超过上限就**截断并明确告知**（`truncated: true`），
 * 不做静默省略——少画的边会被误读成「不允许访问」。
 *
 * ## allow-all / deny-all 不画边
 * 全通时任意两台都互通，画 N² 条箭头只会糊成一团，且没有信息量。
 * 这时返回 `edges: []` + `mode` + 解释，由前端显示醒目横幅。
 * 全禁同理（没有边就是结论本身）。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requirePermission } from '../auth/guard.ts';
import { loadAclEvalContext } from '../acl/context.ts';
import { checkAccess } from '../acl/evaluator.ts';

/** 逐对求值的上限（N² 控制）。超过则截断并告知 */
const MAX_PAIRS = 4000;

interface TopoNode {
  id: number;
  name: string;
  displayName: string;
  ips: string[];
  online: boolean;
  expired: boolean;
  user: string | null;
  tags: string[];
  isExitNode: boolean;
  approvedRoutes: string[];
  /** 设备身份类型：标签设备已脱离用户归属，展示上要区分 */
  identity: 'user' | 'tagged';
}

interface TopoEdge {
  from: number;
  to: number;
  /** 命中的规则序号（0 基），便于前端回指到策略编辑器 */
  ruleIndex: number | null;
  matchedSrc: string;
  matchedDst: string;
}

export async function registerTopologyRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/topology',
    { preHandler: requirePermission('node:read') },
    async (req, reply) => {
      const q = z
        .object({
          /** 只返回在线设备之间的边，减少噪音 */
          onlineOnly: z
            .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
            .optional(),
        })
        .safeParse(req.query);
      if (!q.success) {
        return reply.code(400).send({ error: 'BAD_QUERY', message: 'onlineOnly 取值非法' });
      }
      const onlineOnly = q.data.onlineOnly === '1' || q.data.onlineOnly === 'true';

      const ctx = await loadAclEvalContext();

      // ---------------------------------------------------------------- 节点
      const now = Date.now();
      const topoNodes: TopoNode[] = ctx.nodes.map((n) => {
        const raw = ctx.rawNodes.find((r) => Number(r.id) === n.id);
        // listNodes() 是上游原始对象，没有 shapeNode() 计算出的 expired 字段，
        // 这里按同样规则自己算：永不过期（零值/ null）视为未过期
        const expiry = raw?.expiry;
        const neverExpires = !expiry || String(expiry).startsWith('0001-01-01');
        const expired = !neverExpires && new Date(expiry as string).getTime() <= now;
        return {
          id: n.id,
          name: n.name,
          displayName: n.displayName,
          ips: n.ips,
          online: Boolean(raw?.online),
          expired,
          user: n.userName,
          tags: n.tags,
          isExitNode: n.isExitNode,
          approvedRoutes: n.approvedRoutes.filter((r) => r !== '0.0.0.0/0' && r !== '::/0'),
          // 有标签即视为标签身份（headscale 里 user 与 tags 互斥且不可逆）
          identity: n.tags.length > 0 ? 'tagged' : 'user',
        };
      });

      const considered = onlineOnly ? topoNodes.filter((n) => n.online) : topoNodes;

      // ---------------------------------------------------------------- 边
      let edges: TopoEdge[] = [];
      let truncated = false;
      let pairCount = 0;

      if (ctx.mode === 'rules') {
        outer: for (const a of considered) {
          for (const b of considered) {
            if (a.id === b.id) continue;
            if (pairCount >= MAX_PAIRS) {
              truncated = true;
              break outer;
            }
            pairCount += 1;
            const r = checkAccess(
              { policy: ctx.policy, nodes: ctx.nodes, users: ctx.users },
              { from: { nodeId: a.id }, to: { nodeId: b.id } },
            );
            if (r.allowed) {
              const m = r.matched[0];
              edges.push({
                from: a.id,
                to: b.id,
                ruleIndex: m?.index ?? null,
                matchedSrc: m?.matchedSrc ?? '',
                matchedDst: m?.matchedDst ?? '',
              });
            }
          }
        }
      } else {
        // allow-all / deny-all：不画边，由 mode 表达结论
        pairCount = considered.length * Math.max(0, considered.length - 1);
      }

      // 同一对节点可能命中多条规则，图上只保留一条（否则箭头重叠不可读）
      const seen = new Set<string>();
      edges = edges.filter((e) => {
        const k = `${e.from}->${e.to}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      // ---------------------------------------------------------------- 用户聚合
      const userMap = new Map<string, number>();
      for (const n of topoNodes) {
        const key = n.user ?? 'tagged-devices';
        userMap.set(key, (userMap.get(key) ?? 0) + 1);
      }

      return reply.send({
        mode: ctx.mode,
        explanation: ctx.interpretation.explanation,
        highImpact: ctx.interpretation.highImpact,
        source: ctx.source,
        nodes: topoNodes,
        edges,
        users: [...userMap.entries()].map(([name, deviceCount]) => ({ name, deviceCount })),
        stats: {
          nodeCount: topoNodes.length,
          consideredCount: considered.length,
          pairEvaluated: pairCount,
          allowedEdges: edges.length,
          maxPairs: MAX_PAIRS,
          truncated,
        },
        notes: {
          edges:
            ctx.mode === 'rules'
              ? '边来自逐对 ACL 求值（与「访问检查」同一引擎），箭头方向即允许方向。'
              : '当前策略处于全通或全禁模式，不绘制逐对连线——' +
                '全通时任意两台互通，画出来只会糊成一团；全禁时没有边就是结论。',
          traffic:
            '拓扑只表达控制面可达性（ACL 放行关系）。数据面流量不经过 headscale，' +
            '因此图中连线不代表有流量经过。',
        },
      });
    },
  );
}
