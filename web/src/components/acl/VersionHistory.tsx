/**
 * ACL 版本历史。
 *
 * headscale 本身没有策略版本管理，这里由面板自建版本库。两个设计取舍：
 *   1. **回滚不删除历史**：回滚＝把旧内容作为**新版本**重新应用，
 *      保留完整轨迹。否则一旦回滚就丢失「回滚前是什么」这个关键证据。
 *   2. **失败也入库**：推送 headscale 失败时依然记录版本（applied=false +
 *      applyError），因为「谁在什么时候试图改什么、为什么失败」是排障刚需。
 */
import { useState } from 'react';
import { Table, Tag, Button, Modal, Alert, Space, Tooltip, Typography, App as AntApp, Checkbox } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { HistoryOutlined, RollbackOutlined, DiffOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../../api/client';
import type { AclVersion, AclVersionListResponse, AclDiffResponse } from '../../api/types';
import { RelTime } from '../ui';

const { Text } = Typography;

const SOURCE_LABEL: Record<AclVersion['source'], { text: string; color: string }> = {
  manual: { text: '原始编辑', color: 'default' },
  'visual-editor': { text: '可视化编辑', color: 'blue' },
  ai: { text: 'AI 生成', color: 'purple' },
  rollback: { text: '回滚', color: 'orange' },
  import: { text: '导入基线', color: 'cyan' },
};

interface Props {
  canApply: boolean;
  canWrite: boolean;
  onRestored: () => void;
}

export default function VersionHistory({ canApply, canWrite, onRestored }: Props): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const [diffPair, setDiffPair] = useState<{ from: number; to: number } | null>(null);
  const [detail, setDetail] = useState<AclVersion | null>(null);
  const [ack, setAck] = useState(false);

  const listQuery = useQuery({
    queryKey: ['acl-versions'],
    queryFn: () => api.get<AclVersionListResponse>('/api/acl/versions', { limit: 100 }),
  });

  const diffQuery = useQuery({
    queryKey: ['acl-diff', diffPair],
    queryFn: () => api.get<AclDiffResponse>('/api/acl/diff', { from: diffPair!.from, to: diffPair!.to }),
    enabled: !!diffPair,
  });

  const invalidate = async (): Promise<void> => {
    await qc.invalidateQueries({ queryKey: ['acl-versions'] });
    await qc.invalidateQueries({ queryKey: ['acl-policy'] });
  };

  const rollbackMut = useMutation({
    mutationFn: (id: number) =>
      api.post<{ ok: boolean; versionId: number }>(`/api/acl/versions/${id}/rollback`, {
        acknowledgedImpact: true,
      }),
    onSuccess: async () => {
      message.success('已回滚并推送到 Headscale');
      setDetail(null);
      setAck(false);
      await invalidate();
      onRestored();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'NEED_ACK') {
        modal.warning({ title: '需要确认高危变更', content: e.message });
      } else {
        message.error(errorText(e));
      }
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.post(`/api/acl/versions/${id}/delete`),
    onSuccess: async () => {
      message.success('版本记录已删除');
      await invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  /** 最新版本（列表首项），用于「与最新对比」 */
  const latest: AclVersion | undefined = listQuery.data?.versions[0];

  const columns: ColumnsType<AclVersion> = [
    {
      title: '版本',
      dataIndex: 'id',
      width: 76,
      render: (id: number, r) => (
        <Space size={4}>
          <Text strong>#{id}</Text>
          {r.applied && (
            <Tooltip title="已成功推送到 Headscale 并生效">
              <Tag color="green" className="!mr-0 !text-[10px]">
                生效
              </Tag>
            </Tooltip>
          )}
          {!r.applied && r.applyError && (
            <Tooltip title={`推送失败：${r.applyError}`}>
              <Tag color="red" className="!mr-0 !text-[10px]">
                失败
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      width: 92,
      render: (s: AclVersion['source']) => <Tag color={SOURCE_LABEL[s]?.color}>{SOURCE_LABEL[s]?.text ?? s}</Tag>,
    },
    {
      title: '说明',
      dataIndex: 'comment',
      ellipsis: true,
      render: (c: string | null) => c || <span className="text-ink-300">—</span>,
    },
    {
      title: '内容摘要',
      key: 'summary',
      width: 210,
      render: (_, r) => (
        <span className="text-[11.5px] text-ink-500">
          ACL {r.summary.acls} · SSH {r.summary.ssh} · 主机 {r.summary.hosts} · 分组 {r.summary.groups} · 标签{' '}
          {r.summary.tagOwners}
          {r.summary.bytes ? ` · ${r.summary.bytes}B` : ''}
        </span>
      ),
    },
    {
      title: '操作人',
      dataIndex: 'authorName',
      width: 96,
      render: (a: string | null) => a || <span className="text-ink-300">系统</span>,
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 130,
      render: (iso: string) => <RelTime iso={iso} />,
    },
    {
      title: '操作',
      key: 'ops',
      width: 168,
      render: (_, r) => (
        <Space size={2}>
          <Button size="small" type="text" onClick={() => setDetail(r)}>
            查看
          </Button>
          <Tooltip title="与最新版本对比">
            <Button
              size="small"
              type="text"
              icon={<DiffOutlined />}
              disabled={!latest || latest.id === r.id}
              onClick={() => latest && setDiffPair({ from: r.id, to: latest.id })}
            />
          </Tooltip>
          <Tooltip title={canApply ? '回滚到此版本' : '需要 acl:apply 权限'}>
            <Button
              size="small"
              type="text"
              icon={<RollbackOutlined />}
              disabled={!canApply || !r.content.trim()}
              onClick={() => {
                setAck(false);
                setDetail(r);
              }}
            />
          </Tooltip>
          {canWrite && (
            <Tooltip title="删除该版本记录（不影响 Headscale 当前策略）">
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                onClick={() =>
                  modal.confirm({
                    title: `删除版本 #${r.id} 的记录？`,
                    content: '只删除面板中的历史记录，不会改变 Headscale 上正在生效的策略。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => deleteMut.mutateAsync(r.id),
                  })
                }
              />
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <Alert
        type="info"
        showIcon
        icon={<HistoryOutlined />}
        message="策略版本由面板维护（Headscale 不提供版本能力）"
        description={
          <span className="text-[12.5px]">
            每次应用策略都会记录一个版本，包含内容、来源、操作人与推送结果。
            回滚不会删除历史，而是把旧内容作为<b>新版本</b>重新应用，保留完整轨迹。
          </span>
        }
      />

      <Table<AclVersion>
        rowKey="id"
        size="small"
        loading={listQuery.isLoading}
        columns={columns}
        dataSource={listQuery.data?.versions ?? []}
        pagination={{ pageSize: 15, showSizeChanger: false, size: 'small' }}
        scroll={{ x: 900 }}
      />

      {/* -------- 差异 -------- */}
      <Modal
        title={`版本对比：从 #${diffPair?.from ?? ''} 到 #${diffPair?.to ?? ''}`}
        open={!!diffPair}
        onCancel={() => setDiffPair(null)}
        width={820}
        footer={<Button onClick={() => setDiffPair(null)}>关闭</Button>}
      >
        {diffQuery.isLoading && <div className="py-8 text-center text-ink-400">加载中…</div>}
        {diffQuery.data && (
          <>
            <div className="mb-2 flex flex-wrap gap-3 text-[12px] text-ink-500">
              <span>
                <Tag color="red">−</Tag> 旧：#{diffQuery.data.from.id}
                {diffQuery.data.from.comment ? `（${diffQuery.data.from.comment}）` : ''}
              </span>
              <span>
                <Tag color="green">+</Tag> 新：#{diffQuery.data.to.id}
                {diffQuery.data.to.comment ? `（${diffQuery.data.to.comment}）` : ''}
              </span>
            </div>
            <div className="max-h-[440px] overflow-auto rounded-lg border border-ink-200 bg-white font-mono text-[12px]">
              {diffQuery.data.lines.map((l, i) => (
                <div
                  key={i}
                  className={`flex whitespace-pre-wrap px-2 py-[1px] ${
                    l.type === 'add' ? 'bg-emerald-50 text-emerald-800' : l.type === 'del' ? 'bg-rose-50 text-rose-800' : 'text-ink-600'
                  }`}
                >
                  <span className="mr-2 w-8 shrink-0 select-none text-right text-ink-300">{l.leftNo ?? ''}</span>
                  <span className="mr-2 w-8 shrink-0 select-none text-right text-ink-300">{l.rightNo ?? ''}</span>
                  <span className="mr-1.5 select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                  <span className="min-w-0 flex-1">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      {/* -------- 版本详情 / 回滚 -------- */}
      <Modal
        title={detail ? `版本 #${detail.id} 详情` : ''}
        open={!!detail}
        onCancel={() => {
          setDetail(null);
          setAck(false);
        }}
        width={780}
        footer={
          detail ? (
            <Space>
              <Button
                onClick={() => {
                  setDetail(null);
                  setAck(false);
                }}
              >
                关闭
              </Button>
              <Tooltip title={canApply ? '' : '需要 acl:apply 权限'}>
                <Button
                  type="primary"
                  danger
                  icon={<RollbackOutlined />}
                  disabled={!canApply || !ack}
                  loading={rollbackMut.isPending}
                  onClick={() => rollbackMut.mutate(detail.id)}
                >
                  回滚到此版本并应用
                </Button>
              </Tooltip>
            </Space>
          ) : null
        }
      >
        {detail && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2 text-[12.5px] text-ink-600">
              <Tag color={SOURCE_LABEL[detail.source]?.color}>{SOURCE_LABEL[detail.source]?.text}</Tag>
              <span>操作人：{detail.authorName || '系统'}</span>
              <span>时间：{new Date(detail.createdAt).toLocaleString('zh-CN')}</span>
              {detail.applied ? (
                <Tag color="green">已生效</Tag>
              ) : (
                <Tag color="red">未生效</Tag>
              )}
            </div>

            {detail.applyError && (
              <Alert type="error" showIcon message="推送到 Headscale 失败" description={detail.applyError} />
            )}

            {canApply && (
              <Alert
                type="warning"
                showIcon
                message="回滚会立刻改变全网连通性"
                description={
                  <div className="space-y-2">
                    <div className="text-[12.5px]">
                      回滚会把下面这份内容作为新版本推送到 Headscale 并<b>立即生效</b>。
                      若该版本是「全通」或「全禁」，会造成全网立刻开放或中断。
                    </div>
                    <Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)}>
                      <span className="text-[12.5px]">我已确认该版本内容，并了解回滚会立即生效</span>
                    </Checkbox>
                  </div>
                }
              />
            )}

            <div className="max-h-[320px] overflow-auto rounded-lg border border-ink-200 bg-white p-3 font-mono text-[12px] whitespace-pre-wrap">
              {detail.content || '（空）'}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
