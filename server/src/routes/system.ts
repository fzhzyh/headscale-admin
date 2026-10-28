/**
 * 系统路由：健康检查、版本、总览、审计日志。
 */
import type { FastifyInstance } from 'fastify';
import { get } from '../db/index.ts';
import { panelStats } from '../db/seed.ts';
import { queryAudit } from '../services/audit.ts';
import { authOr401, requirePermission } from '../auth/guard.ts';
import { hs, testConnection } from '../services/headscale.ts';
import { getSetting } from '../services/settings.ts';
import { PERMISSIONS, ALL_PERMISSIONS } from '../auth/rbac.ts';
import { isNeverExpiring } from './nodes.ts';

/**
 * 版本号来自 version.ts（单一真源：git tag → package.json → 运行期读取）。
 * 这里再导出一次，保持既有 `import { PANEL_VERSION } from './routes/system.ts'` 可用。
 */
export { PANEL_VERSION, TARGET_HEADSCALE } from '../version.ts';
import { PANEL_VERSION, TARGET_HEADSCALE } from '../version.ts';

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  // 存活探针：不查上游，供容器编排使用
  app.get('/api/system/health', async (_req, reply) => {
    const dbOk = (() => {
      try {
        get('SELECT 1 AS ok');
        return true;
      } catch {
        return false;
      }
    })();
    return reply.code(dbOk ? 200 : 503).send({
      ok: dbOk,
      db: dbOk,
      panelVersion: PANEL_VERSION,
      targetHeadscale: TARGET_HEADSCALE,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/system/version', async (_req, reply) =>
    reply.send({
      panelVersion: PANEL_VERSION,
      targetHeadscale: TARGET_HEADSCALE,
      // 以下为关键 API 兼容性说明，前端「关于」页会展示
      notes: [
        'Headscale v0.29 起 last_successful_update / updated_at / valid_tags / invalid_tags / forced_tags 已从 API 移除',
        'Headscale v0.29 起 randomize_client_port 由 config 迁移到 ACL 策略',
        'RenameNode 修改的是 givenName；name 是客户端上报的主机名，面板展示以 givenName 优先',
        'ExpireNode / RegisterNode / DeletePreAuthKey 的 HTTP 注解没有 body 绑定，参数必须走查询字符串，请求体会被静默忽略',
        'policy/check 会同时校验语法与语义（action 合法性、tag / host 引用是否存在），可作为保存前的强校验',
        'approve_routes 是全量覆盖语义，且上游不校验路由是否真的被设备通告，面板为此加了「强制批准」护栏',
        '节点 expiry 为 null 或 0001-01-01T00:00:00Z 均表示永不过期',
      ],
    }),
  );

  // 会话初始化信息：权限目录 + 当前用户，减少前端首屏请求数
  app.get('/api/system/bootstrap', async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx) return;
    return reply.send({
      panelVersion: PANEL_VERSION,
      targetHeadscale: TARGET_HEADSCALE,
      permissionCatalog: PERMISSIONS,
      allPermissions: ALL_PERMISSIONS,
      headscale: {
        transport: getSetting('hs.transport') || 'rest',
        url: getSetting('hs.url'),
        hasApiKey: hs().hasApiKey(),
      },
      stats: panelStats(),
    });
  });

  // 总览：一次性拿到面板+上游概览，首页只发一个请求
  app.get(
    '/api/system/overview',
    { preHandler: requirePermission('node:read') },
    async (req, reply) => {
      const ctx = authOr401(req, reply);
      if (!ctx) return;

      const conn = await testConnection();
      let nodes: Awaited<ReturnType<ReturnType<typeof hs>['listNodes']>> = [];
      let users: Awaited<ReturnType<ReturnType<typeof hs>['listUsers']>> = [];
      let upstreamError: string | null = null;
      const panel = panelStats();

      if (conn.ok) {
        try {
          [nodes, users] = await Promise.all([hs().listNodes(), hs().listUsers()]);
        } catch (err) {
          upstreamError = err instanceof Error ? err.message : String(err);
        }
      } else {
        upstreamError = conn.error ?? '上游不可用';
      }

      const now = Date.now();
      const online = nodes.filter((n) => n.online).length;
      const routeEnabled = nodes.reduce((acc, n) => acc + (n.approvedRoutes?.length ?? 0), 0);
      const routeAvailable = nodes.reduce((acc, n) => acc + (n.availableRoutes?.length ?? 0), 0);
      const expiringSoon = nodes.filter((n) => {
        if (!n.expiry || isNeverExpiring(n.expiry)) return false;
        const t = new Date(n.expiry).getTime();
        return t > now && t - now < 7 * 24 * 3600 * 1000;
      }).length;
      const expired = nodes.filter((n) => n.expiry && !isNeverExpiring(n.expiry) && new Date(n.expiry).getTime() <= now).length;

      return reply.send({
        connection: conn,
        upstreamError,
        stats: {
          // 上游（Headscale）侧口径
          hsNodes: nodes.length,
          hsNodesOnline: online,
          hsNodesOffline: nodes.length - online,
          hsUsers: users.length,
          routeEnabled,
          routeAvailable,
          expiringSoon,
          expired,
          // 面板侧口径
          panelUsers: panel.users,
          panelGroups: panel.groups,
          resources: panel.resources,
          dnsRecords: panel.dnsRecords,
          aclVersions: panel.aclVersions,
          oauthClients: panel.oauthClients,
        },
        lastSyncAt: getSetting('system.lastSyncAt') || null,
      });
    },
  );

  // 审计日志
  app.get('/api/system/audit', { preHandler: requirePermission('audit:read') }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const result = queryAudit({
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
      ...(q.action ? { action: q.action } : {}),
      ...(q.username ? { username: q.username } : {}),
      ...(q.result ? { result: q.result } : {}),
      ...(q.since ? { since: q.since } : {}),
      ...(q.until ? { until: q.until } : {}),
    });
    return reply.send(result);
  });
}
