/**
 * ACL 访问矩阵 —— 把规则集可视化成「源 × 目的」连通性网格。
 *
 * 为什么要做：ACL 规则是「一堆 accept 列表」，人脑很难从文本判断
 * 「谁能访问谁」的整体图景。矩阵把每条规则对每个设备对求值一次，
 * 用颜色直接呈现结果，让「意外开放」一眼可见——这是安全审计的核心视图。
 *
 * 实现取舍：求值走服务端（/api/acl/check），因为要复用 canAccess 语义，
 * 且需要标签/路由/出口节点的解析。为控制请求量，前端并发上限 6，
 * 结果按 (fromId,toId) 缓存，切换端口/协议时才重算。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Empty, Select, Segmented, Tag, Tooltip, Typography, Spin, Space, Switch, Button } from 'antd';
import { SafetyOutlined, WarningOutlined, ReloadOutlined } from '@ant-design/icons';

import { api } from '../../api/client';
import type { AclContext } from '../../api/types';

const { Text, Paragraph } = Typography;

type Cell = 'yes' | 'no' | 'self' | 'loading' | 'unknown';

interface Props {
  ctx: AclContext | null;
  draftContent: string;
}

const COMMON_PORTS = [
  { value: 22, label: '22 (SSH)' },
  { value: 80, label: '80 (HTTP)' },
  { value: 443, label: '443 (HTTPS)' },
  { value: 3306, label: '3306 (MySQL)' },
  { value: 5432, label: '5432 (PostgreSQL)' },
  { value: 6379, label: '6379 (Redis)' },
  { value: 8080, label: '8080' },
];

export default function AccessMatrix({ ctx, draftContent }: Props): React.ReactElement {
  const [port, setPort] = useState(22);
  const [proto, setProto] = useState('tcp');
  const [useDraft, setUseDraft] = useState(true);
  const [onlyTagged, setOnlyTagged] = useState(false);
  const [cells, setCells] = useState<Record<string, Cell>>({});
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(0);
  const abortRef = useRef(0);

  const nodes = useMemo(() => {
    const all = ctx?.nodes ?? [];
    return onlyTagged ? all.filter((n) => n.tags.length > 0) : all;
  }, [ctx, onlyTagged]);

  const total = nodes.length * nodes.length;

  // ---------------- 求值 ----------------
  useEffect(() => {
    if (!nodes.length) return;
    const token = ++abortRef.current;
    setLoading(true);
    setDone(0);
    setCells({});

    const pairs: [number, number][] = [];
    for (const a of nodes) for (const b of nodes) pairs.push([a.id, b.id]);

    let idx = 0;
    let finished = 0;
    const CONCURRENCY = 6;

    const runOne = async (fromId: number, toId: number): Promise<void> => {
      if (token !== abortRef.current) return;
      const key = `${fromId}:${toId}`;
      if (fromId === toId) {
        setCells((c) => ({ ...c, [key]: 'self' }));
        finished++;
        setDone(finished);
        return;
      }
      try {
        const r = await api.post<{ allowed: boolean; error?: string | null }>('/api/acl/check', {
          from: { nodeId: fromId },
          to: { nodeId: toId },
          port,
          proto,
          ...(useDraft ? { draftContent } : {}),
        });
        if (token !== abortRef.current) return;
        setCells((c) => ({ ...c, [key]: r.error ? 'unknown' : r.allowed ? 'yes' : 'no' }));
      } catch {
        if (token !== abortRef.current) return;
        setCells((c) => ({ ...c, [key]: 'unknown' }));
      }
      finished++;
      setDone(finished);
    };

    const worker = async (): Promise<void> => {
      while (idx < pairs.length) {
        if (token !== abortRef.current) return;
        const cur = pairs[idx];
        idx += 1;
        if (!cur) continue;
        await runOne(cur[0], cur[1]);
      }
    };

    void (async () => {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, () => worker()));
      if (token === abortRef.current) setLoading(false);
    })();

    return () => {
      abortRef.current++;
    };
  }, [nodes, port, proto, useDraft, draftContent]);

  const stats = useMemo(() => {
    let yes = 0;
    let no = 0;
    let unknown = 0;
    for (const v of Object.values(cells)) {
      if (v === 'yes') yes++;
      else if (v === 'no') no++;
      else if (v === 'unknown') unknown++;
    }
    return { yes, no, unknown };
  }, [cells]);

  if (!ctx?.nodes.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无设备，无法生成访问矩阵" />;
  }

  const cellColor = (v: Cell): string => {
    switch (v) {
      case 'yes':
        return 'bg-emerald-500/85';
      case 'no':
        return 'bg-ink-100';
      case 'self':
        return 'bg-brand-200/70';
      case 'unknown':
        return 'bg-amber-300/80';
      default:
        return 'bg-ink-50 animate-pulse';
    }
  };

  return (
    <div className="space-y-3">
      <Alert
        type="info"
        showIcon
        icon={<SafetyOutlined />}
        message="源 × 目的 连通性矩阵"
        description={
          <span className="text-[12.5px]">
            每个格子表示「行（源）能否访问 列（目的）的指定端口」。这是审计「意外开放」最直观的视图——
            如果某行出现了大片绿色而你并不希望该设备被广泛访问，说明策略有遗漏。
            对角线是设备自身（不参与判定）。
          </span>
        }
      />

      {/* -------- 控制条 -------- */}
      <div className="hsa-card flex flex-wrap items-center gap-3 p-3">
        <Space size={6}>
          <span className="text-[12px] text-ink-500">端口</span>
          <Select
            size="small"
            className="!w-[136px]"
            value={port}
            onChange={setPort}
            options={COMMON_PORTS}
            showSearch
          />
        </Space>
        <Segmented
          size="small"
          value={proto}
          onChange={(v) => setProto(String(v))}
          options={(ctx.protocols ?? ['tcp', 'udp']).slice(0, 4).map((p) => ({ value: p, label: p }))}
        />
        <Segmented
          size="small"
          value={useDraft ? 'draft' : 'applied'}
          onChange={(v) => setUseDraft(v === 'draft')}
          options={[
            { value: 'draft', label: '草稿策略' },
            { value: 'applied', label: '生效策略' },
          ]}
        />
        <Space size={6}>
          <Switch size="small" checked={onlyTagged} onChange={setOnlyTagged} />
          <span className="text-[12px] text-ink-500">只看已打标签设备</span>
        </Space>
        <div className="flex-1" />
        {loading && (
          <span className="flex items-center gap-1.5 text-[12px] text-ink-400">
            <Spin size="small" /> 求值中 {done}/{total}
          </span>
        )}
        <Space size={8} className="text-[11.5px] text-ink-500">
          <span className="flex items-center gap-1">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500/85" /> 允许 {stats.yes}
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block h-2.5 w-2.5 rounded-sm bg-ink-100 ring-1 ring-inset ring-ink-200" /> 拒绝 {stats.no}
          </span>
          {stats.unknown > 0 && (
            <span className="flex items-center gap-1">
              <i className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-300/80" /> 无法判定 {stats.unknown}
            </span>
          )}
        </Space>
      </div>

      {/* -------- 矩阵 -------- */}
      <div className="hsa-card overflow-auto p-3">
        <table className="border-separate border-spacing-[2px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 bg-white p-1" />
              {nodes.map((n) => (
                <th key={n.id} className="p-0">
                  <Tooltip title={`${n.name}${n.userName ? ` · ${n.userName}` : ''}${n.tags.length ? ` · ${n.tags.join(', ')}` : ''}`}>
                    <div className="w-[22px] origin-bottom-left translate-x-[10px] translate-y-[-4px] rotate-[-55deg] whitespace-nowrap text-left text-[11px] text-ink-500">
                      {n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name}
                    </div>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {nodes.map((row) => (
              <tr key={row.id}>
                <th className="sticky left-0 z-10 max-w-[190px] truncate bg-white pr-2 text-right text-[11.5px] font-normal text-ink-600">
                  <Tooltip title={`${row.name}${row.userName ? ` · ${row.userName}` : ''}${row.tags.length ? ` · ${row.tags.join(', ')}` : ''}`}>
                    <span>{row.name}</span>
                  </Tooltip>
                  {row.tags.length > 0 && (
                    <Tag color="purple" className="!ml-1 !mr-0 !px-1 !text-[9.5px] !leading-4">
                      tag
                    </Tag>
                  )}
                </th>
                {nodes.map((col) => {
                  const v = cells[`${row.id}:${col.id}`] ?? 'loading';
                  return (
                    <td key={col.id} className="p-0">
                      <Tooltip
                        title={
                          v === 'self'
                            ? `${row.name} → 自身（不判定）`
                            : v === 'loading'
                              ? '计算中…'
                              : v === 'unknown'
                                ? `${row.name} → ${col.name}：无法判定（节点可能不存在）`
                                : `${row.name} → ${col.name}:${port}/${proto} —— ${v === 'yes' ? '允许' : '拒绝'}`
                        }
                      >
                        <div
                          className={`h-[22px] w-[22px] rounded-sm transition-colors duration-150 ${cellColor(v)}`}
                        />
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* -------- 审计提示 -------- */}
      {!loading && stats.yes > 0 && nodes.length > 1 && (
        <Alert
          type={stats.yes > nodes.length * (nodes.length - 1) * 0.5 ? 'warning' : 'success'}
          showIcon
          icon={stats.yes > nodes.length * (nodes.length - 1) * 0.5 ? <WarningOutlined /> : <SafetyOutlined />}
          message={
            stats.yes > nodes.length * (nodes.length - 1) * 0.5
              ? '连通性偏开放，建议复核'
              : '连通性收敛良好'
          }
          description={
            <span className="text-[12.5px]">
              在 {port}/{proto} 上共有 <b>{stats.yes}</b> 个「允许」的设备对（占
              {Math.round((stats.yes / Math.max(1, nodes.length * (nodes.length - 1))) * 100)}%）。
              矩阵中绿色格子越多，横向移动（lateral movement）风险越大。
            </span>
          }
        />
      )}

      <Paragraph className="!mb-0 text-[12px] text-ink-400">
        <ReloadOutlined className="mr-1" />
        矩阵按需实时求值（共 {total} 次判定），切换端口/协议/策略来源会自动重算。
        判定依据与「访问检查」完全一致。
      </Paragraph>
    </div>
  );
}
