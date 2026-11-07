/**
 * 网络拓扑页（树状结构）
 *
 * ## 为什么是树
 * 数据面是 WireGuard：**所有设备都接入同一张由控制面协调的加密虚拟网络**，
 * 设备与设备之间不存在「一对一专用链路」。旧版按 ACL 逐对求值画 N×(N-1) 条
 * 箭头，那是在暗示一种并不存在的物理连接：设备一多就糊成一团，
 * 而且「少画一条线」会被读成「不允许访问」——这种误读比没有图更危险。
 *
 * 现在的结构是两层树：
 *
 *      [ WireGuard 虚拟专用网络 (VPC) ]      ← 第一层（唯一根）
 *         │      │      │      │
 *         ●      ●      ●      ●            ← 第二层：设备，各自与 VPC 相连
 *
 * 设备之间不画线。连线只表达「这台设备当前是否在这张网里、状态是否健康」。
 *
 * ## 颜色语义（由后端 `reachStatus` 决定，前端只负责呈现）
 * | 颜色 | 状态      | 含义 |
 * |------|-----------|------|
 * | 绿   | `ok`      | 与**全部在线设备**双向可达 |
 * | 橙   | `partial` | 存在无法互通的在线设备 → **悬停时高亮那些设备** |
 * | 灰   | `offline` | 设备离线，不参与互通判定 |
 *
 * 「互通」是**双向**判定的（后端做）。单向放行是最常见的故障形态，
 * 只判单向会把它显示成绿色，正好掩盖了问题。
 *
 * ## 悬停交互为什么用 Context 而不是重建节点
 * 悬停如果靠「改 node.data 再重建 nodes 数组」实现，每次 mousemove 都要重建
 * N 个节点对象并让 React Flow 全量 diff——几十台设备时肉眼可见地卡。
 * 这里把悬停态放进 Context，只有消费它的节点组件重渲染，
 * 位置与节点数组保持稳定（`useMemo` 只依赖数据本身与列数）。
 */
import { createContext, useContext, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Empty, Spin, Switch, Tag, Tooltip } from 'antd';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { InfoCircleOutlined } from '@ant-design/icons';

import { api, errorText } from '../api/client';
import type { TopologyResponse, TopologyNode } from '../api/types';
import { PageHeader } from '../components/ui';
import { useAuth } from '../store/auth';

// ============================================================
// 悬停上下文：当前悬停的设备 + 它无法互通的设备集合
// ============================================================
interface HoverState {
  hoveredId: string | null;
  /** 悬停设备的不可互通集合（仅当悬停的是 partial 设备时非空） */
  unreachable: Set<number>;
}

const HoverCtx = createContext<HoverState>({ hoveredId: null, unreachable: new Set() });

// ============================================================
// 状态 → 配色（单一真源：图例、节点、连线都从这里取，避免三处写死颜色漂移）
// ============================================================
const STATUS_STYLE = {
  ok: {
    label: '互通正常',
    dot: 'bg-emerald-500',
    ring: 'border-emerald-300',
    edge: '#10b981',
    text: 'text-emerald-700',
  },
  partial: {
    label: '存在不通的设备',
    dot: 'bg-amber-500',
    ring: 'border-amber-300',
    edge: '#f59e0b',
    text: 'text-amber-700',
  },
  offline: {
    label: '离线',
    dot: 'bg-ink-300',
    ring: 'border-ink-200',
    edge: '#94a3b8',
    text: 'text-ink-500',
  },
} as const;

type StatusKey = keyof typeof STATUS_STYLE;

// ============================================================
// 自定义节点：VPC 根节点（第一层）
// ============================================================
function VpcNode({ data }: NodeProps): React.ReactElement {
  const d = data as unknown as { label: string; subLabel: string; online: number; total: number };
  return (
    <div
      className="w-[260px] rounded-2xl border-2 border-brand-300 bg-gradient-to-br from-brand-50 to-white px-4 py-3 shadow-md"
      data-testid="topo-vpc"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-[12px] font-bold text-white">
          WG
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-ink-800">{d.label}</div>
          <div className="truncate text-[10.5px] text-ink-400">{d.subLabel}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-ink-500">
        <Tag color="blue" className="!m-0 !px-1.5 !text-[10.5px]">
          在线 {d.online}
        </Tag>
        <span>设备 {d.total} 台</span>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-0 !bg-brand-500" />
    </div>
  );
}

