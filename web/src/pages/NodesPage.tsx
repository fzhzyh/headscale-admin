/**
 * 设备管理。
 *
 * 关键实现细节（都是实测得来的）：
 *   - 列表展示用 displayName（后端已按 givenName 优先归一化），
 *     因为 headscale 的 RenameNode 改的是 givenName 而非 name
 *   - 到期列用 neverExpires 判断：expiry 为 null 或 0001-01-01 都表示永不过期
 *   - 标签编辑前要提示「需先在 ACL 的 tagOwners 中定义」，否则上游会拒绝
 */
import { useMemo, useState } from 'react';
import {
  Table,
  Button,
  Input,
  Select,
  Space,
  Tag,
  Drawer,
  Descriptions,
  Modal,
  Form,
  Tooltip,
  Popconfirm,
  Alert,
  App as AntApp,
  Segmented,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  ReloadOutlined,
  SearchOutlined,
  EditOutlined,
  TagsOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  PlusOutlined,
  CopyOutlined,
  ClusterOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { HsNode, NodeListResponse, NodeUser } from '../api/types';
import { StatusDot, StatePill, RelTime, Countdown, PageHeader, EmptyState, KV } from '../components/ui';
import { useAuth } from '../store/auth';

const { Text } = Typography;

/** 复制到剪贴板，失败时降级提示（http 环境下 clipboard API 不可用） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function NodesPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();

  const [status, setStatus] = useState<string>('all');
  const [user, setUser] = useState<string | undefined>();
  const [tag, setTag] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [detail, setDetail] = useState<HsNode | null>(null);
  const [editing, setEditing] = useState<{ mode: 'rename' | 'tags' | 'expire'; node: HsNode } | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const listQuery = useQuery({
    queryKey: ['nodes', status, user, tag, search],
    queryFn: () =>
      api.get<NodeListResponse>('/api/nodes', {
        status: status === 'all' ? undefined : status,
        user,
        tag,
        search: search || undefined,
      }),
  });

  const usersQuery = useQuery({
    queryKey: ['hs-users'],
    queryFn: () => api.get<{ users: { id: number; name: string }[] }>('/api/hs/users'),
    enabled: can('user:read'),
  });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['nodes'] });
    await qc.invalidateQueries({ queryKey: ['overview'] });
    await qc.invalidateQueries({ queryKey: ['routes'] });
  };

  // ---------- 操作 ----------
  const renameMut = useMutation({
    mutationFn: ({ id, newName }: { id: number; newName: string }) =>
      api.post<{ node: HsNode }>(`/api/nodes/${id}/rename`, { newName }),
    onSuccess: async (r) => {
      message.success(`已重命名为「${r.node.displayName}」`);
      setEditing(null);
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const tagsMut = useMutation({
    mutationFn: ({ id, tags }: { id: number; tags: string[] }) =>
      api.post<{ node: HsNode }>(`/api/nodes/${id}/tags`, { tags }),
    onSuccess: async () => {
      message.success('标签已更新');
      setEditing(null);
      await invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'HEADSCALE_TAG_NOT_OWNED') {
        modal.warning({
          title: '标签未被 ACL 授权',
          content: (
            <div className="text-[13px] leading-relaxed">
              该标签未在 ACL 的 <span className="font-mono">tagOwners</span> 中定义，或当前身份无权拥有。
              <br />
              请先在「ACL 管理」中定义 tagOwners，再回到此处打标签。
            </div>
          ),
        });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const expireMut = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      api.post<{ node: HsNode }>(`/api/nodes/${id}/expire`, body),
    onSuccess: async (r) => {
      message.success(r.node.neverExpires ? '已设为永不过期' : '到期时间已更新');
      setEditing(null);
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteMut = useMutation({
    mutationFn: ({ id }: { id: number }) => api.post(`/api/nodes/${id}/delete`, { confirm: true }),
    onSuccess: async () => {
      message.success('设备已删除');
      setDetail(null);
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const columns: ColumnsType<HsNode> = useMemo(
    () => [
      {
        title: '状态',
        dataIndex: 'online',
        width: 74,
        render: (_: unknown, r) => (
          <div className="flex items-center gap-2">
            <StatusDot online={r.online} />
            <span className={`text-[12.5px] ${r.online ? 'text-emerald-600' : 'text-ink-400'}`}>
              {r.online ? '在线' : '离线'}
            </span>
          </div>
        ),
      },
      {
        title: '设备名',
        dataIndex: 'displayName',
        render: (_: unknown, r) => (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setDetail(r)}
                className="max-w-[220px] truncate border-0 bg-transparent p-0 text-[13.5px] font-medium text-ink-800 hover:text-brand-600"
              >
                {r.displayName}
              </button>
              {r.renamed && (
                <Tooltip title={`客户端上报的主机名为「${r.name}」，当前显示的是重命名后的名字`}>
                  <StatePill tone="brand">已改名</StatePill>
                </Tooltip>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-ink-400">
              <span className="font-mono">{r.ipAddresses[0] ?? '—'}</span>
              {r.ipAddresses.length > 1 && <span>+{r.ipAddresses.length - 1}</span>}
            </div>
          </div>
        ),
      },
      {
        title: '所属用户',
        dataIndex: 'user',
        width: 130,
        render: (u: NodeUser | null) =>
          u ? <Tag color="blue" className="!mr-0">{u.name}</Tag> : <span className="text-ink-300">—</span>,
      },
      {
        title: '标签',
        dataIndex: 'tags',
        width: 170,
        render: (tags: string[]) =>
          tags.length === 0 ? (
            <span className="text-ink-300">—</span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {tags.map((t) => (
                <Tag key={t} className="!mr-0 !font-mono !text-[11px]">{t.replace(/^tag:/, '')}</Tag>
              ))}
            </div>
          ),
      },
      {
        title: '子网路由',
        dataIndex: 'approvedRoutes',
        width: 130,
        render: (_: unknown, r) => {
          const total = new Set([...r.approvedRoutes, ...r.availableRoutes]).size;
          if (total === 0) return <span className="text-ink-300">—</span>;
          return (
            <span className="text-[12.5px]">
              已启用 <span className="font-mono font-medium text-brand-600">{r.approvedRoutes.length}</span>
              <span className="text-ink-400"> / {total}</span>
            </span>
          );
        },
      },
      {
        title: '密钥到期',
        dataIndex: 'expiresInSec',
        width: 132,
        render: (_: unknown, r) => <Countdown seconds={r.neverExpires ? null : r.expiresInSec} />,
      },
      {
        title: '最后可见',
        dataIndex: 'lastSeen',
        width: 108,
        render: (_: unknown, r) => <RelTime iso={r.lastSeen} agoSec={r.lastSeenAgoSec} />,
      },
      {
        title: '操作',
        key: 'actions',
        width: can('node:write') ? 168 : 60,
        fixed: 'right',
        render: (_: unknown, r) => (
          <Space size={2}>
            <Tooltip title="详情">
              <Button type="text" size="small" icon={<SearchOutlined />} onClick={() => setDetail(r)} />
            </Tooltip>
            {can('node:write') && (
              <>
                <Tooltip title="重命名">
                  <Button type="text" size="small" icon={<EditOutlined />} onClick={() => setEditing({ mode: 'rename', node: r })} />
                </Tooltip>
                <Tooltip title="标签">
                  <Button type="text" size="small" icon={<TagsOutlined />} onClick={() => setEditing({ mode: 'tags', node: r })} />
                </Tooltip>
                <Tooltip title="到期控制">
                  <Button type="text" size="small" icon={<ClockCircleOutlined />} onClick={() => setEditing({ mode: 'expire', node: r })} />
                </Tooltip>
                <Popconfirm
                  title="删除设备"
                  description={
                    <div className="max-w-[240px] text-[12.5px]">
                      删除后该设备需要重新注册才能接入网络，且无法恢复。
                      <div className="mt-1 font-medium">确定删除「{r.displayName}」？</div>
                    </div>
                  }
                  okText="确认删除"
                  okButtonProps={{ danger: true }}
                  cancelText="取消"
                  onConfirm={() => deleteMut.mutate({ id: r.id })}
                >
                  <Tooltip title="删除">
                    <Button type="text" size="small" danger icon={<DeleteOutlined />} />
                  </Tooltip>
                </Popconfirm>
              </>
            )}
          </Space>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [can],
  );

  const nodes = listQuery.data?.nodes ?? [];
  const facets = listQuery.data?.facets;

  return (
    <>
      <PageHeader
        title="设备管理"
        description={`共 ${nodes.length} 台设备；在线状态由面板每 15 秒采样 Headscale 得到，变化会实时推送。`}
        extra={
          <>
            <Button icon={<ReloadOutlined spin={listQuery.isFetching} />} onClick={() => void listQuery.refetch()}>
              刷新
            </Button>
            {can('node:write') && (
              <Button type="primary" icon={<PlusOutlined />} onClick={() => setRegisterOpen(true)}>
                注册设备
              </Button>
            )}
          </>
        }
      />

      <div className="hsa-card mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <Segmented
            value={status}
            onChange={(v) => setStatus(String(v))}
            options={[
              { label: '全部', value: 'all' },
              { label: '在线', value: 'online' },
              { label: '离线', value: 'offline' },
              { label: '已过期', value: 'expired' },
            ]}
          />
          <Select
            allowClear
            placeholder="按用户筛选"
            style={{ width: 160 }}
            value={user}
            onChange={(v) => setUser(v)}
            options={(usersQuery.data?.users ?? []).map((u) => ({ label: u.name, value: u.name }))}
          />
          <Select
            allowClear
            placeholder="按标签筛选"
            style={{ width: 160 }}
            value={tag}
            onChange={(v) => setTag(v)}
            options={(facets?.tags ?? []).map((t) => ({ label: t, value: t }))}
          />
          <Input
            allowClear
            prefix={<SearchOutlined className="text-ink-400" />}
            placeholder="搜索设备名 / IP / 标签"
            style={{ width: 230 }}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onPressEnter={() => void listQuery.refetch()}
          />
          {(status !== 'all' || user || tag || search) && (
            <Button
              type="link"
              size="small"
              onClick={() => {
                setStatus('all');
                setUser(undefined);
                setTag(undefined);
                setSearch('');
              }}
            >
              清除筛选
            </Button>
          )}
        </div>
      </div>

      <div className="hsa-card hsa-table-flush overflow-hidden">
        <Table
          rowKey="id"
          size="middle"
          loading={listQuery.isLoading}
          dataSource={nodes}
          columns={columns}
          scroll={{ x: 1080 }}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showTotal: (t) => `共 ${t} 台设备`,
            defaultPageSize: 20,
          }}
          locale={{
            emptyText: <EmptyState description="暂无设备。设备首次接入网络后会自动出现在这里。" />,
          }}
        />
      </div>

      {/* ---------- 详情抽屉 ---------- */}
      <Drawer
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={520}
        title={
          detail && (
            <div className="flex items-center gap-2">
              <ClusterOutlined className="text-brand-500" />
              <span className="text-[15px]">{detail.displayName}</span>
              <StatusDot online={detail.online} />
            </div>
          )
        }
      >
        {detail && (
          <div>
            <Descriptions column={1} size="small" bordered className="mb-4">
              <Descriptions.Item label="节点 ID">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="设备名（客户端上报）">
                <span className="font-mono text-[12.5px]">{detail.name}</span>
              </Descriptions.Item>
              {detail.renamed && (
                <Descriptions.Item label="重命名后">
                  <span className="font-mono text-[12.5px]">{detail.givenName}</span>
                </Descriptions.Item>
              )}
              <Descriptions.Item label="在线状态">
                {detail.online ? <StatePill tone="ok">在线</StatePill> : <StatePill tone="idle">离线</StatePill>}
              </Descriptions.Item>
              <Descriptions.Item label="所属用户">{detail.user?.name ?? '—'}</Descriptions.Item>
              <Descriptions.Item label="注册方式">
                <span className="font-mono text-[12px]">{detail.registerMethod ?? '—'}</span>
              </Descriptions.Item>
            </Descriptions>

            <KV label="IP 地址" mono value={detail.ipAddresses.join('  ') || null} />
            <KV
              label="标签"
              value={
                detail.tags.length ? (
                  <div className="flex flex-wrap gap-1">
                    {detail.tags.map((t) => (
                      <Tag key={t} className="!mr-0 !font-mono !text-[11px]">{t}</Tag>
                    ))}
                  </div>
                ) : null
              }
            />
            <KV label="最后可见" value={<RelTime iso={detail.lastSeen} agoSec={detail.lastSeenAgoSec} />} />
            <KV label="创建时间" value={detail.createdAt ? new Date(detail.createdAt).toLocaleString('zh-CN') : null} />
            <KV
              label="密钥到期"
              value={
                <>
                  <Countdown seconds={detail.neverExpires ? null : detail.expiresInSec} />
                  {detail.expiryRaw && (
                    <div className="mt-1 font-mono text-[11px] text-ink-400">
                      原始值：{detail.expiryRaw}
                    </div>
                  )}
                </>
              }
            />
            <KV
              label="已启用路由"
              value={
                detail.approvedRoutes.length ? (
                  <div className="space-y-0.5">
                    {detail.approvedRoutes.map((r) => (
                      <div key={r} className="flex items-center gap-1.5">
                        <span className="hsa-dot hsa-dot-online" style={{ width: 6, height: 6 }} />
                        <span className="font-mono text-[12.5px]">{r}</span>
                      </div>
                    ))}
                  </div>
                ) : null
              }
            />
            <KV
              label="已通告未启用"
              value={
                detail.availableRoutes.length ? (
                  <div className="space-y-0.5">
                    {detail.availableRoutes.map((r) => (
                      <div key={r} className="font-mono text-[12.5px] text-ink-500">
                        {r}
                        <Text type="secondary" className="ml-1.5 !text-[11px]">
                          待审批
                        </Text>
                      </div>
                    ))}
                  </div>
                ) : null
              }
            />

            <div className="mt-4 space-y-2 rounded-lg bg-ink-50/70 p-3">
              <div className="text-[12px] font-medium text-ink-600">标识符</div>
              <CopyRow label="machineKey" value={detail.machineKey} />
              <CopyRow label="nodeKey" value={detail.nodeKey} />
              {detail.preAuthKeyPrefix && <CopyRow label="preAuthKey" value={detail.preAuthKeyPrefix} />}
            </div>

            {can('node:write') && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="small" icon={<EditOutlined />} onClick={() => setEditing({ mode: 'rename', node: detail })}>
                  重命名
                </Button>
                <Button size="small" icon={<TagsOutlined />} onClick={() => setEditing({ mode: 'tags', node: detail })}>
                  编辑标签
                </Button>
                <Button size="small" icon={<ClockCircleOutlined />} onClick={() => setEditing({ mode: 'expire', node: detail })}>
                  到期控制
                </Button>
              </div>
            )}
          </div>
        )}
      </Drawer>

      {/* ---------- 重命名 / 标签 / 到期 ---------- */}
      <Modal
        open={editing?.mode === 'rename'}
        title="重命名设备"
        onCancel={() => setEditing(null)}
        onOk={() => {
          const form = document.getElementById('rename-form') as HTMLFormElement | null;
          form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }}
        okText="保存"
        confirmLoading={renameMut.isPending}
        destroyOnClose
      >
        {editing?.mode === 'rename' && (
          <>
            <Alert
              type="info"
              showIcon
              className="mb-4"
              message="重命名只影响面板与 CLI 的显示名，客户端上报的主机名不会被改动。"
            />
            <Form
              id="rename-form"
              layout="vertical"
              initialValues={{ newName: editing.node.displayName }}
              onFinish={(v: { newName: string }) => renameMut.mutate({ id: editing.node.id, newName: v.newName })}
            >
              <Form.Item
                name="newName"
                label="新名称"
                rules={[
                  { required: true, message: '请输入设备名' },
                  { pattern: /^[a-zA-Z0-9._-]+$/, message: '仅允许字母、数字与 . _ -' },
                  { max: 63, message: '最长 63 字符' },
                ]}
              >
                <Input placeholder="例如 lab-alpha" autoFocus />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      <Modal
        open={editing?.mode === 'tags'}
        title="编辑标签"
        onCancel={() => setEditing(null)}
        onOk={() => {
          const form = document.getElementById('tags-form') as HTMLFormElement | null;
          form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        }}
        okText="保存"
        confirmLoading={tagsMut.isPending}
        destroyOnClose
      >
        {editing?.mode === 'tags' && (
          <>
            <Alert
              type="warning"
              showIcon
              className="mb-4"
              message="标签必须先在 ACL 的 tagOwners 中定义，否则 Headscale 会拒绝"
              description={
                <span className="text-[12.5px]">
                  输入时带 <span className="font-mono">tag:</span> 前缀，例如 <span className="font-mono">tag:prod</span>。
                </span>
              }
            />
            <Form
              id="tags-form"
              layout="vertical"
              initialValues={{ tags: editing.node.tags }}
              onFinish={(v: { tags?: string[] }) => tagsMut.mutate({ id: editing.node.id, tags: v.tags ?? [] })}
            >
              <Form.Item
                name="tags"
                label="标签"
                rules={[
                  {
                    validator: (_r, val: string[] | undefined) => {
                      const bad = (val ?? []).filter((t) => !/^tag:[a-zA-Z0-9._-]+$/.test(t));
                      return bad.length ? Promise.reject(new Error(`格式不正确：${bad.join(', ')}`)) : Promise.resolve();
                    },
                  },
                ]}
              >
                <Select
                  mode="tags"
                  placeholder="输入 tag:name 后回车"
                  tokenSeparators={[',', ' ']}
                  open={false}
                  suffixIcon={null}
                />
              </Form.Item>
            </Form>
          </>
        )}
      </Modal>

      <ExpireModal
        open={editing?.mode === 'expire'}
        node={editing?.mode === 'expire' ? editing.node : null}
        loading={expireMut.isPending}
        onCancel={() => setEditing(null)}
        onSubmit={(body) => editing && expireMut.mutate({ id: editing.node.id, body })}
      />

      {/* ---------- 注册设备 ---------- */}
      <RegisterModal
        open={registerOpen}
        onClose={() => setRegisterOpen(false)}
        users={usersQuery.data?.users ?? []}
        onDone={() => void invalidate()}
      />
    </>
  );
}

