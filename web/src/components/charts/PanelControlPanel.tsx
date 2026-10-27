/**
 * 面板控制面指标卡片（方案 B）
 *
 * ## 为什么做这个（以及它不是什么）
 * 「设备流量」在 headscale 架构下**不可得**——控制面不转发数据面流量。
 * 这个卡片统计的是**面板自己**的 API 吞吐、错误率、延迟与 WS 推送量。
 *
 * 运维价值：面板是唯一入口。它慢或报错时，用户第一反应是「网络坏了」。
 * 有了 rpm / 5xx 率 / p95，就能分清是**上游 headscale 慢**还是**面板自己慢**：
 *
 *   面板 p95 高 + 上游连接延迟正常 → 面板自己的问题（DB、序列化、慢查询）
 *   面板 p95 正常 + 上游连接延迟高 → 上游的问题
 *
 * ## 设计取舍
 * 1. **errorRate 为 null 时显示「无样本」而不是 0%**。
 *    把「没有请求」画成「错误率 0%」是在暗示健康，而事实是不知道。
 * 2. 延迟显示量级（p50/p95），不显示均值——均值会被少数慢请求掩盖。
 * 3. `ws.noSubscriber` 单独提示：事件有、帧为 0 意味着推了但没人订阅，
 *    这几乎总是前端主题订阅写错了，而不是「没数据」。
 */
import { Empty, Tooltip, Tag } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';

import type { PanelMetrics } from '../../api/types';

function fmtMs(v: number | null): string {
  if (v === null) return '—';
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(2)} s`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

function Metric({
  label,
  value,
  hint,
  tone = 'normal',
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'normal' | 'warn' | 'danger' | 'muted';
}): React.ReactElement {
  const color =
    tone === 'danger' ? 'text-rose-600' : tone === 'warn' ? 'text-amber-600' : tone === 'muted' ? 'text-ink-400' : 'text-ink-800';
  return (
    <div className="rounded-lg bg-ink-50/70 px-3 py-2" data-testid={`panel-metric-${label}`}>
      <div className="flex items-center gap-1 text-[11px] text-ink-500">
        {label}
        {hint && (
          <Tooltip title={hint}>
            <InfoCircleOutlined className="text-[10px] text-ink-300" />
          </Tooltip>
        )}
      </div>
      <div className={`mt-0.5 font-mono text-[15px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

export function PanelControlPanel({
  data,
  error,
  loading,
}: {
  data: PanelMetrics | undefined;
  error?: unknown;
  loading?: boolean;
}): React.ReactElement {
  if (loading && !data) {
    return <div className="py-6 text-center text-[12.5px] text-ink-400">读取面板指标…</div>;
  }
  if (!data) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <span className="text-[12.5px] text-ink-500">
            {error ? '面板指标不可用' : '暂无数据'}
          </span>
        }
      />
    );
  }

  const errPct = data.errorRate === null ? null : Math.round(data.errorRate * 1000) / 10;
  const errTone = errPct === null ? 'muted' : errPct >= 5 ? 'danger' : errPct > 0 ? 'warn' : 'normal';

  return (
    <div data-testid="panel-control-metrics">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric
          label="请求速率"
          value={`${data.rpm}`}
          hint="最近 60 秒内的 API 请求数（静态资源不计入）"
        />
        <Metric
          label="5xx 错误率"
          value={errPct === null ? '无样本' : `${errPct}%`}
          hint="自启动以来的 5xx 占比。没有请求时显示「无样本」——没样本不等于很健康"
          tone={errTone}
        />
        <Metric
          label="延迟 p95"
          value={fmtMs(data.latency.p95)}
          hint="最近 512 个请求的 95 分位。看这个比看均值有用——均值会被少数慢请求掩盖"
          tone={data.latency.p95 !== null && data.latency.p95 > 2000 ? 'warn' : 'normal'}
        />
        <Metric
          label="WS 连接"
          value={`${data.ws.clients}`}
          hint="当前 WebSocket 客户端数"
        />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Metric label="延迟 p50" value={fmtMs(data.latency.p50)} tone="muted" />
        <Metric label="延迟 p99" value={fmtMs(data.latency.p99)} tone="muted" />
        <Metric label="4xx 次数" value={`${data.status.s4xx}`} tone="muted" />
        <Metric label="运行时长" value={fmtUptime(data.uptimeSec)} tone="muted" />
      </div>

      {data.ws.noSubscriber && (
        <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[11.5px] leading-relaxed text-amber-700">
          WS 有广播事件但下发帧为 0 —— 说明推了但<b>没有客户端订阅对应主题</b>。
          这通常是前端订阅漏了主题，不是「没数据」。
        </div>
      )}

      {data.topRoutes.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-medium text-ink-600">
            请求量前 {data.topRoutes.length} 的路由
            <Tooltip title="路径已归一化（/api/nodes/123 → /api/nodes/:id），否则每台设备都会算成独立路由">
              <InfoCircleOutlined className="text-[10px] text-ink-300" />
            </Tooltip>
          </div>
          <div className="space-y-1">
            {data.topRoutes.slice(0, 5).map((r) => (
              <div key={r.route} className="flex items-center gap-2 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate font-mono text-ink-600">{r.route}</span>
                <span className="shrink-0 font-mono text-ink-800">{r.count}</span>
                <span className="w-14 shrink-0 text-right font-mono text-ink-400">{fmtMs(r.avgMs)}</span>
                {r.errors > 0 && (
                  <Tag color="red" className="!m-0 !px-1 !text-[10px]">
                    {r.errors}
                  </Tag>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 border-t border-ink-100 pt-2.5 text-[11px] leading-relaxed text-ink-400">
        这是<b className="text-ink-600">面板自身</b>的控制面指标，<b className="text-ink-600">不是设备流量</b>。
        设备流量在 headscale 架构下不可得——headscale 是控制面，数据面 WireGuard 流量在设备间直连。
      </div>
    </div>
  );
}
