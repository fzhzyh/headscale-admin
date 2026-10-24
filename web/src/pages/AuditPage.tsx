/** 审计日志：所有变更操作的留痕 */
import { useState } from 'react';
import { Table, Input, Select, Button, Tag, Tooltip, Drawer, Descriptions, Alert } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, SearchOutlined, FileSearchOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';

import { api, errorText } from '../api/client';
import type { AuditRow } from '../api/types';
import { PageHeader, EmptyState, RelTime, StatePill } from '../components/ui';

/** 操作码 → 中文标签与语气 */
const ACTION_META: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'idle' | 'brand' }> = {
  'auth.login': { label: '登录', tone: 'brand' },
  'auth.logout': { label: '登出', tone: 'idle' },
  'auth.2fa': { label: '两步验证', tone: 'brand' },
  'auth.2fa.enable': { label: '启用 2FA', tone: 'ok' },
  'auth.2fa.disable': { label: '关闭 2FA', tone: 'warn' },
  'auth.password': { label: '修改口令', tone: 'warn' },
  'node.rename': { label: '重命名设备', tone: 'brand' },
  'node.tags': { label: '修改设备标签', tone: 'brand' },
  'node.expire': { label: '设备过期', tone: 'danger' },
  'node.expiry.set': { label: '设置到期时间', tone: 'warn' },
  'node.expiry.disable': { label: '取消过期', tone: 'ok' },
  'node.delete': { label: '删除设备', tone: 'danger' },
  'node.register': { label: '注册设备', tone: 'brand' },
  'route.enable': { label: '启用路由', tone: 'ok' },
  'route.disable': { label: '禁用路由', tone: 'warn' },
  'route.set': { label: '设置路由集合', tone: 'brand' },
  'route.disable_exit_node': { label: '禁用出口节点', tone: 'danger' },
  'hs.user.create': { label: '新建网络用户', tone: 'brand' },
  'hs.user.rename': { label: '重命名用户', tone: 'warn' },
  'hs.user.delete': { label: '删除网络用户', tone: 'danger' },
  'preauthkey.create': { label: '创建预授权密钥', tone: 'brand' },
  'preauthkey.expire': { label: '密钥过期', tone: 'warn' },
  'preauthkey.delete': { label: '删除密钥', tone: 'danger' },
  'apikey.create': { label: '创建 API Key', tone: 'brand' },
  'apikey.expire': { label: 'API Key 过期', tone: 'warn' },
  'apikey.delete': { label: '删除 API Key', tone: 'danger' },
  'panel.user.create': { label: '新建面板账户', tone: 'brand' },
  'panel.user.update': { label: '修改账户', tone: 'warn' },
  'panel.user.delete': { label: '删除账户', tone: 'danger' },
  'panel.user.reset_password': { label: '重置口令', tone: 'warn' },
  'panel.user.reset_2fa': { label: '重置 2FA', tone: 'warn' },
  'panel.user.bind': { label: '绑定网络身份', tone: 'brand' },
  'panel.user.set_groups': { label: '调整角色', tone: 'warn' },
  'panel.group.create': { label: '新建角色', tone: 'brand' },
  'panel.group.update': { label: '修改角色权限', tone: 'warn' },
  'panel.group.delete': { label: '删除角色', tone: 'danger' },
  'settings.update': { label: '修改系统设置', tone: 'warn' },
  'settings.reload_headscale': { label: '重载连接配置', tone: 'brand' },
  'settings.set_headscale_key': { label: '更换 API Key', tone: 'warn' },
  'system.sync': { label: '手动同步', tone: 'brand' },
};

function actionMeta(action: string): { label: string; tone: 'ok' | 'warn' | 'danger' | 'idle' | 'brand' } {
  return ACTION_META[action] ?? { label: action, tone: 'idle' };
}

