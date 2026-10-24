/**
 * 密钥管理：预授权密钥（PreAuthKey）+ Headscale API Key。
 *
 * 安全约定：API Key 明文只在创建时返回一次，之后上游只给 prefix。
 * 面板不会把它写进任何日志或缓存。
 */
import { useState } from 'react';
import {
  Table,
  Button,
  Tabs,
  Modal,
  Form,
  Input,
  Select,
  InputNumber,
  Switch,
  Tag,
  Tooltip,
  Popconfirm,
  Alert,
  Typography,
  App as AntApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  PlusOutlined,
  CopyOutlined,
  StopOutlined,
  DeleteOutlined,
  KeyOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { ApiKeyRow, PreAuthKey } from '../api/types';
import { PageHeader, EmptyState, Countdown, RelTime, StatePill } from '../components/ui';
import { useAuth } from '../store/auth';

const { Text, Paragraph } = Typography;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function KeysPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { can } = useAuth();
  const [tab, setTab] = useState('preauth');
  const [createKeyOpen, setCreateKeyOpen] = useState(false);
  const [revealed, setRevealed] = useState<{ title: string; value: string; warning: string } | null>(null);

  const [preForm] = Form.useForm();

  const preQuery = useQuery({
    queryKey: ['preauthkeys'],
    queryFn: () => api.get<{ keys: PreAuthKey[] }>('/api/preauthkeys'),
    enabled: can('preauthkey:read'),
  });
  const apiQuery = useQuery({
    queryKey: ['apikeys'],
    queryFn: () => api.get<{ keys: ApiKeyRow[] }>('/api/apikeys'),
    enabled: can('apikey:read'),
  });
  const usersQuery = useQuery({
    queryKey: ['hs-users'],
    queryFn: () => api.get<{ users: { id: number; name: string }[] }>('/api/hs/users'),
    enabled: can('user:read'),
  });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['preauthkeys'] });
    await qc.invalidateQueries({ queryKey: ['apikeys'] });
    await qc.invalidateQueries({ queryKey: ['overview'] });
  };

  const createKeyMut = useMutation({
    mutationFn: (v: { userId: number; reusable: boolean; ephemeral: boolean; expirationDays: number; aclTags: string[] }) =>
      api.post<{ key: PreAuthKey }>('/api/preauthkeys', v),
    onSuccess: async (r) => {
      setCreateKeyOpen(false);
      preForm.resetFields();
      setRevealed({
        title: '预授权密钥已创建',
        value: r.key.key,
        warning: '该密钥用于设备首次接入，可重复使用（若勾选）。请妥善保管，泄漏后应立即过期处理。',
      });
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const expireKeyMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/preauthkeys/${id}/expire`),
    onSuccess: async () => {
      message.success('密钥已过期');
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteKeyMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/preauthkeys/${id}/delete`, { confirm: true }),
    onSuccess: async () => {
      message.success('密钥已删除');
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const createApiKeyMut = useMutation({
    mutationFn: (days: number) => api.post<{ apiKey: string }>('/api/apikeys', { expirationDays: days }),
    onSuccess: async (r) => {
      setRevealed({
        title: 'Headscale API Key 已创建',
        value: r.apiKey,
        warning:
          'Headscale 只在创建时返回一次明文，之后列表里只能看到前缀。请立即复制保存。' +
          '若面板需要用它管理 Headscale，请到「系统设置」中填入。',
      });
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const expireApiKeyMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/apikeys/${id}/expire`),
    onSuccess: async () => {
      message.success('API Key 已过期');
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteApiKeyMut = useMutation({
    mutationFn: (prefix: string) => api.post(`/api/apikeys/${encodeURIComponent(prefix)}/delete`, { confirm: true }),
    onSuccess: async () => {
      message.success('API Key 已删除');
      await invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'SELF_LOCKOUT') {
        Modal.error({
          title: '不能删除面板正在使用的密钥',
          content: (
            <div className="text-[13px] leading-relaxed">
              该密钥正是面板当前用于连接 Headscale 的凭据。
              <br />
              请先在「系统设置」中切换到另一把密钥，再回来删除。
            </div>
          ),
        });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const preColumns: ColumnsType<PreAuthKey> = [
    {
      title: '状态',
      key: 'state',
      width: 110,
      render: (_: unknown, r) => {
        if (r.expired) return <StatePill tone="danger">已过期</StatePill>;
        if (r.used && !r.reusable) return <StatePill tone="idle">已使用</StatePill>;
        return <StatePill tone="ok">有效</StatePill>;
      },
    },
    {
      title: '密钥',
      dataIndex: 'key',
      render: (k: string) => (
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12px] text-ink-700">{k.slice(0, 28)}…</span>
          <Tooltip title="复制完整密钥">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={async () => {
                const ok = await copyText(k);
                message[ok ? 'success' : 'warning'](ok ? '已复制' : '复制失败，请手动选择文本');
              }}
            />
          </Tooltip>
        </div>
      ),
    },
    {
      title: '归属用户',
      dataIndex: 'user',
      width: 130,
      render: (u: PreAuthKey['user']) => (u ? <Tag color="blue" className="!mr-0">{u.name}</Tag> : <span className="text-ink-300">—</span>),
    },
    {
      title: '特性',
      key: 'flags',
      width: 160,
      render: (_: unknown, r) => (
        <div className="flex flex-wrap gap-1">
          {r.reusable && <Tag color="green" className="!mr-0">可重复</Tag>}
          {r.ephemeral && (
            <Tooltip title="临时节点：离线后会被自动清理">
              <Tag color="orange" className="!mr-0">临时</Tag>
            </Tooltip>
          )}
          {r.aclTags.map((t) => (
            <Tag key={t} className="!mr-0 !font-mono !text-[11px]">{t.replace(/^tag:/, '')}</Tag>
          ))}
          {!r.reusable && !r.ephemeral && r.aclTags.length === 0 && <span className="text-ink-300">—</span>}
        </div>
      ),
    },
    {
      title: '到期',
      dataIndex: 'expiresInSec',
      width: 130,
      render: (_: unknown, r) => <Countdown seconds={r.expiration ? r.expiresInSec : null} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string | null) => <RelTime iso={v} />,
    },
    {
      title: '操作',
      key: 'a',
      width: 100,
      fixed: 'right',
      render: (_: unknown, r) =>
        can('preauthkey:write') ? (
          <div className="flex gap-1">
            {!r.expired && (
              <Tooltip title="立即过期">
                <Popconfirm
                  title="立即过期该密钥？"
                  description="过期后该密钥无法再用于注册设备。"
                  okText="确认"
                  cancelText="取消"
                  onConfirm={() => expireKeyMut.mutate(r.id)}
                >
                  <Button type="text" size="small" icon={<StopOutlined />} />
                </Popconfirm>
              </Tooltip>
            )}
            <Popconfirm
              title="删除密钥"
              description="删除后不可恢复。"
              okText="确认删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => deleteKeyMut.mutate(r.id)}
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

  const apiColumns: ColumnsType<ApiKeyRow> = [
    {
      title: '状态',
      key: 'state',
      width: 100,
      render: (_: unknown, r) => (r.expired ? <StatePill tone="danger">已过期</StatePill> : <StatePill tone="ok">有效</StatePill>),
    },
    {
      title: '前缀',
      dataIndex: 'prefix',
      render: (p: string) => <span className="font-mono text-[12.5px] text-ink-700">{p}</span>,
    },
    {
      title: '到期',
      dataIndex: 'expiration',
      width: 190,
      render: (v: string | null) => (v ? new Date(v).toLocaleString('zh-CN') : <span className="text-ink-300">—</span>),
    },
    {
      title: '最后使用',
      dataIndex: 'lastSeen',
      width: 130,
      render: (_: unknown, r) => <RelTime iso={r.lastSeen} agoSec={r.lastSeenAgoSec} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (v: string | null) => <RelTime iso={v} />,
    },
    {
      title: '操作',
      key: 'a',
      width: 100,
      fixed: 'right',
      render: (_: unknown, r) =>
        can('apikey:write') ? (
          <div className="flex gap-1">
            {!r.expired && (
              <Tooltip title="立即过期">
                <Popconfirm
                  title="立即过期该 API Key？"
                  description="若有服务正在使用它，将立即失去访问权限。"
                  okText="确认"
                  cancelText="取消"
                  onConfirm={() => expireApiKeyMut.mutate(r.id)}
                >
                  <Button type="text" size="small" icon={<StopOutlined />} />
                </Popconfirm>
              </Tooltip>
            )}
            <Popconfirm
              title="删除 API Key"
              description="删除后不可恢复。"
              okText="确认删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => deleteApiKeyMut.mutate(r.prefix)}
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

  const preKeys = preQuery.data?.keys ?? [];
  const apiKeys = apiQuery.data?.keys ?? [];

  return (
    <>
      <PageHeader
        title="密钥管理"
        description="预授权密钥用于设备首次接入；Headscale API Key 用于程序化访问控制面接口。"
        extra={
          <>
            <Button
              icon={<ReloadOutlined spin={preQuery.isFetching || apiQuery.isFetching} />}
              onClick={() => void invalidate()}
            >
              刷新
            </Button>
            {tab === 'preauth' && can('preauthkey:write') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateKeyOpen(true)}>
                创建预授权密钥
              </Button>
            )}
            {tab === 'api' && can('apikey:write') && (
              <CreateApiKeyButton onSubmit={(days) => createApiKeyMut.mutate(days)} loading={createApiKeyMut.isPending} />
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
              key: 'preauth',
              label: (
                <span className="flex items-center gap-1.5">
                  <SafetyCertificateOutlined />
                  预授权密钥
                  <span className="text-[11px] text-ink-400">({preKeys.length})</span>
                </span>
              ),
              children: (
                <Table
                  rowKey="id"
                  size="middle"
                  loading={preQuery.isLoading}
                  dataSource={preKeys}
                  columns={preColumns}
                  pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 个` }}
                  locale={{ emptyText: <EmptyState description="还没有预授权密钥。创建后可用于设备免浏览器授权接入。" /> }}
                />
              ),
            },
            {
              key: 'api',
              label: (
                <span className="flex items-center gap-1.5">
                  <KeyOutlined />
                  Headscale API Key
                  <span className="text-[11px] text-ink-400">({apiKeys.length})</span>
                </span>
              ),
              children: (
                <>
                  <Alert
                    type="info"
                    showIcon
                    className="mx-4 mb-3"
                    message="API Key 明文只在创建时返回一次"
                    description={
                      <span className="text-[12.5px]">
                        Headscale 后续只提供前缀用于识别。面板自身使用的密钥在「系统设置」中以加密方式存储，读取时只回显掩码。
                      </span>
                    }
                  />
                  <Table
                    rowKey="id"
                    size="middle"
                    loading={apiQuery.isLoading}
                    dataSource={apiKeys}
                    columns={apiColumns}
                    pagination={{ pageSize: 15, showTotal: (t) => `共 ${t} 个` }}
                    locale={{ emptyText: <EmptyState description="还没有 API Key。" /> }}
                  />
                </>
              ),
            },
          ]}
        />
      </div>

      {/* 创建预授权密钥 */}
      <Modal
        open={createKeyOpen}
        title="创建预授权密钥"
        onCancel={() => {
          setCreateKeyOpen(false);
          preForm.resetFields();
        }}
        onOk={() => preForm.submit()}
        okText="创建"
        confirmLoading={createKeyMut.isPending}
        destroyOnClose
      >
        <Form
          form={preForm}
          layout="vertical"
          initialValues={{ reusable: false, ephemeral: false, expirationDays: 90, aclTags: [] }}
          onFinish={(v) => createKeyMut.mutate(v)}
        >
          <Form.Item name="userId" label="归属用户" rules={[{ required: true, message: '请选择用户' }]}>
            <Select
              placeholder="选择 Headscale 用户"
              showSearch
              options={(usersQuery.data?.users ?? []).map((u) => ({ label: u.name, value: u.id }))}
            />
          </Form.Item>

          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="expirationDays" label="有效期（天）" tooltip="填 -1 表示不设置过期时间">
              <InputNumber min={-1} max={3650} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="aclTags" label="预置标签" tooltip="设备接入后自动获得这些标签，需先在 ACL tagOwners 中定义">
              <Select mode="tags" placeholder="tag:name" open={false} suffixIcon={null} />
            </Form.Item>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Form.Item name="reusable" label="可重复使用" valuePropName="checked" tooltip="允许同一密钥注册多台设备">
              <Switch />
            </Form.Item>
            <Form.Item name="ephemeral" label="临时节点" valuePropName="checked" tooltip="设备离线后会被 Headscale 自动清理">
              <Switch />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      {/* 明文展示（只此一次） */}
      <Modal
        open={Boolean(revealed)}
        title={revealed?.title}
        onCancel={() => setRevealed(null)}
        footer={[
          <Button
            key="copy"
            type="primary"
            icon={<CopyOutlined />}
            onClick={async () => {
              if (!revealed) return;
              const ok = await copyText(revealed.value);
              message[ok ? 'success' : 'warning'](ok ? '已复制到剪贴板' : '复制失败，请手动选择文本复制');
            }}
          >
            复制
          </Button>,
          <Button key="close" onClick={() => setRevealed(null)}>
            我已保存
          </Button>,
        ]}
        width={560}
        destroyOnClose
      >
        <Alert type="warning" showIcon className="mb-3" message="关闭后将无法再次查看明文" description={revealed?.warning} />
        <div className="rounded-lg border border-ink-200 bg-ink-50 p-3">
          <Paragraph
            copyable={false}
            className="!mb-0 !font-mono !text-[12.5px] !leading-relaxed"
            style={{ wordBreak: 'break-all' }}
          >
            {revealed?.value}
          </Paragraph>
        </div>
        <Text type="secondary" className="mt-2 block !text-[11.5px]">
          建议粘贴到密码管理器或部署脚本的密钥文件中，不要提交到代码仓库。
        </Text>
      </Modal>
    </>
  );
}

function CreateApiKeyButton({
  onSubmit,
  loading,
}: {
  onSubmit: (days: number) => void;
  loading: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(90);

  return (
    <>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
        创建 API Key
      </Button>
      <Modal
        open={open}
        title="创建 Headscale API Key"
        onCancel={() => setOpen(false)}
        onOk={() => {
          onSubmit(days);
          setOpen(false);
        }}
        okText="创建"
        confirmLoading={loading}
        destroyOnClose
      >
        <Form layout="vertical">
          <Form.Item label="有效期（天）" tooltip="到期后该密钥立即失效">
            <InputNumber min={1} max={3650} value={days} onChange={(v) => setDays(v ?? 90)} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
        <Alert
          type="info"
          showIcon
          message="创建后请立即复制明文"
          description={<span className="text-[12.5px]">Headscale 不会再次提供明文，只能看到前缀。</span>}
        />
      </Modal>
    </>
  );
}
