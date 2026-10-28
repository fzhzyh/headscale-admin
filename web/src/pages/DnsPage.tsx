/**
 * DNS 额外记录页
 *
 * 管理 extra_records，并写入 headscale 的 extra_records 文件（fsnotify 热加载）。
 *
 * ## 页面上必须讲清的三件事
 * 1. **只支持 A / AAAA** —— 其他类型上游不接受。
 * 2. **非法 JSON 会让 headscale 启动失败**。所以「已写入文件」这个状态是
 *    有实际风险的动作：面板做往返校验 + 原子写，up.sh 启动前还会自愈坏文件。
 * 3. **写入成功 ≠ DNS 已可解析**。运行时重载是静默的（无日志、无查询接口），
 *    真要验证得接真实 Tailscale 客户端。页面不会假装「已验证生效」。
 *
 * ## 为什么「应用」是全量覆盖
 * 面板是这批记录的权威来源，全量写能让删除也自然生效。
 * 代价是手改文件的内容会被覆盖，所以状态栏会先报 fileOnly（文件里独占的条目），
 * 有手改痕迹时要求二次确认。
 */
import { useState } from 'react';
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
  Statistic,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  DeleteOutlined,
  EditOutlined,
  GlobalOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  WarningOutlined,
} from '@ant-design/icons';

import { api, errorText } from '../api/client';
import type { DnsRecord, DnsListResponse, DnsStatus, DnsApplyResult } from '../api/types';
import { PageHeader, StatePill } from '../components/ui';
import { useAuth } from '../store/auth';

interface FormValues {
  name: string;
  type: 'A' | 'AAAA';
  value: string;
  comment?: string;
}