export default function AuditPage(): React.ReactElement {
  const [action, setAction] = useState<string | undefined>();
  const [username, setUsername] = useState('');
  const [result, setResult] = useState<string | undefined>();
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AuditRow | null>(null);
  const pageSize = 30;

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['audit', action, username, result, page],
    queryFn: () =>
      api.get<{ total: number; rows: AuditRow[] }>('/api/system/audit', {
        action,
        username: username || undefined,
        result,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }),
  });

  const columns: ColumnsType<AuditRow> = [
    {
      title: '时间',
      dataIndex: 'ts',
      width: 150,
      render: (v: string) => <RelTime iso={v} />,
    },
    {
      title: '操作',
      dataIndex: 'action',
      width: 150,
      render: (a: string) => {
        const m = actionMeta(a);
        return <StatePill tone={m.tone}>{m.label}</StatePill>;
      },
    },
    {
      title: '结果',
      dataIndex: 'result',
      width: 80,
      render: (r: string) => (r === 'ok' ? <StatePill tone="ok">成功</StatePill> : <StatePill tone="danger">失败</StatePill>),
    },
    {
      title: '操作人',
      dataIndex: 'username',
      width: 120,
      render: (u: string | null) => u || <span className="text-ink-300">—</span>,
    },
    {
      title: '来源 IP',
      dataIndex: 'ip',
      width: 130,
      render: (ip: string | null) => <span className="font-mono text-[12px]">{ip || '—'}</span>,
    },
    {
      title: '对象',
      key: 'target',
      width: 190,
      render: (_: unknown, r) =>
        r.target_type ? (
          <span className="font-mono text-[12px] text-ink-600">
            {r.target_type}
            {r.target_id ? `#${r.target_id}` : ''}
          </span>
        ) : (
          <span className="text-ink-300">—</span>
        ),
    },
    {
      title: '详情',
      key: 'detail',
      render: (_: unknown, r) =>
        r.detail ? (
          <Tooltip title="点击查看完整内容">
            <button
              type="button"
              onClick={() => setDetail(r)}
              className="max-w-[320px] truncate border-0 bg-transparent p-0 text-left font-mono text-[11.5px] text-ink-500 hover:text-brand-600"
            >
              {r.detail}
            </button>
          </Tooltip>
        ) : (
          <span className="text-ink-300">—</span>
        ),
    },
    {
      title: '',
      key: 'open',
      width: 54,
      render: (_: unknown, r) => (
        <Button type="text" size="small" icon={<FileSearchOutlined />} onClick={() => setDetail(r)} />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="审计日志"
        description="记录所有对 Headscale 与面板的变更操作；敏感字段只记录「已变更」，不记录具体值。"
        extra={
          <Button icon={<ReloadOutlined spin={isFetching} />} onClick={() => void refetch()}>
            刷新
          </Button>
        }
      />

      {error && <Alert type="error" showIcon className="mb-4" message="无法加载审计日志" description={errorText(error)} />}

      <div className="hsa-card mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Input
            allowClear
            prefix={<SearchOutlined className="text-ink-400" />}
            placeholder="按操作码筛选，如 node.delete"
            style={{ width: 250 }}
            value={action}
            onChange={(e) => {
              setAction(e.target.value || undefined);
              setPage(1);
            }}
          />
          <Input
            allowClear
            placeholder="按操作人筛选"
            style={{ width: 160 }}
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              setPage(1);
            }}
          />
          <Select
            allowClear
            placeholder="结果"
            style={{ width: 120 }}
            value={result}
            onChange={(v) => {
              setResult(v);
              setPage(1);
            }}
            options={[
              { label: '成功', value: 'ok' },
              { label: '失败', value: 'error' },
            ]}
          />
          <span className="text-[12px] text-ink-400">
            共 {data?.total ?? 0} 条记录
          </span>
        </div>
      </div>

      <div className="hsa-card hsa-table-flush overflow-hidden">
        <Table
          rowKey="id"
          size="middle"
          loading={isLoading}
          dataSource={data?.rows ?? []}
          columns={columns}
          scroll={{ x: 1180 }}
          pagination={{
            current: page,
            pageSize,
            total: data?.total ?? 0,
            onChange: setPage,
            showSizeChanger: false,
            showTotal: (t) => `共 ${t} 条`,
          }}
          locale={{ emptyText: <EmptyState description="暂无审计记录。" /> }}
        />
      </div>

      <Drawer open={Boolean(detail)} onClose={() => setDetail(null)} width={520} title="审计详情">
        {detail && (
          <>
            <Descriptions column={1} size="small" bordered className="mb-4">
              <Descriptions.Item label="时间">{new Date(detail.ts).toLocaleString('zh-CN')}</Descriptions.Item>
              <Descriptions.Item label="操作">
                <StatePill tone={actionMeta(detail.action).tone}>{actionMeta(detail.action).label}</StatePill>
                <span className="ml-2 font-mono text-[11.5px] text-ink-400">{detail.action}</span>
              </Descriptions.Item>
              <Descriptions.Item label="结果">
                {detail.result === 'ok' ? <StatePill tone="ok">成功</StatePill> : <StatePill tone="danger">失败</StatePill>}
              </Descriptions.Item>
              <Descriptions.Item label="操作人">{detail.username || '—'}</Descriptions.Item>
              <Descriptions.Item label="来源 IP">
                <span className="font-mono">{detail.ip || '—'}</span>
              </Descriptions.Item>
              <Descriptions.Item label="操作对象">
                {detail.target_type ? (
                  <span className="font-mono">
                    {detail.target_type}
                    {detail.target_id ? `#${detail.target_id}` : ''}
                  </span>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
            </Descriptions>

            <div className="mb-1.5 text-[12.5px] font-medium text-ink-600">详情</div>
            <pre className="max-h-[420px] overflow-auto rounded-lg border border-ink-200 bg-ink-50 p-3 font-mono text-[11.5px] leading-relaxed text-ink-700">
              {detail.detail ? JSON.stringify(JSON.parse(detail.detail), null, 2) : '（无）'}
            </pre>
          </>
        )}
      </Drawer>
    </>
  );
}
