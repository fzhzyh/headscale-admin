/**
 * 时序采样器：把每轮轮询结果落成 InfluxDB 时序点
 *
 * 设计取舍：
 * ─────────────────────────────────────────────────────────────
 * 1. **只写「拿得到真实数据」的指标**
 *    在线状态来自 REST 的 `online`/`lastSeen`，是权威事实。
 *    **不写流量**：headscale 是控制面，数据面 WireGuard 流量在设备之间直连，
 *    不经过它；其 /metrics 只有 nodestore 内部计数，节点对象也无流量字段。
 *    硬凑一条曲线比不画更糟——运维会据此做错误判断。
 *
 * 2. **在线时长用「面板侧累计 + online 原始位」双写**
 *    `online_streak_sec` 是面板从「状态跃迁」起算的连续在线秒数，直观但
 *    **重启会归零**（内存态）。所以同时写 `online` 0/1 原始位，
 *    历史曲线与在线率一律基于 `online` 重算，不依赖 streak。
 *    这样即使面板重启，历史数据也不失真、不需回填。
 *
 * 3. **失败静默降级**
 *    InfluxDB 没配 / 挂了，采样器不报错、不影响轮询与 WS 推送，
 *    只让 `/api/stats/*` 返回 `degraded: true`。监控组件不能成为新的故障源。
 */

import type { Point } from './influx.js';
import { enqueue, influxEnabled } from './influx.js';

/** 采样需要的最小节点形状（不依赖 headscale client 的具体类型） */
export interface SampleNode {
  id: number | string;
  name?: string;
  givenName?: string;
  displayName?: string;
  online?: boolean;
  lastSeen?: string | null;
  lastSeenAgoSec?: number | null;
  expired?: boolean;
  tags?: string[];
  user?: { name?: string } | null;
  subnetRoutes?: string[];
  availableRoutes?: string[];
  approvedRoutes?: string[];
}

/** 节点在线状态的跃迁跟踪：nodeId → 进入当前状态的时刻 */
interface StreakState {
  online: boolean;
  sinceMs: number;
}
const streaks = new Map<string, StreakState>();

/** 采样失败/跳过次数，供 /api/stats/health 观测 */
let sampleSkipped = 0;
let sampleRecorded = 0;

function nodeLabel(n: SampleNode): string {
  return String(n.displayName || n.givenName || n.name || `#${n.id}`);
}

/** 标签设备在 ACL 里按 tag: 归属，user 字段可能为 null（上游两接口不一致） */
function nodeOwner(n: SampleNode): string {
  const tags = n.tags ?? [];
  if (tags.length > 0) return 'tagged-devices';
  return n.user?.name || 'unknown';
}

/**
 * 记录一轮快照。
 * @param nodes 本轮从 headscale 拉到的节点列表
 * @param nowMs 当前时间（测试可注入，避免依赖真实时钟）
 * @returns 生成的点数（0 表示未启用或空）
 */
