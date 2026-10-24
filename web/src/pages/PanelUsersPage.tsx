/** 面板账户管理：账户 CRUD、启用/禁用、角色分配、网络身份绑定、2FA 重置、口令重置 */
import { useState } from 'react';
import {
  Table,
  Button,
  Tabs,
  Modal,
  Form,
  Input,
  Select,
  Switch,
  Tag,
  Tooltip,
  Popconfirm,
  Alert,
  Checkbox,
  App as AntApp,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  PlusOutlined,
  UserOutlined,
  KeyOutlined,
  LinkOutlined,
  SafetyOutlined,
  DeleteOutlined,
  EditOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { PanelGroup, PanelUser, GroupListResponse, HsUser } from '../api/types';
import { PageHeader, EmptyState, RelTime, StatePill } from '../components/ui';
import { useAuth } from '../store/auth';
import GroupsPanel from '../components/GroupsPanel';

const { Text } = Typography;

export default function PanelUsersPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can, user: me } = useAuth();
  const [tab, setTab] = useState('users');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<PanelUser | null>(null);
  const [binding, setBinding] = useState<PanelUser | null>(null);
  const [revealed, setRevealed] = useState<{ username: string; password: string } | null>(null);

  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [bindForm] = Form.useForm();

  const usersQuery = useQuery({
    queryKey: ['panel-users'],
    queryFn: () => api.get<{ users: PanelUser[] }>('/api/panel/users'),
    enabled: can('paneluser:read'),
  });
  const groupsQuery = useQuery({
    queryKey: ['panel-groups'],
    queryFn: () => api.get<GroupListResponse>('/api/panel/groups'),
    enabled: can('group:read'),
  });
  const hsUsersQuery = useQuery({
    queryKey: ['hs-users'],
    queryFn: () => api.get<{ users: HsUser[] }>('/api/hs/users'),
    enabled: can('user:read'),
  });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['panel-users'] });
    await qc.invalidateQueries({ queryKey: ['panel-groups'] });
    await qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const createMut = useMutation({
    mutationFn: (v: Record<string, unknown>) => api.post<{ generatedPassword?: string }>('/api/panel/users', v),
    onSuccess: async (r, v) => {
      setCreateOpen(false);
      createForm.resetFields();
      if (r.generatedPassword) {
        setRevealed({ username: String(v.username), password: r.generatedPassword });
      } else {
        message.success('账户已创建');
      }
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.patch(`/api/panel/users/${id}`, body),
    onSuccess: async () => {
      message.success('已更新');
      setEditing(null);
      await invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SELF_LOCKOUT') {
        modal.error({ title: '操作被拒绝', content: '不能停用或降级当前登录的账户，否则会把自己锁在系统外。' });
      } else if (e instanceof ApiError && e.code === 'LAST_SUPERUSER') {
        modal.error({ title: '操作被拒绝', content: '系统必须保留至少一个启用的超级管理员。' });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const resetPwdMut = useMutation({
    mutationFn: (id: number) => api.post<{ password: string }>(`/api/panel/users/${id}/password`, {}),
    onSuccess: async (r, id) => {
      const u = usersQuery.data?.users.find((x) => x.id === id);
      setRevealed({ username: u?.username ?? `#${id}`, password: r.password });
      message.success('口令已重置，该账户的所有会话已失效');
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const reset2faMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/panel/users/${id}/2fa/reset`, {}),
    onSuccess: async () => {
      message.success('已重置两步验证，该账户下次登录将不再要求动态码');
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/panel/users/${id}/delete`, {}),
    onSuccess: async () => {
      message.success('账户已删除');
      await invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.code === 'SELF_DELETE' || e.code === 'LAST_SUPERUSER')) {
        modal.error({ title: '操作被拒绝', content: e.message });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const bindMut = useMutation({
    mutationFn: ({ id, hsUserIds }: { id: number; hsUserIds: number[] }) =>
      api.put(`/api/panel/users/${id}/bindings`, { hsUserIds }),
    onSuccess: async () => {
      message.success('网络身份绑定已更新');
      setBinding(null);
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const setGroupsMut = useMutation({
    mutationFn: ({ id, groupIds }: { id: number; groupIds: number[] }) =>
      api.put(`/api/panel/users/${id}/groups`, { groupIds }),
    onSuccess: async () => {
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const users = usersQuery.data?.users ?? [];
  const groups = groupsQuery.data?.groups ?? [];

  const columns: ColumnsType<PanelUser> = [
    {
      title: '状态',
      key: 'state',
      width: 96,
      render: (_: unknown, r) => {
        if (!r.isActive) return <StatePill tone="idle">已禁用</StatePill>;
        if (r.isSuperuser) return <StatePill tone="brand">超管</StatePill>;
        return <StatePill tone="ok">启用</StatePill>;
      },
    },
    {
      title: '账户',
      dataIndex: 'username',
      render: (_: unknown, r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[13.5px] font-medium text-ink-800">{r.username}</span>
            {r.id === me?.id && <Tag color="blue" className="!mr-0">当前登录</Tag>}
            {r.totpEnabled && (
              <Tooltip title="已启用两步验证">
                <SafetyOutlined className="text-emerald-500" />
              </Tooltip>
            )}
            {r.mustChangePassword && (
              <Tooltip title="下次登录需修改口令">
                <StatePill tone="warn">待改密</StatePill>
              </Tooltip>
            )}
          </div>
          {r.displayName && <div className="mt-0.5 text-[11.5px] text-ink-400">{r.displayName}</div>}
        </div>
      ),
    },
    {
      title: '角色',
      key: 'roles',
      width: 220,
      render: (_: unknown, r) => (
        <Select
          mode="multiple"
          size="small"
          style={{ minWidth: 190 }}
          value={r.groups.map((g) => g.id)}
          disabled={!can('paneluser:write')}
          loading={setGroupsMut.isPending}
          onChange={(v: number[]) => setGroupsMut.mutate({ id: r.id, groupIds: v })}
          options={groups.map((g) => ({ label: g.name, value: g.id }))}
          placeholder="未分配角色"
        />
      ),
    },
    {
      title: '绑定的网络身份',
      key: 'bind',
      width: 190,
      render: (_: unknown, r) =>
        r.hsUsers.length === 0 ? (
          <span className="text-ink-300">未绑定</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {r.hsUsers.map((u) => (
              <Tag key={u.id} color="blue" className="!mr-0">{u.name}</Tag>
            ))}
          </div>
        ),
    },
    {
      title: '最后登录',
      dataIndex: 'lastLoginAt',
      width: 118,
      render: (v: string | null) => <RelTime iso={v} />,
    },
    {
      title: '操作',
      key: 'a',
      width: 168,
      fixed: 'right',
      render: (_: unknown, r) =>
        can('paneluser:write') ? (
          <div className="flex gap-1">
            <Tooltip title="编辑">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditing(r);
                  editForm.setFieldsValue({
                    displayName: r.displayName,
                    email: r.email,
                    isActive: r.isActive,
                    isSuperuser: r.isSuperuser,
                  });
                }}
              />
            </Tooltip>
            <Tooltip title="绑定网络身份">
              <Button
                type="text"
                size="small"
                icon={<LinkOutlined />}
                onClick={() => {
                  setBinding(r);
                  bindForm.setFieldsValue({ hsUserIds: r.hsUsers.map((u) => u.id) });
                }}
              />
            </Tooltip>
            <Tooltip title="重置口令">
              <Popconfirm
                title="重置口令"
                description="将生成新的随机口令，该账户所有会话立即失效。"
                okText="确认重置"
                cancelText="取消"
                onConfirm={() => resetPwdMut.mutate(r.id)}
              >
                <Button type="text" size="small" icon={<KeyOutlined />} />
              </Popconfirm>
            </Tooltip>
            {r.totpEnabled && (
              <Tooltip title="重置两步验证">
                <Popconfirm
                  title="重置两步验证？"
                  description="该账户下次登录将不再要求动态码，且所有会话失效。"
                  okText="确认"
                  cancelText="取消"
                  onConfirm={() => reset2faMut.mutate(r.id)}
                >
                  <Button type="text" size="small" icon={<SafetyOutlined />} />
                </Popconfirm>
              </Tooltip>
            )}
            <Popconfirm
              title="删除账户"
              description="删除后不可恢复。"
              okText="确认删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => deleteMut.mutate(r.id)}
            >
              <Tooltip title="删除">
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Tooltip>
            </Popconfirm>
          </div>
        ) : (
          <span className="text-ink-300">—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="面板账户与权限"
        description={
          <>
            面板账户用于登录本控制台，与 Headscale 网络用户相互独立。
            一个面板账户可绑定多个网络身份。
          </>
        }
        extra={
          <>
            <Button icon={<ReloadOutlined spin={usersQuery.isFetching} />} onClick={() => void invalidate()}>
              刷新
            </Button>
            {tab === 'users' && can('paneluser:write') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                新建账户
              </Button>
            )}
          </>
        }
      />

      <div className="hsa-card hsa-table-flush overflow-hidden">
        <Tabs
          activeKey={tab}
          onChange={setTab}
          className="px-4 pt-2"
          items={[
            {
              key: 'users',
              label: (
                <span className="flex items-center gap-1.5">
                  <UserOutlined />
                  面板账户
                  <span className="text-[11px] text-ink-400">({users.length})</span>
                </span>
              ),
              children: (
                <Table
                  rowKey="id"
                  size="middle"
                  loading={usersQuery.isLoading}
                  dataSource={users}
                  columns={columns}
                  scroll={{ x: 1100 }}
                  pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 个` }}
                  locale={{ emptyText: <EmptyState description="还没有面板账户。" /> }}
                />
              ),
            },
            {
              key: 'groups',
              label: (
                <span className="flex items-center gap-1.5">
                  <SafetyOutlined />
                  角色权限
                  <span className="text-[11px] text-ink-400">({groups.length})</span>
                </span>
              ),
              children: <GroupsPanel />,
            },
          ]}
        />
      </div>

      {/* 新建账户 */}
      <Modal
        open={createOpen}
        title="新建面板账户"
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => createForm.submit()}
        okText="创建"
        confirmLoading={createMut.isPending}
        width={520}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" initialValues={{ groupIds: [], hsUserIds: [] }} onFinish={(v) => createMut.mutate(v)}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-zA-Z0-9._-]+$/, message: '仅允许字母、数字与 . _ -' },
              { min: 3, max: 64, message: '长度 3-64' },
            ]}
          >
            <Input prefix={<UserOutlined className="text-ink-400" />} placeholder="例如 ops-viewer" autoFocus />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选）">
            <Input placeholder="便于识别的名字" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始口令（留空自动生成）"
            tooltip="至少 10 位，需同时包含字母与数字。留空则随机生成并在创建后展示一次"
          >
            <Input.Password placeholder="留空则自动生成强口令" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="groupIds" label="角色">
            <Select
              mode="multiple"
              placeholder="选择角色，决定该账户的权限范围"
              options={groups.map((g) => ({ label: `${g.name}${g.description ? ` — ${g.description}` : ''}`, value: g.id }))}
            />
          </Form.Item>
          <Form.Item name="hsUserIds" label="绑定网络身份" tooltip="绑定后该账户在「快速连接」等场景可代表对应网络身份">
            <Select
              mode="multiple"
              placeholder="选择 Headscale 用户"
              options={(hsUsersQuery.data?.users ?? []).map((u) => ({ label: u.name, value: u.id }))}
            />
          </Form.Item>
          <Form.Item name="isSuperuser" label="超级管理员" valuePropName="checked" tooltip="拥有全部权限且不可被裁剪">
            <Switch />
          </Form.Item>
          <Alert
            type="warning"
            showIcon
            message="权限越大责任越大"
            description={<span className="text-[12.5px]">建议按最小权限原则分配角色，超级管理员仅保留必要数量。</span>}
          />
        </Form>
      </Modal>

      {/* 编辑账户 */}
      <Modal
        open={Boolean(editing)}
        title={`编辑账户 ${editing?.username ?? ''}`}
        onCancel={() => setEditing(null)}
        onOk={() => editForm.submit()}
        okText="保存"
        confirmLoading={updateMut.isPending}
        destroyOnClose
      >
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) => editing && updateMut.mutate({ id: editing.id, body: v })}
        >
          <Form.Item name="displayName" label="显示名">
            <Input placeholder="留空则只显示用户名" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="可选" />
          </Form.Item>
          <Form.Item name="isActive" label="账户启用" valuePropName="checked" tooltip="禁用后该账户所有会话立即失效且无法登录">
            <Switch />
          </Form.Item>
          <Form.Item
            name="isSuperuser"
            label="超级管理员"
            valuePropName="checked"
            tooltip="系统必须保留至少一个启用的超级管理员"
          >
            <Switch disabled={editing?.id === me?.id} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 绑定网络身份 */}
      <Modal
        open={Boolean(binding)}
        title={`绑定网络身份 — ${binding?.username ?? ''}`}
        onCancel={() => setBinding(null)}
        onOk={() => bindForm.submit()}
        okText="保存"
        confirmLoading={bindMut.isPending}
        destroyOnClose
      >
        <Alert
          type="info"
          showIcon
          className="mb-4"
          message="一个面板账户可绑定多个 Headscale 用户"
          description={<span className="text-[12.5px]">用于「一个人管理多个网络身份」的场景。</span>}
        />
        <Form
          form={bindForm}
          layout="vertical"
          onFinish={(v: { hsUserIds: number[] }) => binding && bindMut.mutate({ id: binding.id, hsUserIds: v.hsUserIds ?? [] })}
        >
          <Form.Item name="hsUserIds" label="Headscale 用户">
            <Select
              mode="multiple"
              placeholder="选择要绑定的网络身份"
              options={(hsUsersQuery.data?.users ?? []).map((u) => ({ label: u.name, value: u.id }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 展示一次性口令 */}
      <Modal
        open={Boolean(revealed)}
        title="账户口令（仅此一次显示）"
        onCancel={() => setRevealed(null)}
        footer={[
          <Button
            key="copy"
            type="primary"
            onClick={async () => {
              if (!revealed) return;
              try {
                await navigator.clipboard.writeText(`用户名：${revealed.username}\n口令：${revealed.password}`);
                message.success('已复制');
              } catch {
                message.warning('复制失败，请手动选择文本');
              }
            }}
          >
            复制
          </Button>,
          <Button key="c" onClick={() => setRevealed(null)}>
            我已保存
          </Button>,
        ]}
        destroyOnClose
      >
        <Alert type="warning" showIcon className="mb-3" message="关闭后无法再次查看，请立即转交使用者" />
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3 text-[13px]">
          <div className="flex justify-between py-0.5">
            <Text type="secondary">用户名</Text>
            <span className="font-mono">{revealed?.username}</span>
          </div>
          <div className="mt-1 flex justify-between py-0.5">
            <Text type="secondary">口令</Text>
            <span className="font-mono">{revealed?.password}</span>
          </div>
        </div>
        <Text type="secondary" className="mt-2 block !text-[11.5px]">
          该账户首次登录时会被要求修改口令。
        </Text>
      </Modal>
    </>
  );
}