// ============================================================
// 自定义节点：设备（第二层）
// ============================================================
type DeviceNodeData = TopologyNode & { [key: string]: unknown };

function DeviceNode({ data }: NodeProps): React.ReactElement {
  const n = data as unknown as DeviceNodeData;
  const hover = useContext(HoverCtx);
  const style = STATUS_STYLE[n.reachStatus] ?? STATUS_STYLE.offline;
  const selfId = String(n.id);

  const isHovered = hover.hoveredId === selfId;
  const isUnreachable = hover.unreachable.has(n.id);
  // 悬停时其它不相关设备淡出，把注意力集中到「不通的那几台」
  const dimmed = hover.hoveredId !== null && !isHovered && !isUnreachable;

  const ringClass = isHovered
    ? 'border-brand-500 shadow-lg'
    : isUnreachable
      ? 'border-rose-400 shadow-[0_0_0_3px_rgba(244,63,94,0.22)]'
      : style.ring;

  return (
    <div
      className={`w-[196px] rounded-xl border bg-white px-3 py-2.5 shadow-sm transition-all duration-150 ${ringClass} ${
        dimmed ? 'opacity-25' : 'opacity-100'
      }`}
      data-testid={`topo-node-${n.id}`}
      data-status={n.reachStatus}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-0 !bg-ink-300" />
      <div className="flex items-center gap-1.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
        <span className="truncate text-[12.5px] font-semibold text-ink-800" title={n.displayName}>
          {n.displayName}
        </span>
        {n.isExitNode && (
          <Tooltip title="出口节点：已批准 0.0.0.0/0 或 ::/0">
            <Tag color="purple" className="!m-0 !px-1 !text-[10px]">
              出口
            </Tag>
          </Tooltip>
        )}
      </div>
      <div className="mt-1 truncate font-mono text-[10.5px] text-ink-400">{n.ips[0] ?? '—'}</div>

      {/* 状态行：一眼看出「为什么是橙的」 */}
      <div className="mt-1 flex items-center gap-1.5">
        <span className={`text-[10.5px] font-medium ${style.text}`}>
          {n.reachStatus === 'offline' ? '离线' : style.label}
        </span>
        {n.reachStatus === 'partial' && n.unreachableCount > 0 && (
          <span className="text-[10px] text-rose-500">· {n.unreachableCount} 台不通</span>
        )}
      </div>

      {n.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {n.tags.slice(0, 2).map((t) => (
            <Tag key={t} color="blue" className="!m-0 !px-1 !text-[10px]">
              {t}
            </Tag>
          ))}
        </div>
      )}
      {n.approvedRoutes.length > 0 && (
        <div className="mt-1 truncate text-[10px] text-amber-600" title={n.approvedRoutes.join(', ')}>
          子网 {n.approvedRoutes.length} 条
        </div>
      )}
    </div>
  );
}

const nodeTypes = { vpc: VpcNode, device: DeviceNode };

// ============================================================
// 布局：确定性树
// ============================================================
const NODE_W = 196;
const COL_GAP = 56;
const ROW_GAP = 40;
const NODE_H = 96;
const ROOT_W = 260;
const ROOT_TO_DEVICE_GAP = 130;

/**
 * 把设备排成矩形网格挂在根节点下方，根节点水平居中。
 *
 * 为什么不用力导向布局：力导向每次渲染位置都在抖，用户没法建立空间记忆，
 * 截图也不可比。这里按固定列宽/行高排列，同一台设备刷新后位置不变，
 * 一眼就能看出「谁多了、谁少了」。
 */
