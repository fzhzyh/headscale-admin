/**
 * ACL 管理页。
 *
 * 三个标签页对应三种编辑心智：
 *   - 可视化编辑：结构化改规则，适合日常增删
 *   - 原始编辑：HuJSON 逃生舱，覆盖 ssh / nodeAttrs / autoApprovers 等高级能力
 *   - 版本历史：面板自建，支持对比与回滚
 * 外加独立的「访问检查」与「访问矩阵」两个分析视图。
 *
 * 关键状态管理：draft 与 applied 分离。用户改的是 draft，只有点「应用」才推送。
 * 页面顶部常驻显示「生效版本 vs 草稿」的差异与漂移状态，避免误以为已生效。
 */
import { useEffect, useMemo, useState } from 'react';
import { Tabs, Button, Alert, Space, Tag, Typography, App as AntApp, Modal, Checkbox, Skeleton, Tooltip } from 'antd';
import {
  ReloadOutlined,
  CloudUploadOutlined,
  WarningOutlined,
  SafetyCertificateOutlined,
  ApartmentOutlined,
  CodeOutlined,
  TableOutlined,
  HistoryOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText, ApiError } from '../api/client';
import type { AclPolicyResponse, AclContext, AclPolicy, AclValidation } from '../api/types';
import { PageHeader, StatCard } from '../components/ui';
import { useAuth } from '../store/auth';
import VisualEditor from '../components/acl/VisualEditor';
import RawEditor from '../components/acl/RawEditor';
import VersionHistory from '../components/acl/VersionHistory';
import AccessChecker from '../components/acl/AccessChecker';
import AccessMatrix from '../components/acl/AccessMatrix';

const { Text, Paragraph } = Typography;

/** 把策略对象序列化成与 headscale 一致的 JSON 文本 */
function serialize(p: AclPolicy): string {
  return JSON.stringify(p, null, 2);
}

