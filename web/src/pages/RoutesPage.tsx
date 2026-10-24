/**
 * 路由管理（子网路由）。
 *
 * 关键点：上游 approve_routes 是全量覆盖语义，且不校验路由是否真被设备通告。
 * 面板对未通告路由要求显式「强制批准」，避免创建路由黑洞。
 */
import { useState } from 'react';
import { Table, Button, Switch, Tag, Tooltip, Segmented, Alert, App as AntApp } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, PartitionOutlined, WarningOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { RouteListResponse, RouteRow } from '../api/types';
import { StatusDot, StatePill, PageHeader, EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';

export default function RoutesPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['routes', status, search],
    queryFn: () =>
      api.get<RouteListResponse>('/api/routes', {
        status: status === 'all' ? undefined : status,
        search: search || undefined,
      }),
  });

  const toggleMut = useMutation({
    mutationFn: (v: { nodeId: number; route: string; enable: boolean }) =>
      api.post<{ approvedRoutes: string[] }>('/api/routes/toggle', v),
    onSuccess: async (_r, v) => {
      message.success(v.enable ? '路由已启用' : '路由已禁用');
      await qc.invalidateQueries({ queryKey: ['routes'] });
      await qc.invalidateQueries({ queryKey: ['nodes'] });
      await qc.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  const doToggle = (row: RouteRow, enable: boolean): void => {
    // 出口节点：改变会影响全网流量走向，必须二次确认
    if (row.isExit) {
      modal.confirm({
        title: enable ? '启用出口节点' : '禁用出口节点',
        icon: <WarningOutlined className="text-amber-500" />,
        content: (
          <div className="text-[13px] leading-relaxed">
            该路由是<b>出口节点</b>（{row.route}）。
            {enable
              ? '启用后，ACL 中允许使用出口节点的客户端会把全部流量交给该设备转发。'
              : '禁用后，正在使用该出口的客户端会立即失去网络出口。'}
            <div className="mt-2 rounded bg-ink-50 p-2 font-mono text-[11.5px] text-ink-600">
              设备：{row.nodeName}（{row.userName ?? '未知用户'}）
            </div>
          </div>
        ),
        okText: enable ? '确认启用' : '确认禁用',
        okButtonProps: { danger: !enable },
        cancelText: '取消',
        onOk: () => toggleMut.mutate({ nodeId: row.nodeId, route: row.route, enable }),
      });
      return;
    }
    toggleMut.mutate({ nodeId: row.nodeId, route: row.route, enable });
  };

  const columns: ColumnsType<RouteRow> = [
    {
      title: '状态',
      dataIndex: 'approved',
      width: 92,
      render: (approved: boolean, r) =>
        can('route:write') ? (
          <Tooltip title={approved ? '点击禁用' : '点击启用'}>
            <Switch
              size="small"
              checked={approved}
              loading={toggleMut.isPending}
              onChange={(v) => doToggle(r, v)}
            />
          </Tooltip>
        ) : approved ? (
          <StatePill tone="ok">已启用</StatePill>
        ) : (
          <StatePill tone="idle">未启用</StatePill>
        ),
    },
    {
      title: '网段',
      dataIndex: 'route',
      render: (route: string, r) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-ink-800">{route}</span>
          {r.isExit && (
            <Tooltip title="出口节点：客户端可把全部流量经此设备转发">
              <Tag color="purple" className="!mr-0">
                出口节点
              </Tag>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: '发布设备',
      dataIndex: 'nodeName',
      width: 200,
      render: (name: string, r) => (
        <div className="flex items-center gap-2">
          <StatusDot online={r.online} size={7} />
          <span className="truncate text-[13px] text-ink-700">{name}</span>
        </div>
      ),
    },
    {
      title: '所属用户',
      dataIndex: 'userName',
      width: 130,
      render: (u: string | null) => (u ? <Tag color="blue" className="!mr-0">{u}</Tag> : <span className="text-ink-300">—</span>),
    },
  ];

  return (
    <>
      <PageHeader
        title="路由管理"
        description={
          <>
            共 <b>{data?.total ?? 0}</b> 条路由，已启用 <b className="text-brand-600">{data?.enabled ?? 0}</b> 条。
            启用后需 ACL 中放行对应网段，客户端才能真正访问。
          </>
        }
        extra={
          <Button icon={<ReloadOutlined spin={isFetching} />} onClick={() => void refetch()}>
            刷新
          </Button>
        }
      />

      <Alert
        type="info"
        showIcon
        icon={<PartitionOutlined />}
        className="mb-4"
        message="审批语义说明"
        description={
          <span className="text-[12.5px]">
            Headscale 的审批接口是<b>全量覆盖</b>：面板会先读取当前已启用的路由集合，增删一条后再整体写回，
            因此不会误伤其它已启用的网段。
          </span>
        }
      />

      <div className="hsa-card mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented
            value={status}
            onChange={(v) => setStatus(String(v))}
            options={[
              { label: '全部', value: 'all' },
              { label: '已启用', value: 'enabled' },
              { label: '未启用', value: 'disabled' },
            ]}
          />
          <input
            className="h-[34px] w-[230px] rounded-lg border border-ink-200 px-3 text-[13px] outline-none transition-colors focus:border-brand-400"
            placeholder="搜索网段 / 设备名"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="hsa-card hsa-table-flush overflow-hidden">
        <Table
          rowKey={(r) => `${r.nodeId}|${r.route}`}
          size="middle"
          loading={isLoading}
          dataSource={data?.routes ?? []}
          columns={columns}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条` }}
          locale={{
            emptyText: (
              <EmptyState description="暂无已通告的子网路由。设备需先以 --advertise-routes 启动才会出现在这里。" />
            ),
          }}
        />
      </div>
    </>
  );
}
