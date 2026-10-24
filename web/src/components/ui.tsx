/** 共享展示组件：状态点、统计卡、空状态、键值行 */

import { Tooltip, Empty, Skeleton } from 'antd';

/** 在线状态点（在线带脉冲动画） */
export function StatusDot({ online, size = 8 }: { online: boolean; size?: number }): React.ReactElement {
  return (
    <Tooltip title={online ? '在线' : '离线'}>
      <span
        className={`hsa-dot ${online ? 'hsa-dot-online' : 'hsa-dot-offline'}`}
        style={{ width: size, height: size }}
      />
    </Tooltip>
  );
}

/** 通用状态标签 */
export function StatePill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'idle' | 'brand';
  children: React.ReactNode;
}): React.ReactElement {
  const tones: Record<string, string> = {
    ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    warn: 'bg-amber-50 text-amber-700 ring-amber-200',
    danger: 'bg-rose-50 text-rose-700 ring-rose-200',
    idle: 'bg-ink-100 text-ink-600 ring-ink-200',
    brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/** 统计卡片：顶部高光条 + 悬浮微交互 */
export function StatCard({
  title,
  value,
  suffix,
  tone = 'brand',
  hint,
  loading,
}: {
  title: string;
  value: React.ReactNode;
  suffix?: string;
  tone?: 'brand' | 'ok' | 'warn' | 'danger' | 'idle';
  hint?: string;
  loading?: boolean;
}): React.ReactElement {
  const valueTone: Record<string, string> = {
    brand: 'text-brand-700',
    ok: 'text-emerald-600',
    warn: 'text-amber-600',
    danger: 'text-rose-600',
    idle: 'text-ink-700',
  };
  const accent: Record<string, string> = {
    brand: 'linear-gradient(180deg,#3b82f6,#60a5fa)',
    ok: 'linear-gradient(180deg,#10b981,#34d399)',
    warn: 'linear-gradient(180deg,#f59e0b,#fbbf24)',
    danger: 'linear-gradient(180deg,#ef4444,#f87171)',
    idle: 'linear-gradient(180deg,#94a3b8,#cbd5e1)',
  };

  return (
    <div className="hsa-card hsa-card-hover hsa-stat-accent overflow-hidden p-4 pl-5">
      <div className="absolute left-0 top-0 h-full w-[3px]" style={{ background: accent[tone] }} aria-hidden />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] text-ink-500" title={title}>
            {title}
          </div>
          {loading ? (
            <Skeleton.Input active size="small" style={{ height: 32, marginTop: 6 }} block />
          ) : (
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className={`text-[26px] font-semibold leading-none tracking-tight ${valueTone[tone]}`}>
                {value}
              </span>
              {suffix && <span className="text-[12px] text-ink-400">{suffix}</span>}
            </div>
          )}
          {hint && <div className="mt-1.5 truncate text-[11.5px] text-ink-400" title={hint}>{hint}</div>}
        </div>
      </div>
    </div>
  );
}

/** 键值行（详情面板用），长值自动省略并可悬浮查看 */
export function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-3 border-b border-ink-100 py-2 last:border-0">
      <div className="w-32 shrink-0 text-[12.5px] text-ink-500">{label}</div>
      <div className={`min-w-0 flex-1 break-all text-[13px] text-ink-800 ${mono ? 'font-mono text-[12.5px]' : ''}`}>
        {value === null || value === undefined || value === '' ? <span className="text-ink-300">—</span> : value}
      </div>
    </div>
  );
}

/** 统一的空状态 */
export function EmptyState({
  description,
  action,
}: {
  description: React.ReactNode;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="py-14">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-ink-500">{description}</span>}>
        {action}
      </Empty>
    </div>
  );
}

/** 页面标题 + 操作区 */
export function PageHeader({
  title,
  description,
  extra,
}: {
  title: string;
  description?: React.ReactNode;
  extra?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold leading-tight tracking-tight text-ink-900">{title}</h1>
        {description && <div className="mt-1 text-[12.5px] leading-relaxed text-ink-500">{description}</div>}
      </div>
      {extra && <div className="flex shrink-0 flex-wrap items-center gap-2">{extra}</div>}
    </div>
  );
}

/** 相对时间，带完整时间 tooltip */
export function RelTime({ iso, agoSec }: { iso: string | null; agoSec?: number | null }): React.ReactElement {
  if (!iso) return <span className="text-ink-300">从未</span>;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return <span className="text-ink-300">—</span>;

  const sec = agoSec ?? Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  let text: string;
  if (sec < 60) text = `${sec} 秒前`;
  else if (sec < 3600) text = `${Math.floor(sec / 60)} 分钟前`;
  else if (sec < 86400) text = `${Math.floor(sec / 3600)} 小时前`;
  else if (sec < 86400 * 30) text = `${Math.floor(sec / 86400)} 天前`;
  else text = d.toLocaleDateString('zh-CN');

  return (
    <Tooltip title={d.toLocaleString('zh-CN')}>
      <span className="cursor-help">{text}</span>
    </Tooltip>
  );
}

/** 剩余时间（到期倒计时），负数表示已过期 */
export function Countdown({ seconds }: { seconds: number | null }): React.ReactElement {
  if (seconds === null) return <span className="text-ink-500">永不过期</span>;
  if (seconds <= 0) return <StatePill tone="danger">已过期</StatePill>;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 30) return <span className="text-ink-600">{days} 天后</span>;
  if (days > 0) return <StatePill tone="warn">{days} 天 {hours} 小时后</StatePill>;
  return <StatePill tone="danger">{hours} 小时内</StatePill>;
}
