/**
 * 角色权限面板（RBAC）。
 *
 * 设计：左侧角色列表，右侧权限勾选。权限点从后端目录动态渲染，
 * 新增权限点时前端不用改代码。
 * 内置角色受保护：不可删除，「超级管理员」不可裁剪权限（否则会锁死系统）。
 */
import { useState } from 'react';
import { Button, Modal, Form, Input, Checkbox, Popconfirm, Tooltip, Tag, Alert, App as AntApp } from 'antd';
import { PlusOutlined, DeleteOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { GroupListResponse, PanelGroup } from '../api/types';
import { EmptyState } from './ui';
import { useAuth } from '../store/auth';

export default function GroupsPanel(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm();

  const { data, isLoading } = useQuery({
    queryKey: ['panel-groups'],
    queryFn: () => api.get<GroupListResponse>('/api/panel/groups'),
  });

  const groups = data?.groups ?? [];
  const catalog = data?.catalog ?? {};
  const selected: PanelGroup | undefined = groups.find((g) => g.id === selectedId) ?? groups[0];

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['panel-groups'] });
    await qc.invalidateQueries({ queryKey: ['panel-users'] });
  };

  const savePermsMut = useMutation({
    mutationFn: ({ id, permissions }: { id: number; permissions: string[] }) =>
      api.patch(`/api/panel/groups/${id}`, { permissions }),
    onSuccess: async () => {
      message.success('权限已保存');
      await invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PROTECTED') {
        modal.error({ title: '内置角色受保护', content: e.message });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const createMut = useMutation({
    mutationFn: (v: { name: string; description?: string; permissions: string[] }) =>
      api.post('/api/panel/groups', v),
    onSuccess: async () => {
      message.success('角色已创建');
      setCreateOpen(false);
      form.resetFields();
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/panel/groups/${id}/delete`, {}),
    onSuccess: async () => {
      message.success('角色已删除');
      setSelectedId(null);
      await invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'PROTECTED') {
        modal.error({ title: '内置角色不可删除', content: e.message });
      } else {
        message.error(errorText(e));
      }
    },
  });

  // 按权限前缀分组展示，便于定位
  const grouped = Object.entries(catalog).reduce<Record<string, [string, string][]>>((acc, [key, label]) => {
    const prefix = key.split(':')[0] ?? 'other';
    if (!acc[prefix]) acc[prefix] = [];
    acc[prefix].push([key, label]);
    return acc;
  }, {});

  const prefixLabels: Record<string, string> = {
    node: '设备',
    route: '路由',
    user: '网络用户',
    preauthkey: '预授权密钥',
    apikey: 'API Key',
    acl: 'ACL 策略',
    dns: 'DNS',
    resource: '资源中心',
    metric: '监控统计',
    paneluser: '面板账户',
    group: '角色权限',
    oidc: 'OIDC',
    settings: '系统设置',
    audit: '审计日志',
    other: '其它',
  };

  if (isLoading) {
    return <div className="hsa-skeleton m-4 h-64 rounded-lg" />;
  }

  if (groups.length === 0) {
    return <EmptyState description="还没有定义角色。" />;
  }

  const isBuiltinSuper = selected?.isBuiltin && selected.name === '超级管理员';
  const editable = can('group:write') && !isBuiltinSuper;

  return (
    <div className="flex flex-col gap-4 p-4 lg:flex-row">
      {/* 角色列表 */}
      <div className="w-full shrink-0 lg:w-[260px]">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-ink-600">角色</span>
          {can('group:write') && (
            <Button type="text" size="small" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              新建
            </Button>
          )}
        </div>
        <div className="space-y-1.5">
          {groups.map((g) => {
            const active = g.id === selected?.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => setSelectedId(g.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-all ${
                  active
                    ? 'border-brand-300 bg-brand-50 shadow-glow'
                    : 'border-ink-200 bg-white hover:border-brand-200 hover:bg-brand-50/40'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`truncate text-[13px] font-medium ${active ? 'text-brand-700' : 'text-ink-800'}`}>
                    {g.name}
                  </span>
                  {g.isBuiltin && (
                    <Tooltip title="系统内置角色">
                      <LockOutlined className="shrink-0 text-[11px] text-ink-400" />
                    </Tooltip>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-400">
                  <span>{g.permissions.length} 项权限</span>
                  <span>·</span>
                  <span>{g.memberCount} 个账户</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 权限详情 */}
      <div className="min-w-0 flex-1 border-ink-100 lg:border-l lg:pl-4">
        {selected && (
          <>
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <SafetyOutlined className="text-brand-500" />
                  <span className="text-[15px] font-semibold text-ink-900">{selected.name}</span>
                  {selected.isBuiltin && <Tag className="!mr-0">内置</Tag>}
                </div>
                {selected.description && (
                  <div className="mt-1 text-[12.5px] text-ink-500">{selected.description}</div>
                )}
              </div>
              {can('group:write') && !selected.isBuiltin && (
                <Popconfirm
                  title="删除角色"
                  description={selected.memberCount > 0 ? `仍有 ${selected.memberCount} 个账户属于该角色，删除后这些账户会失去对应权限。` : '删除后不可恢复。'}
                  okText="确认删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => deleteMut.mutate(selected.id)}
                >
                  <Button size="small" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>
              )}
            </div>

            {isBuiltinSuper && (
              <Alert
                type="info"
                showIcon
                className="mb-3"
                message="内置「超级管理员」拥有全部权限，不可裁剪"
                description={<span className="text-[12.5px]">这是防止误操作把系统锁死的安全设计。</span>}
              />
            )}

            {!can('group:write') && (
              <Alert type="warning" showIcon className="mb-3" message="当前账户无「角色权限」编辑权限，以下为只读视图。" />
            )}

            <div className="space-y-3">
              {Object.entries(grouped).map(([prefix, items]) => (
                <div key={prefix} className="rounded-lg border border-ink-200/70 p-3">
                  <div className="mb-2 text-[12.5px] font-medium text-ink-600">
                    {prefixLabels[prefix] ?? prefix}
                    <span className="ml-1.5 font-normal text-ink-400">
                      ({items.filter(([k]) => selected.permissions.includes(k)).length}/{items.length})
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 xl:grid-cols-2">
                    {items.map(([key, label]) => (
                      <Checkbox
                        key={key}
                        checked={selected.permissions.includes(key)}
                        disabled={!editable}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selected.permissions, key]
                            : selected.permissions.filter((p) => p !== key);
                          savePermsMut.mutate({ id: selected.id, permissions: next });
                        }}
                      >
                        <span className="text-[12.5px] text-ink-700">{label}</span>
                        <span className="ml-1.5 font-mono text-[11px] text-ink-400">{key}</span>
                      </Checkbox>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Modal
        open={createOpen}
        title="新建角色"
        onCancel={() => {
          setCreateOpen(false);
          form.resetFields();
        }}
        onOk={() => form.submit()}
        okText="创建"
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ permissions: [] }} onFinish={(v) => createMut.mutate(v)}>
          <Form.Item name="name" label="角色名" rules={[{ required: true, message: '请输入角色名' }, { max: 64 }]}>
            <Input placeholder="例如 网络运维" autoFocus />
          </Form.Item>
          <Form.Item name="description" label="说明" rules={[{ max: 255 }]}>
            <Input placeholder="这个角色负责什么" />
          </Form.Item>
          <Form.Item name="permissions" label="权限">
            <Checkbox.Group
              className="!flex flex-col gap-1"
              options={Object.entries(catalog).map(([value, label]) => ({
                value,
                label: (
                  <span className="text-[12.5px]">
                    {label} <span className="ml-1 font-mono text-[11px] text-ink-400">{value}</span>
                  </span>
                ),
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