export default function AclPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();

  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState('visual');

  const policyQuery = useQuery({
    queryKey: ['acl-policy'],
    queryFn: () => api.get<AclPolicyResponse>('/api/acl/policy'),
  });

  const ctxQuery = useQuery({
    queryKey: ['acl-context'],
    queryFn: () => api.get<AclContext>('/api/acl/context'),
  });

  // 服务端内容变化时同步到草稿（但不要把用户正在编辑的内容冲掉）
  const applied = policyQuery.data?.content ?? '';
  useEffect(() => {
    if (policyQuery.data && draft === '') {
      setDraft(applied);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyQuery.data]);

  const dirty = draft.trim() !== applied.trim();

  /** 草稿解析成对象供可视化编辑器使用；解析失败时禁用可视化编辑 */
  const draftParsed = useMemo((): { ok: true; policy: AclPolicy } | { ok: false; error: string } => {
    if (!draft.trim()) return { ok: false, error: '内容为空' };
    try {
      return { ok: true, policy: JSON.parse(draft) as AclPolicy };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }, [draft]);

  /**
   * 校验查询提升到页面级（而不是放在 RawEditor 里）：
   *   - 页面头部的「应用策略」按钮与编辑器工具栏的按钮必须**依据同一份校验结果**禁用，
   *     否则会出现「头部按钮可点、点下去必然失败」的糟糕交互
   *   - 避免两处各发一次请求
   */
  const [debouncedDraft, setDebouncedDraft] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDraft(draft), 500);
    return () => clearTimeout(t);
  }, [draft]);

  const validateQuery = useQuery<AclValidation & { parseError?: string | null }>({
    queryKey: ['acl-validate', debouncedDraft],
    queryFn: () => api.post<AclValidation & { parseError?: string | null }>('/api/acl/validate', { content: debouncedDraft }),
    enabled: debouncedDraft.trim().length > 0,
    staleTime: 30_000,
  });

  /** 草稿是否可安全应用：能解析 + 本地校验通过 */
  const draftAppliable = draftParsed.ok && validateQuery.data?.ok === true;
  /** 校验结果是否已追上当前草稿（防抖期间不能误判为「通过」） */
  const validationFresh = debouncedDraft === draft;

  // ---------------- 应用策略 ----------------
  const applyMut = useMutation({
    mutationFn: (vars: { acknowledgedImpact: boolean }) =>
      api.put<{ ok: boolean; versionId: number; mode: string }>('/api/acl/policy', {
        content: draft,
        source: tab === 'visual' ? 'visual-editor' : 'manual',
        acknowledgedImpact: vars.acknowledgedImpact,
        comment: null,
      }),
    onSuccess: async (r) => {
      message.success(`策略已推送到 Headscale 并生效（版本 #${r.versionId}，模式：${r.mode}）`);
      await qc.invalidateQueries({ queryKey: ['acl-policy'] });
      await qc.invalidateQueries({ queryKey: ['acl-versions'] });
      await qc.invalidateQueries({ queryKey: ['acl-context'] });
      await qc.invalidateQueries({ queryKey: ['nodes'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'NEED_ACK') {
        modal.confirm({
          title: '高危策略变更确认',
          width: 560,
          icon: <WarningOutlined className="text-amber-500" />,
          content: (
            <div className="space-y-2">
              <Paragraph className="!mb-0 text-[13px]">{e.message}</Paragraph>
              <Paragraph className="!mb-0 text-[12px] text-ink-500">
                这类变更会让整张网络的连通性立即发生全局变化，无法平滑过渡。
              </Paragraph>
            </div>
          ),
          okText: '我已确认，立即应用',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => applyMut.mutateAsync({ acknowledgedImpact: true }),
        });
        return;
      }
      if (e instanceof ApiError && e.code === 'PARSE_FAILED') {
        modal.error({
          title: '策略无法解析',
          width: 560,
          content: <div className="text-[13px]">{e.message}</div>,
        });
        return;
      }
      if (e instanceof ApiError && e.code === 'VALIDATION_FAILED') {
        const body = e.body as { issues?: { path: string; message: string }[] } | undefined;
        modal.error({
          title: '策略未通过校验',
          width: 620,
          content: (
            <div className="space-y-1">
              {(body?.issues ?? []).slice(0, 12).map((i, idx) => (
                <div key={idx} className="text-[12.5px]">
                  <Text code>{i.path}</Text> {i.message}
                </div>
              ))}
            </div>
          ),
        });
        return;
      }
      message.error(errorText(e));
    },
  });

  const confirmApply = (): void => {
    modal.confirm({
      title: '应用 ACL 策略',
      width: 560,
      content: (
        <div className="space-y-2 text-[13px]">
          <Paragraph className="!mb-0">
            将把当前编辑内容推送到 Headscale 并<b>立即对所有设备生效</b>。
          </Paragraph>
          <Paragraph className="!mb-0 text-[12px] text-ink-500">
            应用前会自动做本地校验与上游校验；失败则不会推送。
          </Paragraph>
        </div>
      ),
      okText: '推送并生效',
      cancelText: '取消',
      onOk: () => applyMut.mutateAsync({ acknowledgedImpact: false }),
    });
  };

  const interp = policyQuery.data?.interpretation;
  const validation = policyQuery.data?.validation;
  const drift = policyQuery.data?.drift;
  const canApply = policyQuery.data?.canApply ?? false;
  const canWrite = can('acl:write');

  if (policyQuery.isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader title="ACL 管理" description="加载中…" />
        <Skeleton active paragraph={{ rows: 8 }} />
      </div>
    );
  }

  if (policyQuery.isError) {
    return (
      <div className="space-y-4">
        <PageHeader title="ACL 管理" />
        <Alert
          type="error"
          showIcon
          message="无法读取策略"
          description={errorText(policyQuery.error)}
          action={
            <Button size="small" onClick={() => policyQuery.refetch()}>
              重试
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="ACL 管理"
        description="访问控制策略的可视化编辑、原始编辑、版本回滚与访问验证"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={async () => {
                await policyQuery.refetch();
                setDraft('');
                await ctxQuery.refetch();
              }}
            >
              重新读取
            </Button>
            <Tooltip
              title={
                !canApply
                  ? '需要 acl:apply 权限'
                  : !dirty
                    ? '内容与生效版本一致'
                    : !draftParsed.ok
                      ? '内容不是合法 JSON，请先在「原始编辑」中修正'
                      : !validationFresh
                        ? '正在校验…'
                        : validateQuery.data?.ok === false
                          ? '存在校验错误，请先修正'
                          : ''
              }
            >
              <Button
                type="primary"
                icon={<CloudUploadOutlined />}
                disabled={!canApply || !dirty || !draftAppliable}
                loading={applyMut.isPending}
                onClick={confirmApply}
              >
                应用策略{dirty ? '（有改动）' : ''}
              </Button>
            </Tooltip>
          </Space>
        }
      />

      {/* -------- 状态概览 -------- */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="当前策略模式"
          value={
            interp?.mode === 'rules' ? '按规则' : interp?.mode === 'allow-all' ? '全通' : '全禁'
          }
          tone={interp?.mode === 'rules' ? 'ok' : interp?.mode === 'allow-all' ? 'warn' : 'danger'}
          hint={interp?.mode === 'rules' ? '未命中即拒绝' : interp?.mode === 'allow-all' ? '所有人都能访问所有设备' : '所有设备互不可达'}
        />
        <StatCard title="ACL 规则" value={validation?.stats.acls ?? 0} suffix="条" tone="brand" />
        <StatCard
          title="SSH 规则"
          value={validation?.stats.ssh ?? 0}
          suffix="条"
          tone="brand"
          hint={`主机 ${validation?.stats.hosts ?? 0} · 分组 ${validation?.stats.groups ?? 0} · 标签 ${validation?.stats.tagOwners ?? 0}`}
        />
        <StatCard
          title="草稿状态"
          value={!dirty ? '已同步' : validateQuery.data?.ok === false ? '有错误' : '未应用'}
          tone={!dirty ? 'ok' : validateQuery.data?.ok === false ? 'danger' : 'warn'}
          hint={
            !dirty
              ? '与 Headscale 生效版本一致'
              : validateQuery.data?.ok === false
                ? '草稿存在校验错误，无法应用'
                : '存在未推送的改动'
          }
        />
      </div>

      {/* -------- 高危模式警示 -------- */}
      {interp?.highImpact && (
        <Alert
          type={interp.mode === 'allow-all' ? 'warning' : 'error'}
          showIcon
          icon={<WarningOutlined />}
          message={interp.explanation}
          description={
            <span className="text-[12.5px]">
              {interp.mode === 'allow-all'
                ? '「全通」意味着任意设备可访问任意设备的所有端口，等于没有访问控制。除非是临时排障，否则不建议长期保持。'
                : '「全禁」意味着所有设备之间完全无法互访，通常会造成业务中断。'}
            </span>
          }
        />
      )}

      {/* -------- 带外变更警示 -------- */}
      {drift?.drifted && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="检测到带外变更：Headscale 上的策略被面板之外的方式修改过"
          description={
            <div className="space-y-1 text-[12.5px]">
              <div>{drift.explanation}</div>
              <div className="text-ink-500">
                这通常意味着有人直接调用了 Headscale API 或修改了数据库/策略文件。
                请先确认变更来源，再决定是否用面板内容覆盖。
              </div>
            </div>
          }
          action={
            <Button
              size="small"
              onClick={() => {
                setDraft(applied);
                message.success('已把 Headscale 当前策略载入编辑器');
              }}
            >
              用上游内容覆盖草稿
            </Button>
          }
        />
      )}

      {/* -------- 编辑区 -------- */}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'visual',
            label: (
              <span>
                <ApartmentOutlined /> 可视化编辑
              </span>
            ),
            children: draftParsed.ok ? (
              <VisualEditor
                policy={draftParsed.policy}
                ctx={ctxQuery.data ?? null}
                disabled={!canWrite}
                onChange={(next) => setDraft(serialize(next))}
              />
            ) : (
              <Alert
                type="error"
                showIcon
                message="无法进入可视化编辑"
                description={
                  <div className="space-y-2">
                    <div className="text-[12.5px]">当前内容不是合法 JSON（HuJSON 注释会导致此情况）：{draftParsed.error}</div>
                    <Button size="small" onClick={() => setTab('raw')}>
                      切到原始编辑修正
                    </Button>
                  </div>
                }
              />
            ),
          },
          {
            key: 'raw',
            label: (
              <span>
                <CodeOutlined /> 原始编辑
              </span>
            ),
            children: (
              <RawEditor
                content={draft}
                onContentChange={setDraft}
                appliedContent={applied}
                canApply={canApply && draftAppliable}
                onApply={confirmApply}
                applying={applyMut.isPending}
                validation={validateQuery.data}
                validating={validateQuery.isFetching || !validationFresh}
              />
            ),
          },
          {
            key: 'matrix',
            label: (
              <span>
                <TableOutlined /> 访问矩阵
              </span>
            ),
            children: <AccessMatrix ctx={ctxQuery.data ?? null} draftContent={draft} />,
          },
          {
            key: 'check',
            label: (
              <span>
                <QuestionCircleOutlined /> 访问检查
              </span>
            ),
            children: <AccessChecker ctx={ctxQuery.data ?? null} draftContent={draft} />,
          },
          {
            key: 'versions',
            label: (
              <span>
                <HistoryOutlined /> 版本历史
              </span>
            ),
            children: (
              <VersionHistory
                canApply={canApply}
                canWrite={canWrite}
                onRestored={() => {
                  setDraft('');
                  void policyQuery.refetch();
                }}
              />
            ),
          },
        ]}
      />

      <Paragraph className="!mb-0 text-[12px] text-ink-400">
        <SafetyCertificateOutlined className="mr-1" />
        提示：ACL 策略由面板与 Headscale 共同持有，但<b>只有 Headscale 上的内容才真正生效</b>。
        面板的版本历史仅用于追溯与回滚。所有应用操作都会记入审计日志。
      </Paragraph>
    </div>
  );
}
