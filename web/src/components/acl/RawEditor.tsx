/**
 * ACL 原始编辑（HuJSON）+ AI 辅助生成。
 *
 * 为什么保留原始编辑：可视化编辑器只覆盖 acls/hosts/groups/tagOwners，
 * ssh / nodeAttrs / autoApprovers 这些高级能力（以及 headscale 未来新增的字段）
 * 在结构化界面里没有位置。原始编辑是「逃生舱」，保证面板不会限制策略表达力。
 *
 * 校验分两层：
 *   1. 本地（/api/acl/validate）—— 秒回，人话报错，不消耗上游请求
 *   2. 上游（/api/acl/check-upstream）—— 权威，但仅本地通过后才调用
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Space, Tag, Tooltip, Typography, Modal, Input, App as AntApp, Spin, Divider } from 'antd';
import {
  ThunderboltOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  RobotOutlined,
  FormatPainterOutlined,
  SwapOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText } from '../../api/client';
import type { AclValidation, AclPolicy } from '../../api/types';

const { Text } = Typography;

interface Props {
  /** 当前编辑中的原文 */
  content: string;
  onContentChange: (v: string) => void;
  /** headscale 上正在生效的原文，用于对比 */
  appliedContent: string;
  canApply: boolean;
  onApply: () => void;
  applying: boolean;
  /**
   * 校验结果由父组件（AclPage）统一持有并下发。
   * 放在页面级是为了让头部与工具栏的「应用策略」按钮依据同一份结果禁用，
   * 同时避免重复请求。
   */
  validation: (AclValidation & { parseError?: string | null }) | undefined;
  validating: boolean;
}

