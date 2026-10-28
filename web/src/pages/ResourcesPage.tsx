/**
 * 资源中心页
 *
 * 管「IP + 端口」形式的内部资源，并把名字/IP 同步成 ACL 的 hosts 条目。
 *
 * ## 这个页面最容易让人误解的两点，都在 UI 上写清楚了
 * 1. **hosts 只决定"名字指向哪个 IP"，不决定谁能访问。**
 *    连通性由 acls 规则决定；全通/全禁模式下 hosts 完全不起作用。
 *    所以同步前会先显示当前策略模式，模式不是 rules 时直接警告。
 * 2. **端口不进 hosts。** ACL hosts 语法只承载 IP/CIDR，
 *    端口只能写在规则的 dst 里（`资源名:22`）。页面把两者分开呈现，
 *    避免用户以为「填了端口就放行了端口」。
 *
 * ## 权限控制不自动改连通性
 * `ownerGroup` 用来推导「组内成员对应的网络身份」，产出**参考规则**。
 * 这些规则只展示、可复制，不会自动写进策略——自动给一批人开权限是
 * 高风险动作，必须由人确认后再走 ACL 那边的「应用策略」。
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntApp,
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudDownloadOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  SyncOutlined,
} from '@ant-design/icons';

import { api, errorText } from '../api/client';
import type {
  Resource,
  ResourceListResponse,
  ResourceSyncPreview,
  PanelGroup,
} from '../api/types';
import { PageHeader, StatePill } from '../components/ui';
import { useAuth } from '../store/auth';

const { Text } = Typography;

interface FormValues {
  name: string;
  ip: string;
  ports?: string;
  protocol: 'tcp' | 'udp';
  description?: string;
  ownerGroup?: string | null;
  enabled: boolean;
}

export default function ResourcesPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { can } = useAuth();
  const canWrite = can('resource:write');

  const [editing, setEditing] = useState<Resource | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const listQuery = useQuery({
    queryKey: ['resources'],
    queryFn: () => api.get<ResourceListResponse>('/api/resources'),
  });

  const groupsQuery = useQuery({
    queryKey: ['panel-groups'],
    queryFn: () => api.get<{ groups: PanelGroup[] }>('/api/panel/groups'),
    retry: 0,
  });

  const previewQuery = useQuery({
    queryKey: ['resources-sync-preview'],
    queryFn: () => api.get<ResourceSyncPreview>('/api/resources/sync/preview'),
    enabled: previewOpen,
    retry: 0,
  });

  const items = listQuery.data?.resources ?? [];
  const stats = listQuery.data?.stats;

  const groupOptions = useMemo(
    () => (groupsQuery.data?.groups ?? []).map((g) => ({ label: g.name, value: g.name })),
    [groupsQuery.data],
  );

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ protocol: 'tcp', enabled: true, ownerGroup: null });
    setModalOpen(true);
  };

  const openEdit = (r: Resource): void => {
    setEditing(r);
    form.setFieldsValue({
      name: r.name,
      ip: r.ip,
      ports: r.ports.join(','),
      protocol: r.protocol === 'udp' ? 'udp' : 'tcp',
      description: r.description,
      ownerGroup: r.ownerGroup,
      enabled: r.enabled,
    });
    setModalOpen(true);
  };

  const submit = async (): Promise<void> => {
    const v = await form.validateFields();
    try {
      if (editing) {
        const r = await api.put<{ needResync: boolean }>(`/api/resources/${editing.id}`, {
          name: v.name,
          ip: v.ip,
          ports: v.ports ?? '',
          protocol: v.protocol,
          description: v.description ?? null,
          ownerGroup: v.ownerGroup ?? null,
          enabled: v.enabled,
        });
        message.success(r.needResync ? '已保存；名字或 IP 变了，需要重新同步到 ACL' : '已保存');
      } else {
        await api.post('/api/resources', {
          name: v.name,
          ip: v.ip,
          ports: v.ports ?? '',
          protocol: v.protocol,
          description: v.description ?? null,
          ownerGroup: v.ownerGroup ?? null,
          enabled: v.enabled,
        });
        message.success('已新增');
      }
      setModalOpen(false);
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['resources-sync-preview'] });
      await qc.invalidateQueries({ queryKey: ['overview'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doDelete = async (r: Resource): Promise<void> => {
    try {
      // 同步删 hosts 条目（不传则策略里留孤儿）
      // api.del 不支持 query 参数，查询串直接拼进 URL
      const res = await api.del<{ hostRemoved: boolean }>(
        `/api/resources/${r.id}?removeFromHosts=1`,
      );
      message.success(res.hostRemoved ? '已删除，并移除 ACL hosts 条目' : '已删除');
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['resources-sync-preview'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doSync = async (overwrite: boolean): Promise<void> => {
    setSyncing(true);
    try {
      const res = await api.post<{
        applied: { added: number; updated: number; pruned: number };
        versionId: number;
        aclsUntouched: boolean;
      }>('/api/resources/sync', { overwrite, pruneOrphans: false });
      message.success(
        `同步完成：新增 ${res.applied.added} / 更新 ${res.applied.updated}` +
          `（ACL 规则未改动，hosts 只影响名字解析）`,
      );
      setPreviewOpen(false);
      await qc.invalidateQueries({ queryKey: ['resources'] });
      await qc.invalidateQueries({ queryKey: ['resources-sync-preview'] });
      await qc.invalidateQueries({ queryKey: ['acl-policy'] });
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setSyncing(false);
    }
  };

  const columns: ColumnsType<Resource> = [
    {
      title: '资源名',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, r) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-ink-800">{name}</span>
          {!r.enabled && <StatePill tone="idle">已禁用</StatePill>}
        </div>
      ),
    },
    {
      title: 'IP / CIDR',
      dataIndex: 'ip',
      key: 'ip',
      render: (ip: string) => <span className="font-mono text-[12px] text-ink-700">{ip}</span>,
    },
    {
      title: (
        <span className="inline-flex items-center gap-1">
          端口
          <Tooltip title="端口不进 ACL hosts（hosts 只承载 IP/CIDR）。这里的端口用于生成参考规则的 dst 部分，如 资源名:22">
            <InfoCircleOutlined className="text-[11px] text-ink-300" />
          </Tooltip>
        </span>
      ),
      dataIndex: 'ports',
      key: 'ports',
      render: (ports: string[], r) => {
        if (ports.length === 0) return <Tag className="!m-0">全部端口</Tag>;
        return (
          <div className="flex flex-wrap gap-1">
            {ports.map((p) => (
              <Tag key={p} color={r.protocol === 'udp' ? 'purple' : 'blue'} className="!m-0 !text-[11px]">
                {r.protocol}/{p}
              </Tag>
            ))}
          </div>
        );
      },
    },
    {
      title: '归属组',
      dataIndex: 'ownerGroup',
      key: 'ownerGroup',
      width: 130,
      render: (g: string | null) => (g ? <Tag className="!m-0">{g}</Tag> : <span className="text-ink-300">—</span>),
    },
    {
      title: (
        <span className="inline-flex items-center gap-1">
          hosts 同步
          <Tooltip title="synced_at 表示最后一次把该资源写入 ACL hosts 的时间。改名或改 IP 后会清空，提示需要重新同步">
            <InfoCircleOutlined className="text-[11px] text-ink-300" />
          </Tooltip>
        </span>
      ),
      dataIndex: 'syncedAt',
      key: 'syncedAt',
      width: 150,
      render: (t: string | null, r) => {
        if (!r.enabled) return <span className="text-[11.5px] text-ink-400">已禁用，不同步</span>;
        if (!t) return <StatePill tone="warn">待同步</StatePill>;
        return (
          <span className="text-[11.5px] text-ink-500">
            {new Date(t).toLocaleString('zh-CN', { hour12: false })}
          </span>
        );
      },
    },
    {
      title: '操作',
      key: 'ops',
      width: 150,
      render: (_: unknown, r) => (
        <Space size={4}>
          <Button size="small" type="link" icon={<EditOutlined />} disabled={!canWrite} onClick={() => openEdit(r)}>
            编辑
          </Button>
          <Popconfirm
            title="删除这个资源？"
            description="同时会从 ACL hosts 里移除对应条目（不触碰 acls 规则）"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void doDelete(r)}
            disabled={!canWrite}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />} disabled={!canWrite}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  if (listQuery.isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <Spin size="large" tip="加载资源…" />
      </div>
    );
  }

  if (listQuery.error) {
    return (
      <div className="hsa-card p-6">
        <Alert type="error" showIcon message="加载资源失败" description={errorText(listQuery.error)} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="资源中心"
        description="以 IP + 端口定义内部资源，同步为 ACL hosts 条目"
        extra={
          <Space>
            <Button
              icon={<SyncOutlined />}
              onClick={() => setPreviewOpen(true)}
              disabled={!canWrite}
            >
              同步到 ACL
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canWrite}>
              新增资源
            </Button>
          </Space>
        }
      />

      {/* 语义说明：一次性讲清 hosts 与连通性的关系，避免最常见误解 */}
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        className="mb-4"
        message="hosts 只决定「名字指向哪个 IP」，不决定谁能访问"
        description={
          <div className="text-[12.5px] leading-relaxed">
            连通性由 <Text code>acls</Text> 规则决定；策略处于「全通」或「全禁」时，
            hosts 条目<b>不会被任何规则引用</b>，同步后不会改变连通性。
            端口也不进 hosts（ACL hosts 语法只承载 IP/CIDR），只用于生成参考规则的
            <Text code>资源名:端口</Text> 部分。
          </div>
        }
      />

      {stats && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="hsa-card px-4 py-3">
            <div className="text-[11px] text-ink-500">资源总数</div>
            <div className="mt-0.5 font-mono text-[18px] font-semibold text-ink-800">{stats.total}</div>
          </div>
          <div className="hsa-card px-4 py-3">
            <div className="text-[11px] text-ink-500">已启用</div>
            <div className="mt-0.5 font-mono text-[18px] font-semibold text-ink-800">{stats.enabled}</div>
          </div>
          <div className="hsa-card px-4 py-3">
            <div className="text-[11px] text-ink-500">已同步 hosts</div>
            <div className="mt-0.5 font-mono text-[18px] font-semibold text-emerald-600">{stats.synced}</div>
          </div>
          <div className="hsa-card px-4 py-3">
            <div className="text-[11px] text-ink-500">待同步</div>
            <div className={`mt-0.5 font-mono text-[18px] font-semibold ${stats.unsynced > 0 ? 'text-amber-600' : 'text-ink-400'}`}>
              {stats.unsynced}
            </div>
          </div>
        </div>
      )}

      <div className="hsa-card overflow-hidden p-0">
        {items.length === 0 ? (
          <div className="p-10">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <div className="text-[12.5px] text-ink-500">
                  还没有资源。新增后可用「同步到 ACL」把名字写入策略的 hosts。
                </div>
              }
            >
              {canWrite && (
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新增第一个资源
                </Button>
              )}
            </Empty>
          </div>
        ) : (
          <Table<Resource>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={items}
            pagination={false}
            scroll={{ x: 'max-content' }}
            className="hsa-table"
          />
        )}
      </div>

      {/* ---------------------------------------------------------------- 编辑弹窗 */}
      <Modal
        open={modalOpen}
        title={editing ? `编辑资源 ${editing.name}` : '新增资源'}
        okText="保存"
        cancelText="取消"
        confirmLoading={false}
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="资源名"
            rules={[
              { required: true, message: '请输入资源名' },
              {
                pattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/,
                message: '只能包含字母、数字、下划线和短横线，以字母或数字开头',
              },
            ]}
            extra="会作为 ACL hosts 的键名，也是规则里 dst 的前缀（如 db-server:5432）"
          >
            <Input placeholder="db-server" autoComplete="off" />
          </Form.Item>

          <Form.Item
            name="ip"
            label="IP / CIDR"
            rules={[{ required: true, message: '请输入 IP 或 CIDR' }]}
            extra="支持 IPv4 / IPv6 / CIDR，如 10.0.0.5 或 10.0.0.0/24"
          >
            <Input placeholder="10.0.0.5" className="font-mono" autoComplete="off" />
          </Form.Item>

          <Form.Item
            name="ports"
            label="端口（可选）"
            extra="逗号分隔，支持区间：22,443,8000-8100。留空表示规则里用 资源名:*"
          >
            <Input placeholder="22,443" className="font-mono" autoComplete="off" />
          </Form.Item>

          <Form.Item name="protocol" label="协议">
            <Select
              options={[
                { label: 'TCP', value: 'tcp' },
                { label: 'UDP', value: 'udp' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="ownerGroup"
            label="归属面板组（可选）"
            extra="用于生成「参考 ACL 规则」：把组内成员绑定的网络身份作为 src。不会自动改连通性。"
          >
            <Select allowClear placeholder="不归属任何组" options={groupOptions} />
          </Form.Item>

          <Form.Item name="description" label="说明（可选）">
            <Input placeholder="例如：生产数据库主库" />
          </Form.Item>

          <Form.Item name="enabled" label="启用" valuePropName="checked" extra="禁用后不再参与同步">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>

      {/* ---------------------------------------------------------------- 同步预览 */}
      <Modal
        open={previewOpen}
        title="同步资源到 ACL hosts"
        width={780}
        okText={previewQuery.data?.hostDiff.conflicts.length ? '覆盖冲突项并同步' : '执行同步'}
        cancelText="取消"
        confirmLoading={syncing}
        okButtonProps={{
          disabled: !previewQuery.data || !previewQuery.data.policy.hostsEffective,
          icon: <CloudDownloadOutlined />,
        }}
        onOk={() =>
          void doSync(Boolean(previewQuery.data?.hostDiff.conflicts.length))
        }
        onCancel={() => setPreviewOpen(false)}
        destroyOnClose
      >
        {previewQuery.isLoading ? (
          <div className="py-8 text-center">
            <Spin tip="计算差异…" />
          </div>
        ) : previewQuery.error ? (
          <Alert type="error" showIcon message="预览失败" description={errorText(previewQuery.error)} />
        ) : previewQuery.data ? (
          <div className="space-y-3">
            {/* 策略模式警告：非 rules 模式下同步毫无意义 */}
            {!previewQuery.data.policy.hostsEffective && (
              <Alert
                type="warning"
                showIcon
                message="当前策略模式使 hosts 不生效，同步不会改变连通性"
                description={<div className="text-[12.5px]">{previewQuery.data.policy.warning}</div>}
              />
            )}

            <div className="rounded-lg bg-ink-50 px-3 py-2 text-[12px]">
              当前策略：<b>{previewQuery.data.policy.mode}</b>
              <div className="mt-0.5 text-[11.5px] text-ink-500">{previewQuery.data.policy.explanation}</div>
            </div>

            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {[
                ['新增 hosts', previewQuery.data.stats.toAdd, 'text-emerald-600'],
                ['更新 hosts', previewQuery.data.stats.toUpdate, 'text-brand-600'],
                ['冲突（需确认）', previewQuery.data.stats.conflicts, 'text-amber-600'],
                ['孤儿条目', previewQuery.data.stats.orphans, 'text-ink-500'],
              ].map(([label, n, cls]) => (
                <div key={String(label)} className="rounded-lg border border-ink-100 px-3 py-2">
                  <div className="text-[11px] text-ink-500">{String(label)}</div>
                  <div className={`mt-0.5 font-mono text-[16px] font-semibold ${String(cls)}`}>{String(n)}</div>
                </div>
              ))}
            </div>

            {previewQuery.data.hostDiff.adds.length > 0 && (
              <div>
                <div className="mb-1 text-[12px] font-medium text-ink-700">将新增</div>
                <div className="max-h-32 overflow-auto rounded-lg bg-ink-50 p-2 font-mono text-[11.5px]">
                  {previewQuery.data.hostDiff.adds.map((a) => (
                    <div key={a.name}>
                      {a.name} → {a.ip}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {previewQuery.data.hostDiff.conflicts.length > 0 && (
              <div>
                <div className="mb-1 text-[12px] font-medium text-amber-700">
                  冲突（策略里已有同名 hosts 且值不同，默认不覆盖）
                </div>
                <div className="max-h-32 overflow-auto rounded-lg bg-amber-50 p-2 font-mono text-[11.5px] text-amber-800">
                  {previewQuery.data.hostDiff.conflicts.map((c) => (
                    <div key={c.name}>
                      {c.name}: 现状 {c.existing} → 资源要求 {c.wanted}
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-[11.5px] text-ink-500">
                  点「覆盖冲突项并同步」才会改写这些条目。若它们是手工维护的，建议先改资源名。
                </div>
              </div>
            )}

            {previewQuery.data.referenceRules.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-ink-700">
                  <DatabaseOutlined />
                  参考 ACL 规则（<b>不会自动应用</b>）
                  <Tooltip title="按资源归属面板组，推导组内成员绑定的 Headscale 网络身份作为 src。需要放行请复制到 ACL 管理里确认后应用。">
                    <InfoCircleOutlined className="text-[11px] text-ink-300" />
                  </Tooltip>
                </div>
                <div className="max-h-40 overflow-auto rounded-lg bg-ink-50 p-2 font-mono text-[11px] leading-relaxed">
                  {previewQuery.data.referenceRules.map((r) => (
                    <div key={r.resource} className={r.executable ? '' : 'text-ink-400'}>
                      {`{ "action": "accept", "proto": "${r.protocol}", "src": ${JSON.stringify(r.src)}, "dst": ${JSON.stringify(r.dst)} }`}
                      <span className="ml-2 font-sans text-[10.5px] text-ink-400">
                        {r.ownerGroup}
                        {!r.executable && ` · ${r.note}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-lg bg-ink-50 px-3 py-2 text-[11.5px] leading-relaxed text-ink-500">
              同步只写 <Text code>hosts</Text>，<b>不会改动 acls / grants</b>。
              这是刻意的：策略里「无 acls 键」表示全通、「acls 为空数组」表示全禁，
              顺手补一个空数组会把全网从全通静默翻成全禁。
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
