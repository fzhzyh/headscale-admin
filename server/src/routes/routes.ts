/**
 * 路由（子网路由）管理。
 *
 * v0.29.6 的实现方式：POST /api/v1/node/{id}/approve_routes，body { nodeId, routes }
 * —— 注意是「全量覆盖」语义：传入的 routes 就是最终启用集合，不是增量。
 * 因此这里做的是「读当前 → 增删一条 → 写回」的读改写，必须处理并发覆盖问题。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hs } from '../services/headscale.ts';
import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { audit } from '../services/audit.ts';
import { notifyChanged } from '../realtime/hub.ts';

interface RouteRow {
  nodeId: number;
  nodeName: string;
  userName: string | null;
  online: boolean;
  route: string;
  approved: boolean;
  /** 是否为 exit node（0.0.0.0/0 或 ::/0） */
  isExit: boolean;
}

function toRows(
  nodes: Awaited<ReturnType<ReturnType<typeof hs>['listNodes']>>,
): RouteRow[] {
  const rows: RouteRow[] = [];
  for (const n of nodes) {
    const approved = new Set(n.approvedRoutes ?? []);
    // availableRoutes 是节点已通告但未批准的；approvedRoutes 是已批准的。
    // 两者并集才是「该设备发布的所有路由」全貌。
    const all = new Set<string>([...(n.availableRoutes ?? []), ...(n.approvedRoutes ?? [])]);
    for (const route of all) {
      rows.push({
        nodeId: Number(n.id),
        nodeName: n.name,
        userName: n.user?.name ?? null,
        online: Boolean(n.online),
        route,
        approved: approved.has(route),
        isExit: route === '0.0.0.0/0' || route === '::/0',
      });
    }
  }
  return rows;
}

export async function registerRouteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/routes', { preHandler: requirePermission('route:read') }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const nodes = await hs().listNodes();
    let rows = toRows(nodes);
    if (q.status === 'enabled') rows = rows.filter((r) => r.approved);
    if (q.status === 'disabled') rows = rows.filter((r) => !r.approved);
    if (q.user) rows = rows.filter((r) => r.userName === q.user);
    if (q.nodeId) rows = rows.filter((r) => r.nodeId === Number(q.nodeId));
    if (q.search) {
      const s = q.search.toLowerCase();
      rows = rows.filter((r) => `${r.nodeName} ${r.route} ${r.userName ?? ''}`.toLowerCase().includes(s));
    }
    return reply.send({
      total: rows.length,
      enabled: rows.filter((r) => r.approved).length,
      routes: rows,
    });
  });

  /**
   * 启用/禁用一条路由。
   * 实现要点：approve_routes 是全量覆盖语义，所以必须先取当前已批准集合再增删，
   * 并回传最终集合便于前端确认。
   */
  app.post('/api/routes/toggle', { preHandler: requirePermission('route:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const parsed = z
      .object({
        nodeId: z.number().int().positive(),
        route: z.string().min(1),
        enable: z.boolean(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });
    const { nodeId, route, enable } = parsed.data;

    const node = await hs().getNode(nodeId);
    const current = new Set(node.approvedRoutes ?? []);
    const before = [...current];

    if (enable) current.add(route);
    else current.delete(route);

    // 安全检查：禁用 exit node 路由会影响全网出口，明确提示
    if (!enable && (route === '0.0.0.0/0' || route === '::/0')) {
      const otherExit = (node.approvedRoutes ?? []).filter((r) => r !== route && (r === '0.0.0.0/0' || r === '::/0'));
      if (otherExit.length === 0) {
        // 允许操作，但记录高危标记，前端已二次确认
        audit({
          userId: ctx.user.id,
          username: ctx.user.username,
          ip: req.ip,
          action: 'route.disable_exit_node',
          targetType: 'node',
          targetId: nodeId,
          detail: { route, nodeName: node.name, warn: '该设备将不再作为出口节点' },
        });
      }
    }

    const updated = await hs().setApprovedRoutes(nodeId, Array.from(current));
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: enable ? 'route.enable' : 'route.disable',
      targetType: 'node',
      targetId: nodeId,
      detail: { nodeName: node.name, route, before, after: Array.from(current) },
    });
    notifyChanged('routes', 'routes.changed', {
      data: { nodeId, approvedRoutes: updated.approvedRoutes ?? Array.from(current) },
    });
    notifyChanged('nodes', 'nodes.changed', { changed: [{ id: nodeId }] });
    return reply.send({
      ok: true,
      nodeId,
      approvedRoutes: updated.approvedRoutes ?? Array.from(current),
      availableRoutes: updated.availableRoutes ?? [],
    });
  });

  /** 批量设置某节点的路由集合（全量覆盖，UI 上用「保存」按钮触发） */
  app.put('/api/routes/node/:nodeId', { preHandler: requirePermission('route:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;
    const nodeId = Number((req.params as { nodeId: string }).nodeId);
    const parsed = z.object({ routes: z.array(z.string()) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const node = await hs().getNode(nodeId);
    const before = node.approvedRoutes ?? [];
    // 实测（v0.29.6）：上游**允许**批准设备未通告的路由（返回 200 并真的写入），
    // 但这会形成路由黑洞——客户端永远收不到该网段的流量。
    // 因此这里不硬拒绝，而是要求显式确认；面板保留这个护栏是因为上游没有。
    const advertised = new Set([...(node.availableRoutes ?? []), ...(node.approvedRoutes ?? [])]);
    const unadvertised = parsed.data.routes.filter((r) => !advertised.has(r));
    const body = (req.body ?? {}) as { confirmUnadvertised?: boolean };
    if (unadvertised.length > 0 && body.confirmUnadvertised !== true) {
      return reply.code(409).send({
        error: 'NOT_ADVERTISED',
        message: `以下路由当前未被该设备通告，批准后不会生效（路由黑洞）：${unadvertised.join(', ')}。如确认要预先批准，请勾选「强制批准」`,
        unadvertised,
        advertised: Array.from(advertised),
      });
    }

    const updated = await hs().setApprovedRoutes(nodeId, parsed.data.routes);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'route.set',
      targetType: 'node',
      targetId: nodeId,
      detail: { nodeName: node.name, before, after: parsed.data.routes, unadvertisedApproved: unadvertised },
    });
    notifyChanged('routes', 'routes.changed', { data: { nodeId, approvedRoutes: updated.approvedRoutes ?? [] } });
    notifyChanged('nodes', 'nodes.changed', { changed: [{ id: nodeId }] });
    return reply.send({ ok: true, approvedRoutes: updated.approvedRoutes ?? [], unadvertisedApproved: unadvertised });
  });
}
