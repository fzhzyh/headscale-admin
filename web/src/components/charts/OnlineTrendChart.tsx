/**
 * 在线趋势图（集群级）
 *
 * 数据来自 /api/stats/cluster，由面板采样器写入 InfluxDB。
 *
 * 设计取舍 —— 为什么这个组件有四种状态而不是「有数据就画、没数据就空」：
 * ─────────────────────────────────────────────────────────────
 * 1. **degraded**：InfluxDB 不可用。此时不是「没有设备在线」，而是「不知道」。
 *    两者画出来都是空图，但含义完全相反。必须显式提示，否则运维会误判为断网。
 * 2. **数据不足**：recharts 画折线需要 ≥2 个点。刚部署时只有 1 个点，
 *    直接渲染会得到一个看不见的图，看起来像坏了。这里显示「正在积累数据」
 *    并给出下一个采样点的大致时间。
 * 3. **全离线**：曲线会贴着 0 走。这是**真实状态**，不能因为「图不好看」
 *    就隐藏或改成别的呈现——那等于向运维撒谎。
 * 4. 正常：面积图 + 在线率折线。
 *
 * 另一个取舍：**只画到采样有的区间**。不做「补零到当前时刻」，
 * 因为面板停机期间的事实是「无数据」，补零会伪造一段「全部离线」。
 *
 * ⚠️ 必须用 ComposedChart 而不是 AreaChart（实测踩过）：
 * `AreaChart` 只接受 Area 类子元素，混进去的 `<Line>` 会被**静默忽略**——
 * 不报错、不警告，只是图上少一条线、图例少一项。本轮就是这样丢掉了
 * 「在线率」折线，直到 DOM 断言发现 `.recharts-line` 数量为 0 才暴露。
 * 要 Area + Line 混合，父容器只能是 ComposedChart。
 */
import { useMemo } from 'react';
import { Empty, Alert } from 'antd';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { ClusterSeries } from '../../api/types';

/** 把 ISO 时间转成本地 HH:mm，跨天时带日期 */
function fmtTime(iso: string, withDate: boolean): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (!withDate) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

interface ChartRow {
  t: string;
  label: string;
  online: number;
  offline: number;
  total: number;
  ratioPct: number | null;
}

export function OnlineTrendChart({
  data,
  hours,
  height = 260,
}: {
  data: ClusterSeries | undefined;
  hours: number;
  height?: number;
}): React.ReactElement {
  const rows = useMemo<ChartRow[]>(() => {
    const pts = data?.points ?? [];
    const spanMs =
      pts.length >= 2
        ? new Date(pts[pts.length - 1]!.t).getTime() - new Date(pts[0]!.t).getTime()
        : 0;
    // 超过 24h 的时间轴标日期，否则只标时分
    const withDate = spanMs > 24 * 3600 * 1000;
    return pts.map((p) => ({
      t: p.t,
      label: fmtTime(p.t, withDate),
      online: p.nodesOnline ?? 0,
      offline: p.nodesOffline ?? 0,
      total: p.nodesTotal ?? 0,
      ratioPct: p.onlineRatio === null ? null : Math.round((p.onlineRatio ?? 0) * 1000) / 10,
    }));
  }, [data]);

  if (data?.degraded) {
    return (
      <Alert
        type="warning"
        showIcon
        message="时序库不可用，无法展示历史曲线"
        description={
          <div className="text-[12.5px]">
            <div className="mb-1">InfluxDB 查询失败，当前只能看到实时状态，历史数据暂不可读。</div>
            <div className="font-mono text-[11.5px] text-ink-500">{data.error}</div>
            <div className="mt-1.5 text-ink-500">
              排查：<code>docker compose ps</code> 看 influxdb 是否 running；
              <code>/api/stats/health</code> 看 influx.detail；
              首次启用 InfluxDB 3.x 需先创建 admin token（见部署文档）。
            </div>
          </div>
        }
      />
    );
  }

  if (rows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span className="text-[12.5px] text-ink-500">
            暂无采样数据。面板每 15 秒采一次，稍候刷新即可。
          </span>
        }
      />
    );
  }

  if (rows.length === 1) {
    return (
      <div className="flex flex-col items-center justify-center py-10 text-center">
        <div className="mb-2 text-[13px] font-medium text-ink-700">正在积累数据</div>
        <div className="max-w-md text-[12px] leading-relaxed text-ink-500">
          目前只有 1 个采样点，画不出趋势。再等一个采样周期（约 15 秒）即可。
          <br />
          首个采样点：<span className="font-mono">{rows[0]!.label}</span>
        </div>
      </div>
    );
  }

  const last = rows[rows.length - 1]!;
  const allOffline = last.total > 0 && last.online === 0;

  return (
    <div>
      {allOffline && (
        <div className="mb-2 rounded-lg bg-ink-50 px-3 py-2 text-[12px] text-ink-600">
          当前 <span className="font-semibold">{last.total}</span> 台设备
          <span className="font-semibold">全部离线</span>。
          这是真实状态，不是数据缺失——曲线贴 0 是正常的。
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="gradOnline" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2563eb" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="gradOffline" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#94a3b8" stopOpacity={0.22} />
              <stop offset="100%" stopColor="#94a3b8" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e8edf5" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={{ stroke: '#e2e8f0' }}
            minTickGap={28}
          />
          <YAxis
            yAxisId="count"
            allowDecimals={false}
            tick={{ fontSize: 11, fill: '#64748b' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="pct"
            orientation="right"
            domain={[0, 100]}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            unit="%"
          />
          <Tooltip
            contentStyle={{
              fontSize: 12,
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              boxShadow: '0 4px 16px rgba(15,23,42,.08)',
            }}
            labelFormatter={(l) => `时间 ${l}`}
            formatter={(v: number | string, name: string) =>
              name === '在线率' ? [`${v}%`, name] : [`${v} 台`, name]
            }
          />
          <Legend wrapperStyle={{ fontSize: 12, paddingTop: 4 }} iconType="circle" iconSize={8} />
          <Area
            yAxisId="count"
            type="monotone"
            dataKey="online"
            name="在线"
            stroke="#2563eb"
            strokeWidth={2}
            fill="url(#gradOnline)"
            dot={false}
            activeDot={{ r: 3.5 }}
            isAnimationActive={false}
          />
          <Area
            yAxisId="count"
            type="monotone"
            dataKey="total"
            name="总数"
            stroke="#cbd5e1"
            strokeWidth={1.2}
            strokeDasharray="4 3"
            fill="url(#gradOffline)"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            yAxisId="pct"
            type="monotone"
            dataKey="ratioPct"
            name="在线率"
            stroke="#10b981"
            strokeWidth={1.6}
            dot={false}
            isAnimationActive={false}
            connectNulls
          />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="mt-1.5 text-right text-[11px] text-ink-400">
        窗口：最近 {hours} 小时 · 共 {rows.length} 个采样点
      </div>
    </div>
  );
}