export function recordSnapshot(nodes: SampleNode[], nowMs: number = Date.now()): number {
  if (!influxEnabled()) {
    sampleSkipped += 1;
    return 0;
  }
  if (nodes.length === 0) {
    // 空列表多半是上游异常/权限问题，不写「0 台设备」的假点污染曲线
    sampleSkipped += 1;
    return 0;
  }

  const ts = Math.floor(nowMs / 1000);
  const points: Point[] = [];

  let onlineCount = 0;
  let routesAvailable = 0;
  let routesApproved = 0;

  for (const n of nodes) {
    const id = String(n.id);
    const online = Boolean(n.online);
    if (online) onlineCount += 1;

    // 语义更正（实测踩过）：headscale v0.29 的三个路由字段含义不同，
    //   availableRoutes = 节点宣告/可供批准的路由
    //   approvedRoutes  = 已启用（真正生效）的路由
    //   subnetRoutes    = 另一维度，合成节点上恒为 []
    // 早先误用 subnetRoutes 当「总数」，出现 routes_total=0 而 approved=2 的
    // 自相矛盾曲线。这里分开记，**不推导「批准率」**——分母为 0 时会算出
    // 无意义的比率，反而误导。
    const available = n.availableRoutes ?? [];
    const approved = n.approvedRoutes ?? [];
    routesAvailable += available.length;
    routesApproved += approved.length;

    // 跃迁跟踪：状态变了就重置起点；同一状态沿用旧起点
    const prev = streaks.get(id);
    let sinceMs: number;
    if (!prev || prev.online !== online) {
      sinceMs = nowMs;
      streaks.set(id, { online, sinceMs });
    } else {
      sinceMs = prev.sinceMs;
    }
    const streakSec = Math.max(0, Math.round((nowMs - sinceMs) / 1000));

    points.push({
      measurement: 'node_status',
      // tag 会建索引：只放低基数字段（id/name/owner），
      // 标签组合、IP 等高频变化值放 field，避免 series 基数爆炸
      tags: {
        node_id: id,
        name: nodeLabel(n),
        owner: nodeOwner(n),
      },
      fields: {
        online: online ? 1 : 0,
        online_streak_sec: streakSec,
        last_seen_age_sec: n.lastSeenAgoSec ?? -1,
        expired: n.expired ? 1 : 0,
        tags_count: (n.tags ?? []).length,
        routes_available: available.length,
        routes_approved: approved.length,
      },
      ts,
    });
  }

  // 集群级聚合：一次查询就能画「在线设备数」曲线，不必按节点 sum
  points.push({
    measurement: 'cluster',
    tags: { scope: 'global' },
    fields: {
      nodes_total: nodes.length,
      nodes_online: onlineCount,
      nodes_offline: nodes.length - onlineCount,
      routes_available: routesAvailable,
      routes_approved: routesApproved,
      online_ratio: nodes.length > 0 ? Math.round((onlineCount / nodes.length) * 1000) / 1000 : 0,
    },
    ts,
  });

  enqueue(points);
  sampleRecorded += 1;
  return points.length;
}

/** 清理已从上游消失的节点，避免 streaks 无限增长 */
export function pruneStreaks(activeIds: Array<number | string>): number {
  const keep = new Set(activeIds.map(String));
  let removed = 0;
  for (const id of streaks.keys()) {
    if (!keep.has(id)) {
      streaks.delete(id);
      removed += 1;
    }
  }
  return removed;
}

export function samplerStats(): {
  enabled: boolean;
  trackedNodes: number;
  recordedRounds: number;
  skippedRounds: number;
} {
  return {
    enabled: influxEnabled(),
    trackedNodes: streaks.size,
    recordedRounds: sampleRecorded,
    skippedRounds: sampleSkipped,
  };
}

/** 测试用 */
export function __resetSampler(): void {
  streaks.clear();
  sampleSkipped = 0;
  sampleRecorded = 0;
}

// ============================================================
// 面板自身控制面指标（方案 B）
//
// **不是设备流量**。设备流量在 headscale 架构下不可得（控制面不转发数据面），
// 这里统计的是面板自己的 API 吞吐、错误率、延迟与 WS 推送量。
// 纯函数取参而不 import 指标服务，避免 sampler ↔ hub ↔ metrics 的循环依赖。
// ============================================================

export interface PanelSample {
  /** 最近 60 秒的 API 请求数 */
  rpm: number;
  /** 5xx 占比（0~1），无请求时传 null */
  errorRate: number | null;
  /** API 延迟 p95（毫秒），无样本时传 null */
  p95Ms: number | null;
  /** 当前 WS 连接数 */
  wsClients: number;
  /** 累计广播事件数 */
  wsEvents: number;
  /** 累计下发帧数（客户端数 × 事件） */
  wsFrames: number;
  /** 进程启动以来总请求数 */
  totalRequests: number;
}

export function recordPanelSnapshot(s: PanelSample, nowMs: number = Date.now()): number {
  if (!influxEnabled()) return 0;
  const ts = Math.floor(nowMs / 1000);
  enqueue([
    {
      measurement: 'panel_ctrl',
      tags: { scope: 'panel' },
      fields: {
        rpm: s.rpm,
        // 没请求时写 -1 而不是 0：0 会被画成「错误率 0%，很健康」，
        // 而事实是「没有样本，不知道」
        error_rate: s.errorRate === null ? -1 : s.errorRate,
        p95_ms: s.p95Ms ?? -1,
        ws_clients: s.wsClients,
        ws_events: s.wsEvents,
        ws_frames: s.wsFrames,
        total_requests: s.totalRequests,
      },
      ts,
    },
  ]);
  return 1;
}
