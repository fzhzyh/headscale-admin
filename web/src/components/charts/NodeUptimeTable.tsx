/**
 * 设备在线时长表（24h 窗口）
 *
 * 数据来自 /api/stats/overview（面板按 node_id 聚合 InfluxDB 采样点）。
 *
 * 设计取舍：
 * ─────────────────────────────────────────────────────────────
 * 1. **展示「观测窗口」而不是笼统的 24h**。面板可能中途才启动，
 *    实际观测到的区间可能只有 10 分钟。写成「近 24h 在线率」会骗人，
 *    因为前面的 23 小时根本没采到。这里两个时间都显示出来。
 * 2. **sampleRatio 是「采样点里在线所占比例」，不是精确在线率**。
 *    列头写「在线采样比」并配 Tooltip 说明，避免被当成 SLA 指标。
 * 3. 设备可能已在 headscale 里被删除但时序里还有历史点——这类行标记为
 *    「已移除」，而不是当作现存设备统计。
 */
import { Table, Tooltip, Empty } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { InfoCircleOutlined } from '@ant-design/icons';

import type { StatsOverviewNode } from '../../api/types';
import { StatePill } from '../ui';

function fmtDur(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h} 小时 ${rm} 分` : `${h} 小时`;
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export function NodeUptimeTable({
  nodes,
  liveNodeIds,
  degraded,
  error,
}: {
  nodes: StatsOverviewNode[] | undefined;
  /** 当前 headscale 里仍存在的节点 ID，用于标记「已移除」 */
  liveNodeIds?: Set<number>;
  degraded?: boolean;
  error?: string;
}): React.ReactElement {
  if (degraded) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span className="text-[12.5px] text-ink-500">
            时序库不可用，无法计算在线时长{error ? `（${error}）` : ''}
          </span>
        }
      />
    );
  }

  const rows = nodes ?? [];
  if (rows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={<span className="text-[12.5px] text-ink-500">暂无采样数据</span>}
      />
    );
  }

  const columns: ColumnsType<StatsOverviewNode> = [
    {
      title: '设备',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, r) => {
        const removed = liveNodeIds ? !liveNodeIds.has(r.nodeId) : false;
        return (
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-800">{name}</span>
            <span className="font-mono text-[11px] text-ink-400">#{r.nodeId}</span>
            {removed && <StatePill tone="idle">已移除</StatePill>}
          </div>
        );
      },
    },
    {
      title: '当前',
      dataIndex: 'lastOnline',
      key: 'lastOnline',
      width: 90,
      render: (v: boolean) => (v ? <StatePill tone="ok">在线</StatePill> : <StatePill tone="idle">离线</StatePill>),
    },
    {
      title: (
        <span className="inline-flex items-center gap-1">
          在线采样比
          <Tooltip title="采样点中「在线」所占比例。采样间隔 15s，非精确 SLA 指标。">
            <InfoCircleOutlined className="text-[11px] text-ink-300" />
          </Tooltip>
        </span>
      ),
      dataIndex: 'sampleRatio',
      key: 'sampleRatio',
      width: 150,
      render: (v: number | null) => {
        if (v === null) return <span className="text-ink-300">—</span>;
        const pct = Math.round(v * 1000) / 10;
        const tone = v >= 0.99 ? 'text-emerald-600' : v > 0 ? 'text-amber-600' : 'text-ink-500';
        return (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-14 overflow-hidden rounded-full bg-ink-100">
              <div
                className={`h-full rounded-full ${v >= 0.99 ? 'bg-emerald-500' : v > 0 ? 'bg-amber-500' : 'bg-ink-300'}`}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <span className={`font-mono text-[12px] ${tone}`}>{pct}%</span>
          </div>
        );
      },
    },
    {
      title: '采样点数',
      dataIndex: 'sampleCount',
      key: 'sampleCount',
      width: 100,
      render: (v: number) => <span className="font-mono text-[12px] text-ink-600">{v}</span>,
    },
    {
      title: (
        <span className="inline-flex items-center gap-1">
          观测窗口
          <Tooltip title="面板实际采到数据的区间。面板中途启动时，这段区间会短于 24 小时——此前的时段没有数据，不能算作离线。">
            <InfoCircleOutlined className="text-[11px] text-ink-300" />
          </Tooltip>
        </span>
      ),
      key: 'window',
      render: (_: unknown, r) => {
        const from = new Date(r.observedFrom).getTime();
        const to = new Date(r.observedTo).getTime();
        const dur = Number.isFinite(from) && Number.isFinite(to) ? Math.max(0, Math.round((to - from) / 1000)) : 0;
        return (
          <div className="text-[12px] leading-tight">
            <div className="text-ink-700">{fmtDur(dur)}</div>
            <div className="text-[11px] text-ink-400">
              {fmtClock(r.observedFrom)} → {fmtClock(r.observedTo)}
            </div>
          </div>
        );
      },
    },
  ];

  return (
    <Table<StatsOverviewNode>
      rowKey="nodeId"
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 'max-content' }}
      className="hsa-table"
    />
  );
}