export default function DnsPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();
  const canWrite = can('dns:write');

  const [editing, setEditing] = useState<DnsRecord | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const listQuery = useQuery({
    queryKey: ['dns-records'],
    queryFn: () => api.get<DnsListResponse>('/api/dns/records'),
  });

  const statusQuery = useQuery({
    queryKey: ['dns-status'],
    queryFn: () => api.get<DnsStatus>('/api/dns/status'),
    refetchInterval: 30_000,
  });

  const items = listQuery.data?.records ?? [];
  const status = statusQuery.data;

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ type: 'A' });
    setModalOpen(true);
  };

  const openEdit = (r: DnsRecord): void => {
    setEditing(r);
    form.setFieldsValue({ name: r.name, type: r.type as 'A' | 'AAAA', value: r.value, comment: r.comment });
    setModalOpen(true);
  };

  const submit = async (): Promise<void> => {
    const v = await form.validateFields();
    try {
      if (editing) {
        await api.put(`/api/dns/records/${editing.id}`, {
          name: v.name,
          type: v.type,
          value: v.value,
          comment: v.comment ?? null,
        });
        message.success('已保存；记得「应用到文件」才会生效');
      } else {
        await api.post('/api/dns/records', {
          name: v.name,
          type: v.type,
          value: v.value,
          comment: v.comment ?? null,
        });
        message.success('已新增；记得「应用到文件」才会生效');
      }
      setModalOpen(false);
      await qc.invalidateQueries({ queryKey: ['dns-records'] });
      await qc.invalidateQueries({ queryKey: ['dns-status'] });
      await qc.invalidateQueries({ queryKey: ['overview'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doDelete = async (r: DnsRecord): Promise<void> => {
    try {
      await api.del(`/api/dns/records/${r.id}`);
      message.success('已删除；记得「应用到文件」才会生效');
      await qc.invalidateQueries({ queryKey: ['dns-records'] });
      await qc.invalidateQueries({ queryKey: ['dns-status'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doApply = async (force = false): Promise<void> => {
    setApplying(true);
    try {
      const res = await api.post<DnsApplyResult>('/api/dns/apply', { force });
      message.success(`已写入 ${res.count} 条记录到文件`);
      await qc.invalidateQueries({ queryKey: ['dns-status'] });
      modal.info({
        title: '文件已写入',
        width: 560,
        content: (
          <div className="text-[12.5px] leading-relaxed">
            <p className="mb-2">
              路径：<span className="font-mono">{res.path}</span>
            </p>
            <p className="mb-2">
              覆盖前文件里有 {res.replaced} 条，现在写入 {res.count} 条。
            </p>
            <Alert
              type="info"
              showIcon
              message="这不等于「DNS 已可解析」"
              description={
                <span className="text-[12px]">
                  运行时重载是静默的（headscale 不打印日志、也没有查询接口）。
                  文件已按合法格式落盘、headscale 会通过 fsnotify 热加载；
                  但要确认解析结果，需要真实 Tailscale 客户端接入后实测。
                </span>
              }
            />
          </div>
        ),
      });
    } catch (e) {
      const err = e as { code?: string; body?: { fileOnly?: string[]; hint?: string } };
      if (err.code === 'FILE_DRIFT') {
        const fileOnly = err.body?.fileOnly ?? [];
        modal.confirm({
          title: '文件里有面板库中没有的记录',
          width: 560,
          content: (
            <div className="text-[12.5px]">
              <p className="mb-2">全量写入会覆盖掉下面这些条目：</p>
              <div className="max-h-32 overflow-auto rounded bg-ink-50 p-2 font-mono text-[11.5px]">
                {fileOnly.map((x) => (
                  <div key={x}>{x}</div>
                ))}
              </div>
              <p className="mt-2 text-ink-500">
                若它们是手工维护的，建议先加进面板库再应用；确认可丢弃则继续。
              </p>
            </div>
          ),
          okText: '确认覆盖',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => doApply(true),
        });
      } else {
        message.error(errorText(e));
      }
    } finally {
      setApplying(false);
    }
  };

  const columns: ColumnsType<DnsRecord> = [
    {
      title: '记录名',
      dataIndex: 'name',
      key: 'name',
      render: (n: string) => <span className="font-mono text-[12.5px] text-ink-800">{n}</span>,
    },
    {
      title: '类型',
      dataIndex: 'type',
      key: 'type',
      width: 90,
      render: (t: string) => (
        <Tag color={t === 'AAAA' ? 'purple' : 'blue'} className="!m-0 !text-[11px]">
          {t}
        </Tag>
      ),
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      render: (v: string) => <span className="font-mono text-[12px] text-ink-700">{v}</span>,
    },
    {
      title: '备注',
      dataIndex: 'comment',
      key: 'comment',
      render: (c: string) => c || <span className="text-ink-300">—</span>,
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
            title="删除这条记录？"
            description="删除后需要「应用到文件」才会从 headscale 侧移除"
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
        <Spin size="large" tip="加载 DNS 记录…" />
      </div>
    );
  }

  if (listQuery.error) {
    return (
      <div className="hsa-card p-6">
        <Alert type="error" showIcon message="加载 DNS 记录失败" description={errorText(listQuery.error)} />
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="DNS 记录"
        description="管理 Headscale extra_records（A / AAAA），写文件即热生效"
        extra={
          <Space>
            <Button
              icon={<CloudUploadOutlined />}
              onClick={() => void doApply(false)}
              loading={applying}
              disabled={!canWrite}
            >
              应用到文件
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canWrite}>
              新增记录
            </Button>
          </Space>
        }
      />

      {/* 文件状态：这是本页最关键的一块——写坏了会让 headscale 起不来 */}
      {status && (
        <div className="mb-4">
          {!status.valid ? (
            <Alert
              type="error"
              showIcon
              icon={<WarningOutlined />}
              message="extra_records 文件当前不是合法 JSON —— headscale 重启会直接失败"
              description={
                <div className="text-[12.5px]">
                  <div className="font-mono">{status.path}</div>
                  <div className="mt-1 text-ink-600">{status.error}</div>
                  <div className="mt-1.5">
                    处置：`container/up.sh` 启动前会自愈（备份坏文件并重置为空数组）；
                    也可以点「应用到文件」按面板库重写。
                  </div>
                </div>
              }
            />
          ) : status.drift ? (
            <Alert
              type="warning"
              showIcon
              message={`文件与面板库不一致：文件 ${status.fileCount} 条 / 库 ${status.dbCount} 条`}
              description={
                <div className="text-[12.5px]">
                  可能有人手改了文件，或改完库还没「应用到文件」。
                  {status.fileOnly.length > 0 && (
                    <div className="mt-1">
                      文件里独占的条目：<span className="font-mono">{status.fileOnly.join('；')}</span>
                    </div>
                  )}
                </div>
              }
            />
          ) : (
            <Alert
              type="success"
              showIcon
              message={`已同步：文件与面板库一致（${status.fileCount} 条）`}
              description={
                <div className="text-[12.5px] text-ink-600">
                  <span className="font-mono">{status.path}</span>
                  {status.mtime && <span className="ml-2 text-ink-400">最后修改 {new Date(status.mtime).toLocaleString('zh-CN', { hour12: false })}</span>}
                </div>
              }
            />
          )}
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="hsa-card px-4 py-3">
          <Statistic title={<span className="text-[11px]">记录总数</span>} value={listQuery.data?.stats.total ?? 0} valueStyle={{ fontSize: 18 }} />
        </div>
        <div className="hsa-card px-4 py-3">
          <Statistic title={<span className="text-[11px]">A 记录</span>} value={listQuery.data?.stats.a ?? 0} valueStyle={{ fontSize: 18 }} />
        </div>
        <div className="hsa-card px-4 py-3">
          <Statistic title={<span className="text-[11px]">AAAA 记录</span>} value={listQuery.data?.stats.aaaa ?? 0} valueStyle={{ fontSize: 18 }} />
        </div>
        <div className="hsa-card px-4 py-3">
          <div className="text-[11px] text-ink-500">文件状态</div>
          <div className="mt-1">
            {status ? (
              status.valid ? (
                status.drift ? <StatePill tone="warn">与库不一致</StatePill> : <StatePill tone="ok">已同步</StatePill>
              ) : (
                <StatePill tone="danger">文件格式错误</StatePill>
              )
            ) : (
              <span className="text-[12px] text-ink-400">检测中…</span>
            )}
          </div>
        </div>
      </div>

      <div className="hsa-card overflow-hidden p-0">
        {items.length === 0 ? (
          <div className="p-10">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span className="text-[12.5px] text-ink-500">还没有 DNS 记录</span>}
            >
              {canWrite && (
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新增第一条
                </Button>
              )}
            </Empty>
          </div>
        ) : (
          <Table<DnsRecord>
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

      {/* 约束说明 */}
      <div className="mt-3 hsa-card p-4">
        <div className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-800">
          <GlobalOutlined className="text-brand-500" />
          这个文件的几处硬约束
          <Tooltip title="全部经实测确认，不是从文档抄的">
            <InfoCircleOutlined className="text-[11px] text-ink-300" />
          </Tooltip>
        </div>
        <ul className="space-y-1.5 text-[11.5px] leading-relaxed text-ink-500">
          <li>
            <b className="text-ink-700">只支持 A / AAAA</b>，其他类型上游不接受。
          </li>
          <li>
            <b className="text-ink-700">非法 JSON 会让 headscale 启动失败</b>
            （实测 `unmarshalling records ... invalid character` 后容器直接退出）。
            面板写入前做往返校验 + 原子写，`up.sh` 启动前也会自愈坏文件。
          </li>
          <li>
            <b className="text-ink-700">写入成功 ≠ DNS 已可解析</b>。运行时重载是静默的：
            headscale 不打印日志，也没有查询接口。要确认解析结果需真实 Tailscale 客户端。
          </li>
          <li>
            <b className="text-ink-700">应用是全量覆盖</b>：库里有什么就写什么，
            这样删除也能生效；代价是手改文件的内容会被覆盖，所以有手改痕迹时会要求二次确认。
          </li>
        </ul>
      </div>

      <Modal
        open={modalOpen}
        title={editing ? `编辑记录 ${editing.name}` : '新增 DNS 记录'}
        okText="保存"
        cancelText="取消"
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item
            name="name"
            label="记录名"
            rules={[{ required: true, message: '请输入记录名' }]}
            extra="完整域名，如 grafana.lab.internal（不需要带末尾点）"
          >
            <Input placeholder="grafana.lab.internal" className="font-mono" autoComplete="off" />
          </Form.Item>

          <Form.Item name="type" label="类型" rules={[{ required: true }]} extra="仅 A / AAAA">
            <Select
              options={[
                { label: 'A（IPv4）', value: 'A' },
                { label: 'AAAA（IPv6）', value: 'AAAA' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="value"
            label="值"
            rules={[{ required: true, message: '请输入记录值' }]}
            extra="A 记录填 IPv4，AAAA 填 IPv6——类型与值必须匹配"
          >
            <Input placeholder="100.64.0.3" className="font-mono" autoComplete="off" />
          </Form.Item>

          <Form.Item name="comment" label="备注（可选）">
            <Input placeholder="例如：监控面板入口" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
