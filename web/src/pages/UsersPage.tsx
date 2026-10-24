/** 网络用户（Headscale 侧身份）管理 */
import { useState } from 'react';
import { Table, Button, Modal, Form, Input, Popconfirm, Tooltip, Tag, App as AntApp } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ReloadOutlined, PlusOutlined, EditOutlined, DeleteOutlined, UserOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { HsUser } from '../api/types';
import { PageHeader, EmptyState } from '../components/ui';
import { useAuth } from '../store/auth';

export default function UsersPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [renaming, setRenaming] = useState<HsUser | null>(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['hs-users'],
    queryFn: () => api.get<{ users: HsUser[] }>('/api/hs/users'),
  });

  const [createForm] = Form.useForm();
  const [renameForm] = Form.useForm<{ newName: string }>();

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['hs-users'] });
    await qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const createMut = useMutation({
    mutationFn: (v: { name: string; displayName?: string; email?: string }) =>
      api.post('/api/hs/users', v),
    onSuccess: async () => {
      message.success('用户已创建');
      setCreateOpen(false);
      createForm.resetFields();
      await invalidate();
    },
    onError: (e) => {
      // 上游重复创建会返回 500 UNIQUE constraint，这里翻译成人话
      if (e instanceof ApiError && /UNIQUE constraint/i.test(e.message)) {
        message.error('该用户名已存在，请换一个');
      } else {
        message.error(errorText(e));
      }
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, newName }: { id: number; newName: string }) =>
      api.post(`/api/hs/users/${id}/rename`, { newName }),
    onSuccess: async () => {
      message.success('用户已重命名');
      setRenaming(null);
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/hs/users/${id}/delete`, { confirm: true }),
    onSuccess: async () => {
      message.success('用户已删除');
      await invalidate();
    },
    onError: (e) => {
      // 上游会返回 500「user not empty」，面板已预检，这里是兜底
      if (e instanceof ApiError && /not empty|HAS_NODES/i.test(e.message)) {
        modal.error({
          title: '无法删除',
          content: '该用户名下仍有设备。请先删除或迁移该用户的设备，再删除用户。',
        });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const columns: ColumnsType<HsUser> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 70,
      render: (id: number) => <span className="font-mono text-[12.5px] text-ink-500">{id}</span>,
    },
    {
      title: '用户名',
      dataIndex: 'name',
      render: (name: string) => (
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md bg-brand-50 text-[11px] font-medium text-brand-600">
            {name.slice(0, 1).toUpperCase()}
          </div>
          <span className="text-[13.5px] font-medium text-ink-800">{name}</span>
        </div>
      ),
    },
    {
      title: '显示名',
      dataIndex: 'displayName',
      render: (v: string | null) => v || <span className="text-ink-300">—</span>,
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      render: (v: string | null) => v || <span className="text-ink-300">—</span>,
    },
    {
      title: '来源',
      dataIndex: 'provider',
      width: 130,
      render: (p: string | null) =>
        p ? <Tag className="!mr-0">{p}</Tag> : <Tag color="default" className="!mr-0">本地</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : <span className="text-ink-300">—</span>),
    },
    {
      title: '操作',
      key: 'a',
      width: 110,
      fixed: 'right',
      render: (_: unknown, r) =>
        can('user:write') ? (
          <div className="flex gap-1">
            <Tooltip title="重命名">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setRenaming(r);
                  renameForm.setFieldsValue({ newName: r.name });
                }}
              />
            </Tooltip>
            <Popconfirm
              title="删除用户"
              description={
                <div className="max-w-[240px] text-[12.5px]">
                  删除后该用户身份不可恢复。名下若仍有设备会拒绝删除。
                  <div className="mt-1 font-medium">确定删除「{r.name}」？</div>
                </div>
              }
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

  const users = data?.users ?? [];

  return (
    <>
      <PageHeader
        title="网络用户"
        description={
          <>
            共 {users.length} 个 Headscale 网络身份。用户是设备归属与 ACL 中
            <span className="font-mono"> user@ </span>引用的基础。
          </>
        }
        extra={
          <>
            <Button icon={<ReloadOutlined spin={isFetching} />} onClick={() => void refetch()}>
              刷新
            </Button>
            {can('user:write') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                新建用户
              </Button>
            )}
          </>
        }
      />

      <div className="hsa-card hsa-table-flush overflow-hidden">
        <Table
          rowKey="id"
          size="middle"
          loading={isLoading}
          dataSource={users}
          columns={columns}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 个` }}
          locale={{ emptyText: <EmptyState description="还没有网络用户。创建后即可为设备分配归属。" /> }}
        />
      </div>

      <Modal
        open={createOpen}
        title="新建网络用户"
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        onOk={() => createForm.submit()}
        okText="创建"
        confirmLoading={createMut.isPending}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" onFinish={(v) => createMut.mutate(v)}>
          <Form.Item
            name="name"
            label="用户名"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-zA-Z0-9._@-]+$/, message: '仅允许字母、数字与 . _ @ -' },
              { max: 63, message: '最长 63 字符' },
            ]}
          >
            <Input prefix={<UserOutlined className="text-ink-400" />} placeholder="例如 alice" autoFocus />
          </Form.Item>
          <Form.Item name="displayName" label="显示名（可选）">
            <Input placeholder="便于识别的中文名" />
          </Form.Item>
          <Form.Item name="email" label="邮箱（可选）" rules={[{ type: 'email', message: '邮箱格式不正确' }]}>
            <Input placeholder="alice@example.com" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={Boolean(renaming)}
        title="重命名用户"
        onCancel={() => setRenaming(null)}
        onOk={() => renameForm.submit()}
        okText="保存"
        confirmLoading={renameMut.isPending}
        destroyOnClose
      >
        <Form
          form={renameForm}
          layout="vertical"
          onFinish={(v) => renaming && renameMut.mutate({ id: renaming.id, newName: v.newName })}
        >
          <Form.Item
            name="newName"
            label="新用户名"
            rules={[
              { required: true, message: '请输入新用户名' },
              { pattern: /^[a-zA-Z0-9._@-]+$/, message: '仅允许字母、数字与 . _ @ -' },
            ]}
          >
            <Input autoFocus />
          </Form.Item>
          <div className="rounded-lg bg-amber-50 p-2.5 text-[12px] leading-relaxed text-amber-700">
            重命名会影响 ACL 中所有 <span className="font-mono">alice@</span> 形式的引用，
            请同步检查 ACL 策略。
          </div>
        </Form>
      </Modal>
    </>
  );
}
