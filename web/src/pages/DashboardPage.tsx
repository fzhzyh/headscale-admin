/**
 * 控制台总览。
 *
 * 设计：一屏看清「网络健康度 + 面板自身状态」。
 * 上游不可用时不能白屏——要把排障建议直接给出来（连接自检带 diagnosis）。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Alert, Tooltip, Tag, Spin, App as AntApp } from 'antd';
import { ReloadOutlined, CloudServerOutlined, ThunderboltOutlined, WarningOutlined } from '@ant-design/icons';
import { useState } from 'react';

import { api, errorText } from '../api/client';
import type { Overview } from '../api/types';
import { StatCard, PageHeader, StatePill, EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';

function fmtLatency(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export default function DashboardPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { can } = useAuth();
  const [syncing, setSyncing] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<Overview>('/api/system/overview'),
    // 实时推送会 invalidate，这里兜底 60s 一次
    refetchInterval: 60_000,
  });

  const doSync = async (): Promise<void> => {
    setSyncing(true);
    try {
      const r = await api.post<{ nodes: number; users: number; message: string }>('/api/system/sync');
      message.success(`同步完成：${r.nodes} 台设备 / ${r.users} 个用户`);
      await qc.invalidateQueries();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSyncing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spin size="large" tip="正在加载控制台…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="hsa-card p-6">
        <Alert
          type="error"
          showIcon
          message="无法加载控制台数据"
          description={errorText(error)}
          action={<Button size="small" onClick={() => void refetch()}>重试</Button>}
        />
      </div>
    );
  }

  const s = data!.stats;
  const conn = data!.connection;

  return (
    <>
      <PageHeader
        title="控制台"
        description={
          <>
            Headscale <span className="font-mono text-[12px] text-ink-600">{conn.address}</span>
            {' · '}
            {conn.ok ? (
              <span className="text-emerald-600">连接正常</span>
            ) : (
              <span className="text-rose-600">连接异常</span>
            )}
            {data!.lastSyncAt && (
              <>
                {' · '}最后同步 {new Date(data!.lastSyncAt).toLocaleString('zh-CN')}
              </>
            )}
          </>
        }
        extra={
          <>
            <Tooltip title="立即从 Headscale 拉取最新数据">
              <Button icon={<ReloadOutlined spin={isFetching} />} onClick={() => void refetch()} loading={isFetching}>
                刷新
              </Button>
            </Tooltip>
            {can('settings:write') && (
              <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => void doSync()} loading={syncing}>
                同步数据
              </Button>
            )}
          </>
        }
      />

      {/* 上游异常时优先展示排障建议，而不是让用户对着零值猜 */}
      {!conn.ok && (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          className="mb-4 animate-fade-in"
          message="无法连接 Headscale 控制面"
          description={
            <div className="text-[12.5px]">
              <div className="mb-1.5">
                {conn.error}
                {conn.errorCode && <span className="ml-2 font-mono text-ink-500">[{conn.errorCode}]</span>}
              </div>
              {conn.diagnosis && conn.diagnosis.length > 0 && (
                <ul className="ml-4 list-disc space-y-0.5 text-ink-600">
                  {conn.diagnosis.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              )}
              {can('settings:write') && (
                <Button size="small" type="link" className="!px-0 !pt-1.5" href="/settings">
                  前往「系统设置」检查连接配置
                </Button>
              )}
            </div>
          }
        />
      )}

      {conn.ok && conn.diagnosis && conn.diagnosis.length > 0 && (
        <Alert type="warning" showIcon className="mb-4" message={conn.diagnosis.join('；')} />
      )}

      {/* 核心指标 */}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title="设备总数"
          value={s.hsNodes}
          suffix="台"
          tone="brand"
          hint={`在线 ${s.hsNodesOnline} · 离线 ${s.hsNodesOffline}`}
        />
        <StatCard
          title="在线设备"
          value={s.hsNodesOnline}
          suffix="台"
          tone={s.hsNodesOnline > 0 ? 'ok' : 'idle'}
          hint={s.hsNodes > 0 ? `在线率 ${Math.round((s.hsNodesOnline / s.hsNodes) * 100)}%` : '暂无设备'}
        />
        <StatCard
          title="已启用路由"
          value={s.routeEnabled}
          suffix={`/ ${s.routeAvailable}`}
          tone="brand"
          hint="已批准 / 已通告总数"
        />
        <StatCard
          title="网络用户"
          value={s.hsUsers}
          suffix="个"
          tone="idle"
          hint="Headscale 侧身份"
        />
      </div>

      {/* 风险项 + 连接详情 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="hsa-card hsa-card-hover p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-ink-800">需要关注</h3>
            {s.expiringSoon + s.expired === 0 ? (
              <StatePill tone="ok">全部正常</StatePill>
            ) : (
              <StatePill tone="warn">{s.expiringSoon + s.expired} 项</StatePill>
            )}
          </div>

          <div className="space-y-2.5">
            <RiskRow
              label="7 天内到期"
              value={s.expiringSoon}
              tone={s.expiringSoon > 0 ? 'warn' : 'idle'}
              hint="设备密钥即将过期，需重新登录或取消过期"
            />
            <RiskRow
              label="已过期"
              value={s.expired}
              tone={s.expired > 0 ? 'danger' : 'idle'}
              hint="已过期的设备无法接入网络"
            />
            <RiskRow
              label="离线设备"
              value={s.hsNodesOffline}
              tone={s.hsNodesOffline > 0 ? 'idle' : 'ok'}
              hint="长时间离线需确认设备是否已下线"
            />
          </div>

          {s.expiringSoon + s.expired > 0 && (
            <Button type="link" size="small" className="!mt-3 !px-0" href="/nodes">
              前往设备管理处理 →
            </Button>
          )}
        </div>

        <div className="hsa-card hsa-card-hover p-5">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-ink-800">Headscale 连接</h3>
            {conn.ok ? <StatePill tone="ok">正常</StatePill> : <StatePill tone="danger">异常</StatePill>}
          </div>

          <div className="space-y-2.5 text-[12.5px]">
            <DetailRow label="传输方式" value={<Tag className="!mr-0">{conn.transport === 'rest' ? 'REST /api/v1' : 'gRPC'}</Tag>} />
            <DetailRow label="接口地址" value={<span className="font-mono text-[12px]">{conn.address || '—'}</span>} />
            <DetailRow label="API Key" value={conn.hasApiKey ? <StatePill tone="ok">已配置</StatePill> : <StatePill tone="danger">未配置</StatePill>} />
            <DetailRow label="响应延迟" value={<span className="font-mono">{fmtLatency(conn.latencyMs)}</span>} />
            <DetailRow
              label="上游数据库"
              value={
                conn.databaseConnectivity === undefined ? (
                  <span className="text-ink-400">未探测</span>
                ) : conn.databaseConnectivity ? (
                  <StatePill tone="ok">连通</StatePill>
                ) : (
                  <StatePill tone="danger">异常</StatePill>
                )
              }
            />
            <DetailRow label="检查时间" value={<span className="text-ink-500">{new Date(conn.checkedAt).toLocaleTimeString('zh-CN')}</span>} />
          </div>
        </div>

        <div className="hsa-card hsa-card-hover p-5">
          <div className="mb-3 flex items-center gap-2">
            <CloudServerOutlined className="text-brand-500" />
            <h3 className="text-[14px] font-semibold text-ink-800">面板自身</h3>
          </div>

          <div className="space-y-2.5 text-[12.5px]">
            <DetailRow label="面板账户" value={`${s.panelUsers} 个`} />
            <DetailRow label="用户组" value={`${s.panelGroups} 个`} />
            <DetailRow label="ACL 版本" value={`${s.aclVersions} 个`} />
            <DetailRow label="资源条目" value={`${s.resources} 个`} />
            <DetailRow label="DNS 记录" value={`${s.dnsRecords} 条`} />
            <DetailRow label="OAuth2 客户端" value={`${s.oauthClients} 个`} />
          </div>

          <div className="mt-3 border-t border-ink-100 pt-3 text-[11.5px] leading-relaxed text-ink-400">
            ACL 版本、资源、DNS 记录以面板为权威；设备与用户以 Headscale 为权威。
          </div>
        </div>
      </div>

      {/* 功能进度说明：诚实标注未完成部分，避免误以为已有能力 */}
      <div className="mt-4">
        <div className="hsa-card p-5">
          <h3 className="mb-3 text-[14px] font-semibold text-ink-800">功能进度</h3>
          <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
            {[
              ['设备 / 用户 / 密钥 / 路由管理', true],
              ['认证 · RBAC · 2FA · 审计', true],
              ['实时推送（WebSocket）', true],
              ['快速连接命令生成', true],
              ['ACL 可视化编辑与版本历史', false],
              ['ACL 访问检查求值引擎', false],
              ['监控统计（在线时长 / 流量）', false],
              ['网络拓扑与 ACL 访问矩阵', false],
              ['资源中心', false],
              ['DNS 记录管理', false],
              ['内置 OIDC Provider', false],
              ['外部 OIDC 登录', false],
            ].map(([label, done]) => (
              <div key={String(label)} className="flex items-center gap-2 text-[12.5px]">
                {done ? (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-[10px] text-emerald-600">✓</span>
                ) : (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ink-100 text-[10px] text-ink-400">·</span>
                )}
                <span className={done ? 'text-ink-700' : 'text-ink-400'}>{String(label)}</span>
                {!done && <span className="text-[11px] text-ink-300">待开发</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function RiskRow({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'danger' | 'idle';
  hint: string;
}): React.ReactElement {
  const colors: Record<string, string> = {
    ok: 'text-emerald-600',
    warn: 'text-amber-600',
    danger: 'text-rose-600',
    idle: 'text-ink-500',
  };
  return (
    <Tooltip title={hint}>
      <div className="flex cursor-help items-center justify-between rounded-lg bg-ink-50/70 px-3 py-2">
        <span className="text-[12.5px] text-ink-600">{label}</span>
        <span className={`font-mono text-[15px] font-semibold ${colors[tone]}`}>{value}</span>
      </div>
    </Tooltip>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-ink-500">{label}</span>
      <span className="min-w-0 truncate text-right text-ink-800">{value}</span>
    </div>
  );
}

export { EmptyState };
