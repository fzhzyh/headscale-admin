/**
 * 网络拓扑路由（P4 / 树状重构）
 *
 * ## 图为什么是「树」而不是「网格」
 * 数据面是 WireGuard：**每个设备都接入同一张由控制面协调的加密虚拟网络**，
 * 设备之间不存在「一对一专用链路」。用网格画 N×(N-1) 条箭头是在暗示
 * 一种并不存在的物理连接，设备一多就糊成一团，且「少画一条」会被误读成
 * 「不允许访问」——这类误读比没有图更危险。
 *
 * 所以拓扑改成两层树：
 *
 *      [ WireGuard 虚拟专用网络 (VPC) ]        ← 第一层：唯一根节点
 *         │      │      │      │
 *         ●      ●      ●      ●              ← 第二层：设备，各自与 VPC 相连
 *
 * 根节点到设备的连线表达「这台设备当前是否在这张网里、状态是否健康」，
 * 而不是「它和另一台设备之间有一条线」。
 *
 * ## 状态判定（本路由的核心产出）
 * 对每台设备计算「是否与**所有在线设备**互通」，三态：
 *   - `ok`      绿：与全部在线设备双向可达
 *   - `partial` 橙：存在无法互通的在线设备（前端悬停时高亮那些设备）
 *   - `offline` 灰：设备离线，不参与互通判定
 *
 * 「互通」按**双向**判定（A→B 且 B→A 都放行）。只判单向会得出
 * 「A 能访问 B，所以它们互通」的错误结论——而单向放行恰恰是最常见的故障形态。
 *
 * ## 复杂度与内存
 * 求值次数是 O(N²)，但这里**不保留 N² 的中间结果**：
 *   · 按无序对一次求两个方向，结论直接累加到两端节点，
 *     不再建 `Map<"a|b", boolean>` 可达矩阵、不再做第二遍 N² 拼键查询；
 *   · 不通明细与放行边明细都按上限截断，精确数量单独计数；
 *   · 求值引擎共享请求级 EvalCache，批量场景关闭 trace 字符串构建；
 *   · allow-all / deny-all 直接短路，完全不跑求值引擎。
 * 超过上限**截断并明确告知**，只有「确实未求值」的节点保守判为 partial，
 * 已完整求值的节点照常显示绿色——宁可显示「可能有问题」，也不谎报全通。
 *
 * ## allow-all / deny-all 也照样给状态
 * 全通时全部在线设备为绿；全禁时全部为橙。不去画 N² 条箭头，
 * 由 `mode` + 解释文案表达结论。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { requirePermission } from '../auth/guard.ts';
import { loadAclEvalContext } from '../acl/context.ts';
import { checkAccess, createEvalCache } from '../acl/evaluator.ts';

/** 逐对求值的上限（有向对数）。超过则截断并告知，未评估的对保守判为 partial */
const MAX_PAIRS = 20000;
/**
 * 单个节点最多返回多少条「不通」明细。
 * 旧实现为每台设备生成 (N-1) 个 reason 对象 + (N-1) 个 id，
 * deny-all 或大规模场景下一个响应就是 O(N²) 个对象（N=200 时约 4 万个），
 * 而这些明细只用于悬停卡片展示——截断不影响结论，只影响展示条数。
 * 精确总数由 `unreachableCount` 给出。
 */
const MAX_UNREACHABLE_PER_NODE = 100;
/**
 * 响应里最多保留多少条逐对放行明细。树状图**不渲染** edges，
 * 保留一小段仅供「访问检查」交叉核对与脚本验证；全量 N² 明细纯属浪费内存。
 * 精确放行总数由 `stats.allowedEdges` 给出。
 */
const MAX_EDGES_IN_RESPONSE = 2000;

/** 设备在树状拓扑中的连通状态 */
export type ReachStatus = 'ok' | 'partial' | 'offline';