function CopyRow({ label, value }: { label: string; value: string }): React.ReactElement {
  const { message } = AntApp.useApp();
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 font-mono text-[11px] text-ink-500">{label}</span>
      <button
        type="button"
        onClick={async () => {
          const ok = await copyText(value);
          if (ok) message.success('已复制');
          else message.warning('复制失败，请手动选择文本复制');
        }}
        className="min-w-0 flex-1 truncate border-0 bg-transparent text-right font-mono text-[11px] text-ink-700 hover:text-brand-600"
        title={value}
      >
        {value || '—'}
      </button>
      <CopyOutlined className="shrink-0 text-[11px] text-ink-400" />
    </div>
  );
}

function ExpireModal({
  open,
  node,
  loading,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  node: HsNode | null;
  loading: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}): React.ReactElement {
  const [mode, setMode] = useState<'never' | 'date' | 'now'>('never');
  const [dateStr, setDateStr] = useState('');

  return (
    <Modal
      open={open}
      title="到期控制"
      onCancel={onCancel}
      onOk={() => {
        if (mode === 'never') onSubmit({ neverExpires: true });
        else if (mode === 'now') onSubmit({});
        else if (dateStr) onSubmit({ expiry: new Date(dateStr).toISOString() });
      }}
      okText="应用"
      confirmLoading={loading}
      destroyOnClose
    >
      {node && (
        <>
          <div className="mb-3 rounded-lg bg-ink-50/70 p-3 text-[12.5px]">
            <div className="flex justify-between">
              <span className="text-ink-500">当前状态</span>
              <span>
                {node.neverExpires ? (
                  <StatePill tone="ok">永不过期</StatePill>
                ) : (
                  <Countdown seconds={node.expiresInSec} />
                )}
              </span>
            </div>
            {node.expiryRaw && (
              <div className="mt-1.5 font-mono text-[11px] text-ink-400">原始值：{node.expiryRaw}</div>
            )}
          </div>

          <Segmented
            block
            value={mode}
            onChange={(v) => setMode(v as 'never' | 'date' | 'now')}
            options={[
              { label: '永不过期', value: 'never' },
              { label: '指定时间', value: 'date' },
              { label: '立即过期', value: 'now' },
            ]}
          />

          {mode === 'date' && (
            <div className="mt-3">
              <Input
                type="datetime-local"
                value={dateStr}
                onChange={(e) => setDateStr(e.target.value)}
                placeholder="选择到期时间"
              />
              <div className="mt-1.5 text-[11.5px] text-ink-400">按本地时区选择，提交时转换为 UTC</div>
            </div>
          )}

          {mode === 'now' && (
            <Alert
              type="warning"
              showIcon
              className="mt-3"
              message="立即过期会使该设备立刻失去网络访问权限，需要重新注册才能恢复。"
            />
          )}

          <div className="mt-3 rounded-lg border border-ink-200 p-2.5 text-[11.5px] leading-relaxed text-ink-500">
            <span className="font-medium text-ink-600">实现说明：</span>
            Headscale 的 expire 接口不带请求体绑定，参数实际以查询字符串传递；
            本面板已处理该细节，「永不过期」对应上游的 <span className="font-mono">disable_expiry=true</span>。
          </div>
        </>
      )}
    </Modal>
  );
}

