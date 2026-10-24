/**
 * 访问检查器 —— 面板自研能力（headscale 不提供「A 能否访问 B」的查询）。
 *
 * 求值完全在服务端做（复用 acl/evaluator.ts），前端只负责表达查询与展示轨迹。
 * 关键：支持对**草稿策略**求值，这样用户可以在应用前就验证规则是否符合预期，
 * 避免「先应用、再发现断了」的事故。
 */
import { useState } from 'react';
import { Button, Select, Space, InputNumber, Tag, Alert, Typography, Segmented, Empty, Spin } from 'antd';
import { SwapOutlined, QuestionCircleOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useMutation } from '@tanstack/react-query';

import { api, errorText } from '../../api/client';
import type { AclContext, AclCheckResult, AclCheckSide } from '../../api/types';

const { Text, Paragraph } = Typography;

type SideKind = 'node' | 'cidr' | 'user' | 'tag' | 'internet';

interface SideState {
  kind: SideKind;
  value: string;
}

function toSide(s: SideState): AclCheckSide | null {
  switch (s.kind) {
    case 'node':
      return s.value ? { nodeId: Number(s.value) } : null;
    case 'cidr':
      return s.value ? { cidr: s.value } : null;
    case 'user':
      return s.value ? { user: s.value } : null;
    case 'tag':
      return s.value ? { tag: s.value } : null;
    case 'internet':
      return { internet: true };
  }
}

interface Props {
  ctx: AclContext | null;
  /** 草稿策略原文；传了就用草稿求值，不传用 headscale 当前生效策略 */
  draftContent: string;
}

