/**
 * 网络拓扑页
 *
 * 用 React Flow 画「用户 → 设备」两层拓扑，边来自 ACL 逐对求值结果。
 *
 * ## 布局为什么是**确定性**的（不用力导向）
 * 力导向布局每次渲染位置都在抖，用户没法建立空间记忆，截图也无可比性。
 * 这里按「用户分列 + 设备竖排」排布：同一用户横坐标固定，设备纵坐标递增。
 * 好处是刷新/过滤后同一台设备位置不变，一眼能看出「谁少了、谁多了」。
 *
 * ## 三种策略模式必须区别对待
 * 全通 / 全禁时不画逐对连线（N² 条箭头会糊成一团且无信息量），
 * 改为醒目横幅说明结论。只有「规则模式」才画边。
 *
 * ## 边代表什么（防止误读）
 * 边 = **控制面 ACL 放行关系**，不代表有数据流量经过。
 * headscale 是控制面，数据面 WireGuard 流量在设备间直连。
 * 这句说明直接写在页脚，而不是只在文档里。
 */
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Spin, Switch, Tag, Tooltip, Segmented, Empty } from 'antd';
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
import { PageHeader, StatePill } from '../components/ui';
import { useAuth } from '../store/auth';

// ---------------------------------------------------------------- 自定义设备节点
type DeviceNodeData = TopologyNode & { [key: string]: unknown };

