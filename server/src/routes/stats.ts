/**
 * 统计与监控路由（P4）
 *
 * 数据来源与**能力边界**：
 * ─────────────────────────────────────────────────────────────
 * · 在线状态 / 在线时长：来自 REST 轮询的 `online` + `lastSeen`，权威。
 * · 历史曲线：面板采样器 → InfluxDB（`node_status` / `cluster`）。
 * · **设备流量：无**。headscale 是控制面，数据面 WireGuard 流量在设备之间直连，
 *   不经过它；其 /metrics 只有 nodestore 内部计数，节点对象也无流量字段。
 *   本路由**不提供流量接口**——与其返回编造的数字，不如明确 501 并说明原因。
 *
 * 设计取舍：
 * 1. InfluxDB 不可用时**不报 5xx**，而是返回 `degraded: true` + 现有可得数据。
 *    监控面板本身挂掉比数据缺失更糟；前端据此显示「时序库不可用」提示条。
 * 2. 时长统计由面板**按采样点积分**得出，不依赖 Flux 的 integral()：
 *    采样间隔可能因重启/上游抖动而不均匀，自己算可以按实际间隔加权，
 *    并且能把「重启造成的空洞」如实标记出来，而不是平滑成一条直线。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from '../auth/guard.ts';
import { influxHealth, querySql, writeStats } from '../timeseries/influx.ts';
import { samplerStats } from '../timeseries/sampler.ts';
import { panelMetrics } from '../services/metrics.ts';
import { pushCounters, wsClientCount } from '../realtime/hub.ts';

/** 把查询结果的值转数字，非数字返回 null（而不是 0，避免污染） */
function num(v: string | number | boolean | null | undefined): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface Sample {
  t: number;
  v: number;
}

/**
 * 用采样点积分求「在线总时长」。
 * 相邻两点间隔若超过 maxGapSec，视为数据空洞（面板重启/上游中断），
 * 不计入在线时长，并单独累计 gapSec，让前端能提示「数据不完整」。
 */
function integrateOnline(
  samples: Sample[],
  maxGapSec = 90,
): { onlineSec: number; coveredSec: number; gapSec: number; samples: number } {
  let onlineSec = 0;
  let coveredSec = 0;
  let gapSec = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const cur = samples[i];
    // tsconfig 开了 noUncheckedIndexedAccess，下标访问需显式判空
    if (!prev || !cur) continue;
    const dt = cur.t - prev.t;
    if (dt <= 0) continue;
    if (dt > maxGapSec) {
      gapSec += dt;
      continue;
    }
    coveredSec += dt;
    // 用前一点的状态代表该区间的状态（采样是「状态快照」，非事件流）
    if (prev.v >= 1) onlineSec += dt;
  }
  return { onlineSec, coveredSec, gapSec, samples: samples.length };
}