export default function AccessChecker({ ctx, draftContent }: Props): React.ReactElement {
  const [from, setFrom] = useState<SideState>({ kind: 'node', value: '' });
  const [to, setTo] = useState<SideState>({ kind: 'node', value: '' });
  const [port, setPort] = useState<number | null>(443);
  const [proto, setProto] = useState('tcp');
  const [useDraft, setUseDraft] = useState(true);

  const checkMut = useMutation({
    mutationFn: () => {
      const f = toSide(from);
      const t = toSide(to);
      if (!f || !t) throw new Error('请先选择源与目的');
      return api.post<AclCheckResult>('/api/acl/check', {
        from: f,
        to: t,
        ...(port !== null ? { port } : {}),
        proto,
        ...(useDraft ? { draftContent } : {}),
      });
    },
  });

  const nodeOptions = (ctx?.nodes ?? []).map((n) => ({
    value: String(n.id),
    label: `${n.name}${n.userName ? ` · ${n.userName}` : ''}${n.ips[0] ? ` · ${n.ips[0]}` : ''}`,
  }));

  const renderSide = (state: SideState, setState: (s: SideState) => void, label: string): React.ReactElement => (
    // id 用作 e2e 测试锚点：antd Select 的下拉是脱离文档流的浮层，按文本定位不稳定
    <div id={label.startsWith('源') ? 'acl-check-from' : 'acl-check-to'} className="min-w-[260px] flex-1">
      <div className="mb-1 text-[11.5px] text-ink-500">{label}</div>
      <Space.Compact className="w-full">
        <Select
          size="small"
          className="!w-[92px]"
          value={state.kind}
          onChange={(k: SideKind) => setState({ kind: k, value: '' })}
          options={[
            { value: 'node', label: '设备' },
            { value: 'cidr', label: 'CIDR' },
            { value: 'user', label: '用户' },
            { value: 'tag', label: '标签' },
            { value: 'internet', label: '互联网' },
          ]}
        />
        {state.kind === 'node' ? (
          <Select
            size="small"
            className="flex-1"
            value={state.value || undefined}
            options={nodeOptions}
            onChange={(v: string) => setState({ ...state, value: v })}
            placeholder="选择设备"
            showSearch
            optionFilterProp="label"
          />
        ) : state.kind === 'internet' ? (
          <div className="flex flex-1 items-center rounded-r-md border border-l-0 border-ink-200 bg-ink-50 px-2 text-[12px] text-ink-500">
            出口节点（autogroup:internet）
          </div>
        ) : state.kind === 'tag' ? (
          <Select
            size="small"
            className="flex-1"
            value={state.value || undefined}
            options={(ctx?.tags ?? []).map((t) => ({ value: t, label: t }))}
            onChange={(v: string) => setState({ ...state, value: v })}
            placeholder="选择标签"
            showSearch
          />
        ) : state.kind === 'user' ? (
          <Select
            size="small"
            className="flex-1"
            value={state.value || undefined}
            options={(ctx?.users ?? []).map((u) => ({ value: u.name, label: u.token }))}
            onChange={(v: string) => setState({ ...state, value: v })}
            placeholder="选择用户"
            showSearch
          />
        ) : (
          <input
            className="flex-1 rounded-r-md border border-l-0 border-ink-200 px-2 py-1 text-[12.5px] outline-none focus:border-brand-400"
            value={state.value}
            onChange={(e) => setState({ ...state, value: e.target.value })}
            placeholder="例如 100.64.0.0/24"
          />
        )}
      </Space.Compact>
    </div>
  );

  const r = checkMut.data;

  return (
    <div className="space-y-3">
      <Alert
        type="info"
        showIcon
        icon={<QuestionCircleOutlined />}
        message="验证「源 → 目的」是否被允许访问"
        description={
          <span className="text-[12.5px]">
            Headscale 只能校验策略语法，无法回答「某台设备能否访问另一台」。这里由面板的求值引擎按
            <Text code>canAccess</Text> 语义计算，并给出逐步判定轨迹便于排障。
          </span>
        }
      />

      <div className="hsa-card p-4">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Segmented
            size="small"
            value={useDraft ? 'draft' : 'applied'}
            onChange={(v) => setUseDraft(v === 'draft')}
            options={[
              { value: 'draft', label: '用编辑中的草稿策略' },
              { value: 'applied', label: '用 Headscale 当前生效策略' },
            ]}
          />
          <span className="text-[11.5px] text-ink-400">
            {useDraft ? '可在应用前验证改动效果' : '以线上真实状态为准'}
          </span>
        </div>

        <div className="flex flex-wrap items-start gap-3">
          {renderSide(from, setFrom, '源（谁发起）')}
          <SwapOutlined className="mt-6 text-ink-300" />
          {renderSide(to, setTo, '目的（访问谁）')}
          <div className="w-[150px]">
            <div className="mb-1 text-[11.5px] text-ink-500">协议 / 端口</div>
            <Space.Compact className="w-full">
              <Select
                size="small"
                className="!w-[72px]"
                value={proto}
                onChange={setProto}
                options={(ctx?.protocols ?? ['tcp', 'udp', 'icmp']).map((p) => ({ value: p, label: p }))}
              />
              <InputNumber
                size="small"
                className="!w-[72px]"
                min={0}
                max={65535}
                value={port}
                onChange={(v) => setPort(v ?? null)}
                placeholder="端口"
              />
            </Space.Compact>
          </div>
          <Button
            className="mt-5"
            type="primary"
            onClick={() => checkMut.mutate()}
            loading={checkMut.isPending}
            disabled={!from.value && from.kind !== 'internet' || (!to.value && to.kind !== 'internet')}
          >
            检查
          </Button>
        </div>
      </div>

      {checkMut.isPending && (
        <div className="flex items-center gap-2 text-[12.5px] text-ink-400">
          <Spin size="small" /> 正在求值…
        </div>
      )}

      {checkMut.isError && <Alert type="error" showIcon message={errorText(checkMut.error)} />}

      {r && !checkMut.isPending && (
        <>
          {r.error ? (
            <Alert type="warning" showIcon message="无法完成检查" description={r.error} />
          ) : (
            <Alert
              type={r.allowed ? 'success' : 'error'}
              showIcon
              icon={r.allowed ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
              message={
                <Space>
                  <span className="font-semibold">{r.allowed ? '允许访问' : '拒绝访问'}</span>
                  <Tag color={r.allowed ? 'green' : 'red'} className="!mr-0">
                    {r.reason}
                  </Tag>
                  {r.source && <span className="text-[11.5px] text-ink-400">依据：{r.source}</span>}
                </Space>
              }
              description={<span className="text-[12.5px]">{r.explanation}</span>}
            />
          )}

          {r.matched.length > 0 && (
            <div className="hsa-card p-4">
              <div className="mb-2 text-[13px] font-semibold text-ink-800">命中的规则</div>
              <div className="space-y-1.5">
                {r.matched.map((m, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Tag color="green" className="!mr-0">
                      {m.side === 'ssh' ? 'SSH' : 'ACL'} #{m.index + 1}
                    </Tag>
                    <Text code className="!text-[12px]">{m.rule}</Text>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="hsa-card p-4">
            <div className="mb-2 text-[13px] font-semibold text-ink-800">判定轨迹</div>
            <div className="space-y-1">
              {r.trace.map((t, i) => (
                <div key={i} className="flex gap-2 text-[12.5px]">
                  <span className="shrink-0 select-none text-ink-300">{String(i + 1).padStart(2, '0')}</span>
                  <span className="text-ink-700">{t}</span>
                </div>
              ))}
            </div>
          </div>

          {!r.allowed && !r.error && (
            <Paragraph className="!mb-0 text-[12px] text-ink-500">
              <Text strong>排查提示：</Text>
              headscale 的策略是「默认拒绝」——未命中任何 accept 规则即拒绝，没有 deny 规则可用。
              若期望放行，请检查：① 源与目的是否写成规则里的同一个别名（注意打了标签的设备会脱离用户归属）；
              ② 目的端口是否在规则端口范围内；③ 协议是否匹配。
            </Paragraph>
          )}
        </>
      )}

      {!r && !checkMut.isPending && !checkMut.isError && (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择源与目的后点击「检查」" />
      )}
    </div>
  );
}