function RegisterModal({
  open,
  onClose,
  users,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  users: { id: number; name: string }[];
  onDone: () => void;
}): React.ReactElement {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm<{ user: string; key: string }>();

  const mut = useMutation({
    mutationFn: (v: { user: string; key: string }) => api.post<{ node: HsNode }>('/api/nodes/register', v),
    onSuccess: (r) => {
      message.success(`设备「${r.node.displayName}」已注册`);
      form.resetFields();
      onClose();
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code.startsWith('HEADSCALE_')) {
        message.error(
          `${errorText(e)}。请确认填入的是有效的预授权密钥（hskey-auth- 开头）或待批设备返回的 authId（hskey-authreq- 开头）。`,
        );
      } else {
        message.error(errorText(e));
      }
    },
  });

  return (
    <Modal
      open={open}
      title="手动注册设备"
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => form.submit()}
      okText="注册"
      confirmLoading={mut.isPending}
      destroyOnClose
    >
      <Alert
        type="info"
        showIcon
        className="mb-4"
        message="把设备注册到指定用户下"
        description={
          <span className="text-[12.5px]">
            密钥可填<b>预授权密钥</b>（面板「密钥管理」中创建），或设备执行{' '}
            <span className="font-mono">tailscale up</span> 后返回的待批 authId。
          </span>
        }
      />
      <Form form={form} layout="vertical" onFinish={(v) => mut.mutate(v)}>
        <Form.Item name="user" label="归属用户" rules={[{ required: true, message: '请选择用户' }]}>
          <Select
            placeholder="选择 Headscale 用户"
            options={users.map((u) => ({ label: u.name, value: u.name }))}
            showSearch
          />
        </Form.Item>
        <Form.Item
          name="key"
          label="密钥"
          rules={[
            { required: true, message: '请填写密钥' },
            {
              validator: (_r, v: string) =>
                v && (v.startsWith('hskey-auth-') || v.startsWith('hskey-authreq-'))
                  ? Promise.resolve()
                  : Promise.reject(new Error('应为 hskey-auth-... 或 hskey-authreq-... 开头')),
            },
          ]}
        >
          <Input.TextArea rows={2} placeholder="hskey-auth-...  或  hskey-authreq-..." className="!font-mono !text-[12px]" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