function buildLayout(
  nodes: TopologyNode[],
  cols: number,
  vpc: { label: string; subLabel: string; online: number; total: number },
): Node[] {
  const colW = NODE_W + COL_GAP;
  const rowH = NODE_H + ROW_GAP;

  const totalCols = Math.max(1, Math.min(cols, nodes.length || 1));
  const gridW = totalCols * colW - COL_GAP;
  const rootX = (gridW - ROOT_W) / 2;

  const vpcNode: Node = {
    id: 'vpc',
    type: 'vpc',
    position: { x: Math.max(0, rootX), y: 0 },
    draggable: false,
    data: { ...vpc },
  };

  const deviceNodes: Node[] = nodes.map((n, i) => {
    const col = i % totalCols;
    const row = Math.floor(i / totalCols);
    return {
      id: String(n.id),
      type: 'device',
      position: { x: col * colW, y: ROOT_TO_DEVICE_GAP + row * rowH },
      data: { ...n },
    };
  });

  return [vpcNode, ...deviceNodes];
}

// ============================================================
// 页面
// ============================================================
export default function TopologyPage(): React.ReactElement {
  const { can } = useAuth();
  const [hideOffline, setHideOffline] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ['topology'],
    queryFn: () => api.get<TopologyResponse>('/api/topology'),
    // 实时性靠 WebSocket 失效缓存（AppLayout 收到 nodes.changed 会 invalidate ['topology']）；
    // 这里的轮询只是「WS 断线时」的兜底，所以间隔可以放长。
    refetchInterval: 60_000,
  });

  const data = q.data;

  const visibleNodes = useMemo(() => {
    if (!data) return [] as TopologyNode[];
    return hideOffline ? data.nodes.filter((n) => n.online) : data.nodes;
  }, [data, hideOffline]);

  // 列数：按设备数自适应，保持接近横向排布（纯竖排会让 560px 高度装不下）
  const cols = useMemo(() => {
    const n = visibleNodes.length;
    if (n <= 1) return 1;
    return Math.min(n, Math.max(2, Math.ceil(Math.sqrt(n * 1.6))));
  }, [visibleNodes.length]);

  // 悬停设备「无法互通」的集合：只有橙色设备需要高亮
  const hover: HoverState = useMemo(() => {
    if (!data || !hoveredId) return { hoveredId: null, unreachable: new Set<number>() };
    const n = data.nodes.find((x) => String(x.id) === hoveredId);
    if (!n || n.reachStatus !== 'partial') return { hoveredId, unreachable: new Set<number>() };
    return { hoveredId, unreachable: new Set<number>(n.unreachableIds) };
  }, [data, hoveredId]);

  // 节点数组只依赖数据本身：悬停时不重建 N 个节点对象，React Flow 不用全量 diff。
  const flowNodes = useMemo(() => {
    if (!data) return [] as Node[];
    return buildLayout(visibleNodes, cols, {
      label: data.vpc.label,
      subLabel: data.vpc.subLabel,
      online: data.stats.onlineCount,
      total: data.stats.nodeCount,
    });
  }, [data, visibleNodes, cols]);

  // 悬停只影响连线样式，所以边单独 memo；设备数一般远少于规则对数，代价可忽略。
  const flowEdges = useMemo(() => {
    if (!data) return [] as Edge[];
    return visibleNodes.map((n): Edge => {
      const style = STATUS_STYLE[n.reachStatus] ?? STATUS_STYLE.offline;
      const isTarget = hover.unreachable.has(n.id);
      const isHoveredSelf = hover.hoveredId === String(n.id);
      const muted = hover.hoveredId !== null && !isTarget && !isHoveredSelf;
      return {
        id: `vpc-${n.id}`,
        source: 'vpc',
        target: String(n.id),
        type: 'smoothstep',
        animated: n.reachStatus === 'partial' && !muted,
        style: {
          stroke: isTarget ? '#e11d48' : style.edge,
          strokeWidth: isTarget ? 2.2 : 1.3,
          strokeDasharray: n.reachStatus === 'offline' ? '6 4' : undefined,
          opacity: muted ? 0.25 : 0.9,
        },
      };
    });
  }, [data, visibleNodes, hover]);

  const hoveredNode = data && hoveredId ? data.nodes.find((n) => String(n.id) === hoveredId) : null;

  if (q.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spin size="large" tip="正在计算设备互通状态…" />
      </div>
    );
  }

  if (q.error) {
    return (
      <div className="hsa-card p-6">
        <Alert type="error" showIcon message="加载拓扑失败" description={errorText(q.error)} />
      </div>
    );
  }

  const modeBanner = (() => {
    if (!data) return null;
    if (data.mode === 'allow-all') {
      return (
        <Alert
          type="error"
          showIcon
          className="mb-3"
          message="当前策略为「全通」——任意两台设备都可互通，全部在线设备显示为绿色"
          description={
            <div className="text-[12.5px]">
              {data.explanation}
              <div className="mt-1 text-ink-500">
                「全通」是 Headscale 在没有任何 acls 规则时的默认行为，意味着<b>没有访问控制</b>。
              </div>
            </div>
          }
        />
      );
    }
    if (data.mode === 'deny-all') {
      return (
        <Alert
          type="warning"
          showIcon
          className="mb-3"
          message="当前策略为「全禁」——设备之间无法互访，全部在线设备显示为橙色"
          description={<div className="text-[12.5px]">{data.explanation}</div>}
        />
      );
    }
    return (
      <Alert
        type="success"
        showIcon
        className="mb-3"
        message={`规则模式：逐对求值 ${data.stats.pairEvaluated} 对，${data.stats.okCount} 台设备与全部在线设备互通`}
        description={<div className="text-[12.5px] text-ink-600">{data.explanation}</div>}
      />
    );
  })();

  return (
    <>
      <PageHeader
        title="网络拓扑"
        description="树状视图 · 所有设备接入同一张 WireGuard 虚拟网络 · 颜色反映与在线设备的互通状态"
        extra={
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip title="离线设备不参与互通判定；勾选后从图中隐藏，减少视觉噪音">
              <span className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
                隐藏离线
                <Switch size="small" checked={hideOffline} onChange={setHideOffline} />
              </span>
            </Tooltip>
          </div>
        }
      />

      {modeBanner}

      {data && data.stats.truncated && (
        <Alert
          type="warning"
          showIcon
          className="mb-3"
          message={`设备数过多，逐对求值已截断（上限 ${data.stats.maxPairs} 对）`}
          description={
            <span className="text-[12.5px]">
              已评估 {data.stats.pairEvaluated} 对。截断范围内的设备被<b>保守标为橙色</b>——
              未评估不等于通，宁可显示「可能有问题」也不谎报全通。
              需要完整结论请用「ACL 管理 → 访问检查」。
            </span>
          }
        />
      )}

      <div className="hsa-card overflow-hidden p-0" data-testid="topology-canvas">
        {data && data.nodes.length === 0 ? (
          <div className="p-10">
            <Empty description={<span className="text-[12.5px] text-ink-500">暂无设备</span>} />
          </div>
        ) : (
          <div style={{ height: 560 }}>
            <HoverCtx.Provider value={hover}>
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                // 根节点不是设备，悬停它不应触发「淡出所有设备」的高亮态
                onNodeMouseEnter={(_, node) => setHoveredId(node.id === 'vpc' ? null : node.id)}
                onNodeMouseLeave={() => setHoveredId(null)}
                onPaneClick={() => setHoveredId(null)}
                fitView
                minZoom={0.25}
                maxZoom={1.6}
                proOptions={{ hideAttribution: true }}
                nodesDraggable
                nodesConnectable={false}
                elementsSelectable={false}
              >
                <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e2e8f0" />
                <Controls showInteractive={false} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(n) => {
                    if (n.id === 'vpc') return '#2563eb';
                    const d = n.data as unknown as DeviceNodeData;
                    return (STATUS_STYLE[d.reachStatus as StatusKey] ?? STATUS_STYLE.offline).edge;
                  }}
                  style={{ background: '#f8fafc' }}
                />
              </ReactFlow>
            </HoverCtx.Provider>
          </div>
        )}
      </div>

      {/* 悬停详情：解释「为什么这几台不通」，而不是只给个橙点 */}
      {hoveredNode && hoveredNode.reachStatus === 'partial' && hoveredNode.unreachableReasons.length > 0 && (
        <div className="mt-3 hsa-card border-l-4 !border-l-amber-400 p-3.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
            <span className="h-2 w-2 rounded-full bg-amber-500" />
            「{hoveredNode.displayName}」无法与下列在线设备互通
          </div>
          <div className="flex flex-wrap gap-1.5">
            {hoveredNode.unreachableReasons.map((u) => (
              <Tooltip key={u.id} title={u.reason}>
                <Tag color="red" className="!m-0 !cursor-default">
                  {u.name}
                </Tag>
              </Tooltip>
            ))}
          </div>
          <div className="mt-1.5 text-[11.5px] text-ink-400">
            互通按<b>双向</b>判定（A→B 与 B→A 都要放行）。只单向放行也会被判为不通，
            这是最常见的故障形态。
          </div>
        </div>
      )}

      {/* 图例 + 统计 + 语义说明 */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="hsa-card p-4">
          <div className="mb-2 text-[13px] font-semibold text-ink-800">图例</div>
          <div className="space-y-1.5 text-[12px] text-ink-600">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              绿色 · 与全部在线设备互通
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-amber-500" />
              橙色 · 存在无法互通的在线设备（悬停高亮）
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-ink-300" />
              灰色 · 离线（不参与判定）
            </div>
            <div className="mt-1 flex items-center gap-2 text-ink-400">
              <svg width="26" height="8">
                <line x1="0" y1="4" x2="26" y2="4" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="5 3" />
              </svg>
              虚线 = 设备离线
            </div>
          </div>
        </div>

        <div className="hsa-card p-4">
          <div className="mb-2 text-[13px] font-semibold text-ink-800">统计</div>
          {data && (
            <div className="space-y-1.5 text-[12px] text-ink-600">
              <div className="flex justify-between">
                <span>设备总数</span>
                <span className="font-mono">{data.stats.nodeCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-emerald-700">互通正常</span>
                <span className="font-mono text-emerald-700">{data.stats.okCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-amber-700">存在不通</span>
                <span className="font-mono text-amber-700">{data.stats.partialCount}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-500">离线</span>
                <span className="font-mono text-ink-500">{data.stats.offlineCount}</span>
              </div>
              <div className="flex justify-between">
                <span>求值对数</span>
                <span className="font-mono">{data.stats.pairEvaluated}</span>
              </div>
            </div>
          )}
        </div>

        <div className="hsa-card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
            <InfoCircleOutlined className="text-ink-400" />
            怎么读这张图
          </div>
          <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-500">
            <p>
              连线 = <b className="text-ink-700">设备接入这张虚拟网络</b>，
              不代表它和另一台设备之间有一条专属链路。所有设备都接入同一个 VPC。
            </p>
            <p>
              颜色由<b className="text-ink-700">控制面 ACL 双向放行关系</b>推导，
              与「ACL 管理 → 访问检查」用的是同一套求值引擎。
            </p>
            <p>
              <b className="text-ink-700">不代表有数据流量经过。</b>
              headscale 只协调握手与下发策略，数据面由 WireGuard 直连或经 DERP 中继。
            </p>
            <p className="text-ink-400">策略来源：{data?.source ?? '—'}</p>
          </div>
        </div>
      </div>

      <div className="mt-3 text-[11.5px] text-ink-400">
        提示：把鼠标移到<b>橙色</b>设备上，会高亮它无法互通的设备并列出不通原因；移开即恢复。
        需要精确到端口/协议的结论，请用
        {can('acl:read') ? (
          <>
            {' '}
            <a className="text-brand-600 hover:underline" href="/acl">
              ACL 管理 → 访问检查
            </a>
            。
          </>
        ) : (
          ' ACL 管理 → 访问检查。'
        )}
      </div>
    </>
  );
}