interface UnreachableReason {
  id: number;
  name: string;
  reason: string;
}

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
  /** 与全部在线设备是否互通；offline 表示不参与判定 */
  reachStatus: ReachStatus;
  /** 无法互通的在线设备总数（明细可能被截断，此值始终精确） */
  unreachableCount: number;
  /** 无法互通的在线设备 ID（悬停高亮用，最多 MAX_UNREACHABLE_PER_NODE 条） */
  unreachableIds: number[];
  /** 无法互通的原因（按对给出，便于悬停时解释「为什么不通」） */
  unreachableReasons: UnreachableReason[];
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
          /**
           * 兼容旧参数。树状拓扑的互通判定**只针对在线设备**（离线设备没有
           * 可判状态），因此该参数不再影响结果，保留仅为不破坏既有调用方。
           */
          onlineOnly: z
            .union([z.literal('1'), z.literal('0'), z.literal('true'), z.literal('false')])
            .optional(),
        })
        .safeParse(req.query);
      if (!q.success) {
        return reply.code(400).send({ error: 'BAD_QUERY', message: 'onlineOnly 取值非法' });
      }

      const ctx = await loadAclEvalContext();

      // ---------------------------------------------------------------- 节点
      const now = Date.now();
      // 原始节点按 id 建索引：原来在 map 里对每个节点做一次 find（O(N²)）
      const rawById = new Map<number, (typeof ctx.rawNodes)[number]>();
      for (const r of ctx.rawNodes) rawById.set(Number(r.id), r);

      const topoNodes: TopoNode[] = ctx.nodes.map((n) => {
        const raw = rawById.get(n.id);
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
          reachStatus: 'offline',
          unreachableCount: 0,
          unreachableIds: [],
          unreachableReasons: [],
        };
      });

      // 参与互通判定的是「在线设备」——离线设备没有可判状态
      const online = topoNodes.filter((n) => n.online);

      // ---------------------------------------------------------------- 互通判定
      // 旧实现：N×N 的 Map<string, boolean>（键是模板字符串）+ 全量 edges 明细，
      // 之后再来一遍 N×N 拼键查询、拼原因。N=140 时是 2 万条字符串键、
      // 2 万个边对象、4 万次字符串拼接——这是整个面板最重的 CPU / GC 热点。
      //
      // 现在按「无序对」一次算出双向结论并直接累加到两端节点：
      //   · 不再需要可达矩阵，也不再需要第二遍 N×N 遍历
      //   · 明细按上限截断，精确数量单独由计数给出
      //   · 全通 / 全禁直接短路，完全不跑求值引擎
      const edges: TopoEdge[] = [];
      let pairCount = 0;
      let allowedEdges = 0;
      let truncated = false;

      const n = online.length;
      const totalNeighbors = Math.max(0, n - 1);
      // 定长数组，下标 = 在线设备序号：零哈希开销，比 Map<number, …> 更省
      const ids: number[][] = Array.from({ length: n }, () => []);
      const reasons: UnreachableReason[][] = Array.from({ length: n }, () => []);
      const counts = new Int32Array(n);
      const evaluated = new Int32Array(n);
      const onlineIndex = new Map<number, number>();
      for (let i = 0; i < n; i += 1) onlineIndex.set(online[i]!.id, i);

      const addBlocked = (i: number, other: TopoNode, reason: string): void => {
        counts[i] = (counts[i] ?? 0) + 1;
        if (ids[i]!.length < MAX_UNREACHABLE_PER_NODE) {
          ids[i]!.push(other.id);
          reasons[i]!.push({ id: other.id, name: other.displayName, reason });
        }
      };

      /** 从「本机」视角解释为什么不通 */
      const reasonOf = (outbound: boolean, inbound: boolean): string => {
        if (!outbound && !inbound) return '双向都没有放行规则';
        if (!outbound) return '本机无法访问对方（对方可访问本机）';
        return '对方无法访问本机（本机可访问对方）';
      };

      const recordEdge = (
        from: number,
        to: number,
        hit: { index: number; matchedSrc: string; matchedDst: string } | undefined,
      ): void => {
        allowedEdges += 1;
        if (edges.length < MAX_EDGES_IN_RESPONSE) {
          edges.push({
            from,
            to,
            ruleIndex: hit?.index ?? null,
            matchedSrc: hit?.matchedSrc ?? '',
            matchedDst: hit?.matchedDst ?? '',
          });
        }
      };

      if (ctx.mode === 'rules') {
        const cache = createEvalCache();
        const input = { policy: ctx.policy, nodes: ctx.nodes, users: ctx.users };

        // 无序对 (i, j) 一次求两个方向；预算仍按「有向对数」计，与旧口径一致。
        outer: for (let i = 0; i < n; i += 1) {
          const a = online[i]!;
          for (let j = i + 1; j < n; j += 1) {
            if (pairCount + 2 > MAX_PAIRS) {
              truncated = true;
              break outer;
            }
            const b = online[j]!;
            pairCount += 2;
            // trace 关掉：拓扑不展示 trace，每对拼十几条说明纯属浪费 GC
            const ab = checkAccess(input, { from: { nodeId: a.id }, to: { nodeId: b.id } }, { cache, trace: false });
            const ba = checkAccess(input, { from: { nodeId: b.id }, to: { nodeId: a.id } }, { cache, trace: false });
            if (ab.allowed) recordEdge(a.id, b.id, ab.matched[0]);
            if (ba.allowed) recordEdge(b.id, a.id, ba.matched[0]);
            evaluated[i] = (evaluated[i] ?? 0) + 1;
            evaluated[j] = (evaluated[j] ?? 0) + 1;
            // 「互通」按双向判定：单向放行是最常见的故障形态，只判单向会谎报绿。
            if (ab.allowed && ba.allowed) continue;
            addBlocked(i, b, reasonOf(ab.allowed, ba.allowed));
            addBlocked(j, a, reasonOf(ba.allowed, ab.allowed));
          }
        }
      } else {
        // 全通 / 全禁的结论与具体设备无关：既不跑求值引擎，也不建可达矩阵。
        const allowAll = ctx.mode === 'allow-all';
        pairCount = n * totalNeighbors;
        allowedEdges = allowAll ? pairCount : 0;
        for (let i = 0; i < n; i += 1) evaluated[i] = totalNeighbors;

        if (allowAll) {
          // 只保留一小段明细供脚本交叉核对；页面不渲染 edges。
          for (let i = 0; i < n && edges.length < MAX_EDGES_IN_RESPONSE; i += 1) {
            for (let j = 0; j < n && edges.length < MAX_EDGES_IN_RESPONSE; j += 1) {
              if (i === j) continue;
              edges.push({ from: online[i]!.id, to: online[j]!.id, ruleIndex: null, matchedSrc: '', matchedDst: '' });
            }
          }
        } else {
          for (let i = 0; i < n; i += 1) {
            counts[i] = totalNeighbors;
            const limit = Math.min(totalNeighbors, MAX_UNREACHABLE_PER_NODE);
            for (let k = 0; k < limit; k += 1) {
              const other = online[k >= i ? k + 1 : k]!;
              ids[i]!.push(other.id);
              reasons[i]!.push({ id: other.id, name: other.displayName, reason: '双向都没有放行规则' });
            }
          }
        }
      }

      // 截断：未求值的对保守判为不通。不逐对补 ID（那等于把 O(N²) 明细又请回来），
      // 只累计精确数量 + 一条汇总原因；页面顶部已有截断告警。
      if (truncated) {
        for (let i = 0; i < n; i += 1) {
          const missing = totalNeighbors - (evaluated[i] ?? 0);
          if (missing <= 0) continue;
          counts[i] = (counts[i] ?? 0) + missing;
          if (reasons[i]!.length < MAX_UNREACHABLE_PER_NODE) {
            reasons[i]!.push({
              id: -1,
              name: `另有 ${missing} 对未评估`,
              reason: '超出逐对求值上限，未评估（保守判为可能不通）',
            });
          }
        }
      }

      // ---------------------------------------------------------------- 状态回填
      for (const node of topoNodes) {
        if (!node.online) {
          node.reachStatus = 'offline';
          continue;
        }
        const i = onlineIndex.get(node.id);
        if (i === undefined) {
          node.reachStatus = 'partial'; // 理论不会发生；保守判为异常而不是谎报正常
          continue;
        }
        node.unreachableCount = counts[i] ?? 0;
        node.unreachableIds = ids[i]!;
        node.unreachableReasons = reasons[i]!;
        node.reachStatus = node.unreachableCount === 0 ? 'ok' : 'partial';
      }

      // ---------------------------------------------------------------- 用户聚合
      const userMap = new Map<string, number>();
      for (const n of topoNodes) {
        const key = n.user ?? 'tagged-devices';
        userMap.set(key, (userMap.get(key) ?? 0) + 1);
      }

      const okCount = topoNodes.filter((n) => n.reachStatus === 'ok').length;
      const partialCount = topoNodes.filter((n) => n.reachStatus === 'partial').length;
      const offlineCount = topoNodes.filter((n) => n.reachStatus === 'offline').length;

      return reply.send({
        mode: ctx.mode,
        explanation: ctx.interpretation.explanation,
        highImpact: ctx.interpretation.highImpact,
        source: ctx.source,
        /** 树状拓扑的根节点（第一层）。由后端下发，前端不写死文案 */
        vpc: {
          id: 'vpc',
          label: 'WireGuard 虚拟专用网络',
          subLabel: 'VPC · 控制面协调的同一张加密网络',
        },
        nodes: topoNodes,
        /**
         * 逐对 ACL 放行关系。**树状图不渲染它**（设备之间没有专属链路，
         * 画线会误导）；只保留前 MAX_EDGES_IN_RESPONSE 条供交叉核对，
         * 精确总数见 stats.allowedEdges。
         */
        edges,
        users: [...userMap.entries()].map(([name, deviceCount]) => ({ name, deviceCount })),
        stats: {
          nodeCount: topoNodes.length,
          onlineCount: online.length,
          okCount,
          partialCount,
          offlineCount,
          consideredCount: online.length,
          pairEvaluated: pairCount,
          allowedEdges,
          maxPairs: MAX_PAIRS,
          truncated,
        },
        notes: {
          edges:
            '设备间不存在一对一专属链路——所有设备都接入同一张 WireGuard 虚拟网络。' +
            '树状图只表达「设备是否在这张网里、能否与在线设备互通」，互连箭头图不再使用。' +
            `edges 明细最多返回 ${MAX_EDGES_IN_RESPONSE} 条，精确数量见 stats.allowedEdges。`,
          status:
            '绿色 = 与全部在线设备双向可达；橙色 = 存在无法互通的在线设备（悬停高亮）；灰色 = 设备离线。',
          traffic:
            '拓扑只表达控制面可达性（ACL 放行关系）。数据面流量不经过 headscale，' +
            '设备之间由 WireGuard 直连或经 DERP 中继。',
        },
      });
    },
  );
}

export type { TopoNode, TopoEdge };