export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- 健康与自检
  app.get('/api/stats/health', { preHandler: requirePermission('node:read') }, async () => {
    const influx = await influxHealth();
    return {
      ok: true,
      influx: {
        enabled: influx.ok,
        detail: influx.detail,
      },
      sampler: samplerStats(),
      writer: writeStats(),
      // 明确声明本面板不提供流量数据，避免前端/使用者误以为「还没实现」
      capabilities: {
        onlineStatus: true,
        onlineDuration: true,
        topology: true,
        aclMatrix: true,
        deviceTraffic: false,
      },
      notes: {
        deviceTraffic:
          'headscale 为控制面，数据面 WireGuard 流量在设备间直连，不经过 headscale；' +
          '其 /metrics 与节点对象均无流量字段，故本面板不提供设备流量统计。',
      },
    };
  });

  // ---------------------------------------------------------------- 集群曲线
  app.get(
    '/api/stats/cluster',
    { preHandler: requirePermission('node:read') },
    async (req, reply) => {
      const q = z
        .object({
          // 小时数，限制上限避免一次拉爆（90d 保留期内最多取 30 天）
          hours: z.coerce.number().int().min(1).max(720).default(6),
        })
        .safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'BAD_RANGE', message: 'hours 需为 1~720' });

      // InfluxDB 3 用 SQL（Flux 在 3.x 已移除）。tag/field 天然是列，
      // 不需要 2.x 那种 pivot 才能把 field 摊平成列。
      const sql = `SELECT time, nodes_total, nodes_online, nodes_offline, online_ratio,
       routes_available, routes_approved
FROM cluster
WHERE time >= now() - INTERVAL '${q.data.hours} hours'
ORDER BY time`;
      const { rows, error } = await querySql(sql);
      if (error) {
        return reply.send({ degraded: true, error, hours: q.data.hours, points: [] });
      }
      const points = rows.map((r) => ({
        t: r.time,
        nodesTotal: num(r.nodes_total),
        nodesOnline: num(r.nodes_online),
        nodesOffline: num(r.nodes_offline),
        onlineRatio: num(r.online_ratio),
        routesAvailable: num(r.routes_available),
        routesApproved: num(r.routes_approved),
      }));
      return reply.send({ degraded: false, hours: q.data.hours, points });
    },
  );

  // ---------------------------------------------------------------- 单节点曲线 + 时长
  app.get(
    '/api/stats/nodes/:id',
    { preHandler: requirePermission('node:read') },
    async (req, reply) => {
      const p = z
        .object({ id: z.coerce.number().int().positive() })
        .safeParse(req.params);
      if (!p.success) return reply.code(400).send({ error: 'BAD_ID', message: '节点 ID 非法' });
      const q = z
        .object({ hours: z.coerce.number().int().min(1).max(720).default(24) })
        .safeParse(req.query);
      if (!q.success) return reply.code(400).send({ error: 'BAD_RANGE', message: 'hours 需为 1~720' });

      const id = String(p.data.id);
      // node_id 由路由层强制为 int，不可能带引号，拼进 SQL 安全
      const sql = `SELECT time, name, online, online_streak_sec, last_seen_age_sec,
       routes_available, routes_approved
FROM node_status
WHERE node_id = '${id}' AND time >= now() - INTERVAL '${q.data.hours} hours'
ORDER BY time`;
      const { rows, error } = await querySql(sql);
      if (error) {
        return reply.send({ degraded: true, error, nodeId: p.data.id, hours: q.data.hours, points: [] });
      }

      const points = rows.map((r) => ({
        t: r.time,
        online: num(r.online) === 1,
        onlineStreakSec: num(r.online_streak_sec),
        lastSeenAgeSec: num(r.last_seen_age_sec),
        routesAvailable: num(r.routes_available),
        routesApproved: num(r.routes_approved),
      }));

      // 在线时长按采样点积分（见 integrateOnline 注释）
      const samples: Sample[] = rows
        .map((r) => {
          const t = r.time ? Math.floor(new Date(String(r.time)).getTime() / 1000) : NaN;
          return { t, v: num(r.online) ?? 0 };
        })
        .filter((s) => Number.isFinite(s.t));
      const uptime = integrateOnline(samples);

      return reply.send({
        degraded: false,
        nodeId: p.data.id,
        hours: q.data.hours,
        name: rows[0]?.name ?? null,
        points,
        uptime: {
          onlineSec: uptime.onlineSec,
          coveredSec: uptime.coveredSec,
          // 采样空洞：面板重启或上游不可达导致的缺口，如实暴露
          gapSec: uptime.gapSec,
          sampleCount: uptime.samples,
          // 只覆盖到的区间里算在线率，不对空洞做假设
          onlineRatio: uptime.coveredSec > 0 ? Math.round((uptime.onlineSec / uptime.coveredSec) * 1000) / 1000 : null,
        },
      });
    },
  );

  // ---------------------------------------------------------------- 全节点概览
  app.get('/api/stats/overview', { preHandler: requirePermission('node:read') }, async (_req, reply) => {
    const sql = `SELECT time, node_id, name, online
FROM node_status
WHERE time >= now() - INTERVAL '24 hours'
ORDER BY time`;
    const { rows, error } = await querySql(sql);
    if (error) return reply.send({ degraded: true, error, nodes: [] });

    // 按 node_id 聚合：取最后一次状态 + 在线点占比
    const byNode = new Map<string, { name: string; last: number; onlineSamples: number; totalSamples: number; firstT: number; lastT: number }>();
    for (const r of rows) {
      const id = r.node_id === null || r.node_id === undefined ? '' : String(r.node_id);
      if (!id || !r.time) continue;
      const t = new Date(String(r.time)).getTime();
      if (!Number.isFinite(t)) continue;
      const v = num(r.online) ?? 0;
      const name = r.name === null || r.name === undefined || r.name === '' ? id : String(r.name);
      const cur = byNode.get(id);
      if (!cur) {
        byNode.set(id, { name, last: v, onlineSamples: v >= 1 ? 1 : 0, totalSamples: 1, firstT: t, lastT: t });
      } else {
        cur.totalSamples += 1;
        if (v >= 1) cur.onlineSamples += 1;
        if (t >= cur.lastT) {
          cur.lastT = t;
          cur.last = v;
          cur.name = name || cur.name;
        }
        if (t < cur.firstT) cur.firstT = t;
      }
    }

    const nodes = [...byNode.entries()].map(([id, v]) => ({
      nodeId: Number(id),
      name: v.name,
      lastOnline: v.last >= 1,
      sampleRatio: v.totalSamples > 0 ? Math.round((v.onlineSamples / v.totalSamples) * 1000) / 1000 : null,
      sampleCount: v.totalSamples,
      observedFrom: new Date(v.firstT).toISOString(),
      observedTo: new Date(v.lastT).toISOString(),
    })).sort((a, b) => a.nodeId - b.nodeId);

    return reply.send({ degraded: false, windowHours: 24, nodes });
  });

  // ---------------------------------------------------------------- 面板自身控制面指标
  /**
   * 注意：这是**面板自己的**指标，不是设备流量。
   * 设备流量在 headscale 架构下不可得（见 /api/stats/traffic）。
   * 之所以做这个：面板是运维唯一入口，它慢/报错时用户第一反应是「网络坏了」。
   * 有 rpm / 5xx 率 / p95 就能区分「上游 headscale 慢」与「面板自己慢」。
   */
  app.get('/api/stats/panel', { preHandler: requirePermission('node:read') }, async (_req, reply) => {
    const m = panelMetrics();
    const pc = pushCounters();
    return reply.send({
      ...m,
      ws: {
        clients: wsClientCount(),
        events: pc.events,
        frames: pc.frames,
        // 事件有、帧为 0 → 推了但没人订阅，通常是前端主题订阅错了
        noSubscriber: pc.events > 0 && pc.frames === 0,
      },
      scope: 'panel',
      disclaimer:
        '这是面板自身的控制面指标，**不是设备流量**。设备流量在 headscale 架构下不可得：' +
        'headscale 是控制面，设备间数据面流量由 WireGuard 直连，不经过它。',
    });
  });

  // ---------------------------------------------------------------- 流量：明确不可用
  // 与其返回 0 或编造数据，不如明确告知能力边界（501 + 解释）。
  // 这样前端可以显示"该指标在当前架构下不可得"，而不是画一条假曲线。
  app.get('/api/stats/traffic', { preHandler: requirePermission('node:read') }, async (_req, reply) => {
    return reply.code(501).send({
      error: 'NOT_SUPPORTED',
      message: '设备流量统计在当前架构下不可得',
      reason:
        'headscale 是控制面，只协调握手与下发 ACL/路由；设备间的数据面流量由 WireGuard 直连，' +
        '不经过 headscale。其 /metrics 与 REST 节点对象均无流量字段。',
      howToGetIt:
        '如需真实流量，需要在每台设备上运行 tailscaled 并开启 --metrics-listen，' +
        '由本面板去抓取各设备的本机指标；或在网络出口部署流量镜像/NetFlow。',
    });
  });
}