export default function RawEditor({
  content,
  onContentChange,
  appliedContent,
  canApply,
  onApply,
  applying,
  validation,
  validating,
}: Props): React.ReactElement {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResult, setAiResult] = useState<{ content: string; explanation: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const dirty = content.trim() !== appliedContent.trim();

  // 本地校验结果由父组件下发（见 Props.validation 的说明）
  const errors = (validation?.issues ?? []).filter((i) => i.severity === 'error');
  const warnings = (validation?.issues ?? []).filter((i) => i.severity === 'warning');

  // ---------------- 上游校验（手动触发，只在校验通过时才有意义） ----------------
  const upstreamMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>('/api/acl/check-upstream', { content }),
    onSuccess: (r) => (r.ok ? message.success(r.message) : message.error(`上游拒绝：${r.message}`)),
    onError: (e) => message.error(errorText(e)),
  });

  // ---------------- AI 辅助生成 ----------------
  const aiMut = useMutation({
    mutationFn: (prompt: string) =>
      api.post<{ content: string; explanation: string }>('/api/acl/ai-draft', {
        prompt,
        currentContent: content,
      }),
    onSuccess: (r) => setAiResult(r),
    onError: (e) => message.error(errorText(e)),
  });

  const lines = useMemo(() => content.split('\n').length, [content]);
  const bytes = useMemo(() => new TextEncoder().encode(content).length, [content]);

  const formatJson = (): void => {
    try {
      const obj = JSON.parse(content) as AclPolicy;
      onContentChange(JSON.stringify(obj, null, 2));
      message.success('已格式化（注意：JSON 注释会被丢弃）');
    } catch {
      message.error('内容不是合法 JSON，无法格式化。HuJSON 注释请手动整理。');
    }
  };

  return (
    <div className="space-y-3">
      {/* -------- 工具栏 -------- */}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="small" icon={<FormatPainterOutlined />} onClick={formatJson}>
          格式化
        </Button>
        <Button size="small" icon={<SwapOutlined />} onClick={() => setShowDiff(true)} disabled={!dirty}>
          与生效版本对比
        </Button>
        <Button
          size="small"
          icon={<CheckCircleOutlined />}
          onClick={() => upstreamMut.mutate()}
          loading={upstreamMut.isPending}
          disabled={validation?.ok !== true}
        >
          上游校验
        </Button>
        <Button size="small" type="primary" ghost icon={<RobotOutlined />} onClick={() => setAiOpen(true)}>
          AI 辅助生成
        </Button>
        <div className="flex-1" />
        <span className="text-[11.5px] text-ink-400">
          {lines} 行 · {bytes} 字节
        </span>
        <Tooltip title={validation?.ok !== true ? '存在校验错误，请先修正' : dirty ? '推送到 Headscale 并立即生效' : '内容与生效版本一致'}>
          <Button
            type="primary"
            size="small"
            icon={<ThunderboltOutlined />}
            disabled={!canApply || !dirty || validation?.ok !== true}
            loading={applying}
            onClick={onApply}
          >
            应用策略
          </Button>
        </Tooltip>
      </div>

      {/* -------- 状态条 -------- */}
      {validating && (
        <div className="flex items-center gap-2 text-[12px] text-ink-400">
          <Spin size="small" /> 正在校验…
        </div>
      )}
      {validation && !validating && (
        <div className="flex flex-wrap items-center gap-2">
          {validation.ok ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              本地校验通过
            </Tag>
          ) : (
            <Tag icon={<CloseCircleOutlined />} color="error">
              {errors.length} 处错误
            </Tag>
          )}
          {warnings.length > 0 && (
            <Tag icon={<WarningOutlined />} color="warning">
              {warnings.length} 处提示
            </Tag>
          )}
          {validation.parseError && (
            <span className="text-[12px] text-rose-600">解析失败：{validation.parseError}</span>
          )}
          <span className="text-[11.5px] text-ink-400">
            规则 {validation.stats?.acls ?? 0} · SSH {validation.stats?.ssh ?? 0} · 主机{' '}
            {validation.stats?.hosts ?? 0} · 分组 {validation.stats?.groups ?? 0} · 标签{' '}
            {validation.stats?.tagOwners ?? 0}
          </span>
        </div>
      )}

      {/* -------- 问题列表 -------- */}
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="max-h-[190px] overflow-auto rounded-lg border border-ink-200/80 bg-white">
          {[...errors, ...warnings].map((issue, i) => (
            <div
              key={i}
              className={`flex gap-2 border-b border-ink-100 px-3 py-2 last:border-0 ${
                issue.severity === 'error' ? 'bg-rose-50/40' : 'bg-amber-50/30'
              }`}
            >
              <Tag
                color={issue.severity === 'error' ? 'error' : 'warning'}
                className="!mr-0 mt-0.5 shrink-0 !text-[10.5px]"
              >
                {issue.severity === 'error' ? '错误' : '提示'}
              </Tag>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Text code className="!text-[11.5px]">{issue.path}</Text>
                  <span className="text-[12.5px] text-ink-800">{issue.message}</span>
                </div>
                {issue.hint && <div className="mt-0.5 text-[11.5px] text-ink-500">建议：{issue.hint}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* -------- 编辑器 -------- */}
      <div className="relative">
        <Input.TextArea
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          autoSize={{ minRows: 18, maxRows: 40 }}
          spellCheck={false}
          className="!font-mono !text-[12.5px] !leading-relaxed"
          placeholder={'{\n  "acls": [\n    { "action": "accept", "proto": "tcp", "src": ["labadmin@"], "dst": ["*:22"] }\n  ]\n}'}
        />
      </div>

      {/* -------- AI 弹窗 -------- */}
      <Modal
        title={<span><RobotOutlined className="mr-1.5" />AI 辅助生成 ACL 规则</span>}
        open={aiOpen}
        onCancel={() => {
          setAiOpen(false);
          setAiResult(null);
          setAiPrompt('');
        }}
        width={720}
        footer={null}
      >
        <div className="space-y-3">
          <Alert
            type="info"
            showIcon
            message="用自然语言描述访问需求，生成候选规则"
            description={
              <span className="text-[12px]">
                生成结果<b>不会自动保存</b>，需要你确认后替换编辑器内容。提交前仍会走本地 + 上游校验。
              </span>
            }
          />
          <Input.TextArea
            rows={3}
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="例如：允许运维组 group:ops 从办公网 10.0.0.0/8 访问 tag:prod 设备的 22 和 443 端口；允许所有人经出口节点上网，仅 80/443"
          />
          <Space>
            <Button
              type="primary"
              icon={<RobotOutlined />}
              loading={aiMut.isPending}
              disabled={aiPrompt.trim().length < 4}
              onClick={() => aiMut.mutate(aiPrompt)}
            >
              生成
            </Button>
            <span className="text-[11.5px] text-ink-400">生成需要已配置模型服务（在「系统设置」中配置）</span>
          </Space>

          {aiResult && (
            <>
              <Divider className="!my-2" />
              <div className="text-[12.5px] text-ink-600">{aiResult.explanation}</div>
              <Input.TextArea
                value={aiResult.content}
                onChange={(e) => setAiResult({ ...aiResult, content: e.target.value })}
                autoSize={{ minRows: 8, maxRows: 20 }}
                className="!font-mono !text-[12px]"
              />
              <Space>
                <Button
                  type="primary"
                  onClick={() => {
                    onContentChange(aiResult.content);
                    setAiOpen(false);
                    setAiResult(null);
                    setAiPrompt('');
                    message.success('已填入编辑器，请复核后再应用');
                  }}
                >
                  填入编辑器（替换）
                </Button>
                <Button onClick={() => setAiResult(null)}>放弃</Button>
              </Space>
            </>
          )}
        </div>
      </Modal>

      {/* -------- 差异弹窗 -------- */}
      <Modal
        title="与正在生效的版本对比"
        open={showDiff}
        onCancel={() => setShowDiff(false)}
        width={780}
        footer={<Button onClick={() => setShowDiff(false)}>关闭</Button>}
      >
        <SimpleDiff left={appliedContent} right={content} />
        <div className="mt-2 text-[11.5px] text-ink-400">
          左：Headscale 当前生效　右：编辑中（未应用）
        </div>
      </Modal>
    </div>
  );
}

/** 轻量行级 diff（够用即可，不引入额外依赖） */
function SimpleDiff({ left, right }: { left: string; right: string }): React.ReactElement {
  const a = left.split('\n');
  const b = right.split('\n');
  const rows = useMemo(() => {
    // 用最长公共子序列做行级对齐
    const n = a.length;
    const m = b.length;
    // noUncheckedIndexedAccess 下二维数组取值都是 T|undefined，这里用显式取值函数收口，
    // 避免到处写非空断言（可读性更差且容易漏）。
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    const at = (arr: number[], k: number): number => arr[k] ?? 0;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const row = dp[i];
        const nextRow = dp[i + 1];
        if (!row || !nextRow) continue;
        row[j] = a[i] === b[j] ? at(nextRow, j + 1) + 1 : Math.max(at(nextRow, j), at(row, j + 1));
      }
    }
    const out: { type: 'same' | 'add' | 'del'; text: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ type: 'same', text: a[i] ?? '' });
        i++;
        j++;
      } else if (at(dp[i + 1] ?? [], j) >= at(dp[i] ?? [], j + 1)) {
        out.push({ type: 'del', text: a[i] ?? '' });
        i++;
      } else {
        out.push({ type: 'add', text: b[j] ?? '' });
        j++;
      }
    }
    while (i < n) {
      out.push({ type: 'del', text: a[i] ?? '' });
      i++;
    }
    while (j < m) {
      out.push({ type: 'add', text: b[j] ?? '' });
      j++;
    }
    return out;
  }, [left, right]);

  const changed = rows.some((r) => r.type !== 'same');

  return (
    <div className="max-h-[420px] overflow-auto rounded-lg border border-ink-200 bg-white font-mono text-[12px]">
      {!changed ? (
        <div className="p-4 text-center text-[12.5px] text-ink-400">两侧内容一致，无差异</div>
      ) : (
        rows.map((r, idx) => (
          <div
            key={idx}
            className={`whitespace-pre-wrap px-3 py-[1px] ${
              r.type === 'add' ? 'bg-emerald-50 text-emerald-800' : r.type === 'del' ? 'bg-rose-50 text-rose-800' : 'text-ink-600'
            }`}
          >
            <span className="mr-2 select-none text-ink-300">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
            {r.text || ' '}
          </div>
        ))
      )}
    </div>
  );
}