function DeviceNode({ data }: NodeProps): React.ReactElement {
  const n = data as unknown as DeviceNodeData;
  const dot = n.expired ? 'bg-rose-500' : n.online ? 'bg-emerald-500' : 'bg-ink-300';
  return (
    <div
      className={`w-[190px] rounded-xl border bg-white px-3 py-2.5 shadow-sm transition-shadow hover:shadow-md ${
        n.online ? 'border-brand-200' : 'border-ink-200'
      }`}
      data-testid={`topo-node-${n.id}`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-ink-300" />
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
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
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-brand-400" />
    </div>
  );
}

const nodeTypes = { device: DeviceNode };

// ---------------------------------------------------------------- 页面
export default function TopologyPage(): React.ReactElement {
  const { can } = useAuth();
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ['topology', onlineOnly],
    queryFn: () => api.get<TopologyResponse>('/api/topology', { onlineOnly: onlineOnly ? '1' : '0' }),
    refetchInterval: 30_000,
  });

  const data = q.data;

  // 确定性布局：按用户分列，列内竖排
  const { flowNodes, flowEdges } = useMemo(() => {
    if (!data) return { flowNodes: [] as Node[], flowEdges: [] as Edge[] };

    const users = [...new Set(data.nodes.map((n) => n.user ?? 'tagged-devices'))].sort((a, b) =>
      a === 'tagged-devices' ? 1 : b === 'tagged-devices' ? -1 : a.localeCompare(b),
    );

    const COL_W = 300;
    const ROW_H = 96;
    const byUser = new Map<string, TopologyNode[]>();
    for (const n of data.nodes) {
      const u = n.user ?? 'tagged-devices';
      const arr = byUser.get(u) ?? [];
      arr.push(n);
      byUser.set(u, arr);
    }

    const nodes: Node[] = [];
    users.forEach((u, ci) => {
      const list = (byUser.get(u) ?? []).sort((a, b) => a.displayName.localeCompare(b.displayName));
      list.forEach((n, ri) => {
        nodes.push({
          id: String(n.id),
          type: 'device',
          position: { x: ci * COL_W, y: ri * ROW_H },
          data: { ...n },
        });
      });
    });

    // 边：同一对只留一条；高亮时只强调相关边
    const edges: Edge[] = data.edges.map((e, i) => {
      const active = highlight === null || e.from === highlight || e.to === highlight;
      return {
        id: `e${i}`,
        source: String(e.from),
        target: String(e.to),
        animated: false,
        style: {
          stroke: active ? '#2563eb' : '#cbd5e1',
          strokeWidth: active && highlight !== null ? 1.8 : 1.2,
          opacity: active ? 0.9 : 0.25,
        },
        markerEnd: { type: 'arrowclosed' as never, color: active ? '#2563eb' : '#cbd5e1' },
      };
    });

    return { flowNodes: nodes, flowEdges: edges };
  }, [data, highlight]);

  const onNodeClick = useCallback((_: unknown, node: Node) => {
    const id = Number(node.id);
    setHighlight((cur) => (cur === id ? null : id));
  }, []);

  if (q.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spin size="large" tip="正在计算拓扑与 ACL 放行关系…" />
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
          message="当前策略为「全通」——任意两台设备互通，因此不绘制逐对连线"
          description={
            <div className="text-[12.5px]">
              {data.explanation}
              <div className="mt-1 text-ink-500">
                全通状态下画 N² 条箭头只会糊成一团且没有信息量。要点是这条结论本身。
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
          message="当前策略为「全禁」——设备之间无法互访，图中没有连线就是结论"
          description={<div className="text-[12.5px]">{data.explanation}</div>}
        />
      );
    }
    return (
      <Alert
        type="success"
        showIcon
        className="mb-3"
        message={`规则模式：${data.stats.allowedEdges} 条放行关系（逐对求值 ${data.stats.pairEvaluated} 对）`}
        description={<div className="text-[12.5px] text-ink-600">{data.explanation}</div>}
      />
    );
  })();

  return (
    <>
      <PageHeader
        title="网络拓扑"
        description="设备连接关系与 ACL 放行矩阵 · 边来自逐对 ACL 求值"
        extra={
          <div className="flex flex-wrap items-center gap-3">
            <Tooltip title="只显示在线设备之间的连线，减少离线设备造成的视觉噪音">
              <span className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
                只看在线
                <Switch size="small" checked={onlineOnly} onChange={setOnlineOnly} />
              </span>
            </Tooltip>
            <Segmented
              size="small"
              value={highlight === null ? 'all' : 'focus'}
              onChange={(v) => setHighlight(v === 'all' ? null : (data?.nodes[0]?.id ?? null))}
              options={[
                { label: '全部连线', value: 'all' },
                { label: '聚焦设备', value: 'focus' },
              ]}
            />
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
              已评估 {data.stats.pairEvaluated} 对。图中的边都是<b>实际算过</b>的，
              未评估的组合不会出现在图上——需要完整结论请用「ACL 管理 → 访问检查」。
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
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              onNodeClick={onNodeClick}
              fitView
              minZoom={0.25}
              maxZoom={1.6}
              proOptions={{ hideAttribution: true }}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#e2e8f0" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                nodeColor={(n) => ((n.data as unknown as DeviceNodeData).online ? '#2563eb' : '#cbd5e1')}
                style={{ background: '#f8fafc' }}
              />
            </ReactFlow>
          </div>
        )}
      </div>

      {/* 图例 + 统计 + 语义说明 */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="hsa-card p-4">
          <div className="mb-2 text-[13px] font-semibold text-ink-800">图例</div>
          <div className="space-y-1.5 text-[12px] text-ink-600">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 在线
              <span className="ml-3 h-1.5 w-1.5 rounded-full bg-ink-300" /> 离线
              <span className="ml-3 h-1.5 w-1.5 rounded-full bg-rose-500" /> 已过期
            </div>
            <div className="flex items-center gap-2">
              <svg width="26" height="8">
                <line x1="0" y1="4" x2="26" y2="4" stroke="#2563eb" strokeWidth="1.8" markerEnd="url(#a)" />
                <defs>
                  <marker id="a" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                    <path d="M0,0 L6,3 L0,6 z" fill="#2563eb" />
                  </marker>
                </defs>
              </svg>
              ACL 放行方向（点击设备可聚焦其连线）
            </div>
          </div>
        </div>

        <div className="hsa-card p-4">
          <div className="mb-2 text-[13px] font-semibold text-ink-800">统计</div>
          {data && (
            <div className="space-y-1.5 text-[12px] text-ink-600">
              <div className="flex justify-between">
                <span>设备</span>
                <span className="font-mono">{data.stats.nodeCount}</span>
              </div>
              <div className="flex justify-between">
                <span>参与求值</span>
                <span className="font-mono">{data.stats.consideredCount}</span>
              </div>
              <div className="flex justify-between">
                <span>求值对数</span>
                <span className="font-mono">{data.stats.pairEvaluated}</span>
              </div>
              <div className="flex justify-between">
                <span>放行边数</span>
                <span className="font-mono text-brand-600">{data.stats.allowedEdges}</span>
              </div>
              <div className="flex justify-between">
                <span>用户 / 分组</span>
                <span className="font-mono">{data.users.length}</span>
              </div>
            </div>
          )}
        </div>

        <div className="hsa-card p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
            <InfoCircleOutlined className="text-ink-400" />
            这条边代表什么
          </div>
          <div className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-500">
            <p>
              边 = <b className="text-ink-700">控制面 ACL 放行关系</b>
              （与「访问检查」同一套求值引擎），箭头方向即允许方向。
            </p>
            <p>
              <b className="text-ink-700">不代表有数据流量经过。</b>
              headscale 只在控制面协调握手与下发策略，设备之间的数据面流量是
              WireGuard 直连的。
            </p>
            <p className="text-ink-400">
              策略来源：{data?.source ?? '—'}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-3 text-[11.5px] text-ink-400">
        提示：点击设备可聚焦其所有连线，再次点击取消。设备位置按用户分列固定排布，
        刷新后位置不变，便于对比前后差异。
        {can('acl:read') && (
          <>
            {' '}
            需要精确到端口/协议的结论，请用
            <a className="ml-1 text-brand-600 hover:underline" href="/acl">
              ACL 管理 → 访问检查
            </a>
            。
          </>
        )}
      </div>
    </>
  );
}
