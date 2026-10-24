/**
 * ACL 可视化规则编辑器。
 *
 * 设计取舍：不全盘接管策略，只编辑「可安全结构性修改」的部分：
 *   - acls 规则（增删改）
 *   - hosts / groups / tagOwners
 * 其余字段（ssh / nodeAttrs / autoApprovers / 未知的未来字段）**原样保留**，
 * 绝不因为界面上没有对应控件就在保存时丢掉——那会造成静默的策略破坏。
 *
 * 另一个关键点：`acls` 键「不存在」与「空数组」语义相反（全通 vs 全禁）。
 * 本编辑器把这两种状态显式区分并在 UI 上警示，不做归一化。
 */
import { useMemo, useState } from 'react';
import { Button, Input, Select, Tag, Tooltip, Alert, Space, Empty, Popconfirm, Divider, Typography } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  ArrowRightOutlined,
  WarningOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';

import type { AclPolicy, AclRule, AclContext } from '../../api/types';

const { Text } = Typography;

/** dst 必须带端口；这里把「别名」与「端口」拆开编辑，保存时再拼回去 */
interface DstPair {
  dest: string;
  port: string;
}

function splitDest(d: string): DstPair {
  const i = d.lastIndexOf(':');
  if (i <= 0) return { dest: d, port: '*' };
  return { dest: d.slice(0, i), port: d.slice(i + 1) };
}

function joinDest(p: DstPair): string {
  return `${p.dest}:${p.port || '*'}`;
}

interface Props {
  policy: AclPolicy;
  ctx: AclContext | null;
  onChange: (next: AclPolicy) => void;
  disabled?: boolean;
}

export default function VisualEditor({ policy, ctx, onChange, disabled }: Props): React.ReactElement {
  // acls 键是否「存在」直接决定全局语义，UI 必须区分展示
  const aclsKeyExists = Object.prototype.hasOwnProperty.call(policy, 'acls');
  const rules: AclRule[] = policy.acls ?? [];

  const [newSrc, setNewSrc] = useState<string[]>([]);
  const [newDst, setNewDst] = useState<DstPair>({ dest: '*', port: '*' });

  /** 可选的别名池：用户 / 分组 / 标签 / 主机 / autogroup / 路由 CIDR */
  const allAliases = useMemo(() => {
    const groups: { label: string; options: { value: string; label: string }[] }[] = [];
    const opts = (arr: string[]) => arr.map((v) => ({ value: v, label: v }));

    if (ctx) {
      groups.push({ label: '通配', options: [{ value: '*', label: '* （全部）' }] });
      groups.push({ label: '网络用户', options: ctx.users.map((u) => ({ value: u.token, label: `${u.token}　${u.name}` })) });
      if (ctx.tags.length) groups.push({ label: '标签', options: opts(ctx.tags) });
      if (ctx.groups.length) groups.push({ label: '分组', options: opts(ctx.groups) });
      if (ctx.hosts.length) groups.push({ label: '主机', options: opts(ctx.hosts) });
      groups.push({ label: 'autogroup（源侧可用）', options: opts(ctx.autogroups.src) });
      if (ctx.routes.length) groups.push({ label: '已批准子网路由', options: opts(ctx.routes) });
      groups.push({ label: '设备 IP', options: ctx.nodes.flatMap((n) => n.ips.map((ip) => ({ value: ip, label: `${ip}　${n.name}` }))) });
    }
    return groups;
  }, [ctx]);

  const dstAliases = useMemo(() => {
    if (!ctx) return allAliases;
    // 目的侧额外允许 autogroup:internet / autogroup:self
    return [...allAliases, { label: 'autogroup（目的侧专用）', options: ctx.autogroups.dst.filter((g) => !ctx.autogroups.src.includes(g)).map((v) => ({ value: v, label: v })) }];
  }, [allAliases, ctx]);

  const protocols = ctx?.protocols ?? ['tcp', 'udp', 'icmp', 'icmpv6'];

  const update = (patch: Partial<AclPolicy>): void => onChange({ ...policy, ...patch });

  const setRules = (next: AclRule[]): void => update({ acls: next });

  const addRule = (): void => {
    if (!newSrc.length || !newDst.dest) return;
    const rule: AclRule = { action: 'accept', proto: 'tcp', src: newSrc, dst: [joinDest(newDst)] };
    setRules([...rules, rule]);
    setNewSrc([]);
    setNewDst({ dest: '*', port: '*' });
  };

  const patchRule = (i: number, patch: Partial<AclRule>): void => {
    setRules(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const removeRule = (i: number): void => setRules(rules.filter((_, idx) => idx !== i));

  // ---------------- hosts / groups / tagOwners ----------------
  const [newHost, setNewHost] = useState({ name: '', value: '' });
  const [newGroup, setNewGroup] = useState({ name: '', members: [] as string[] });
  const [newTag, setNewTag] = useState({ name: '', owners: [] as string[] });

  const hosts = policy.hosts ?? {};
  const groups = policy.groups ?? {};
  const tagOwners = policy.tagOwners ?? {};

  return (
    <div className="space-y-4">
      {/* -------- 全局语义警示 -------- */}
      {!aclsKeyExists && (
        <Alert
          type="warning"
          showIcon
          icon={<WarningOutlined />}
          message="当前策略没有 acls 字段 —— 整张网络处于「全通」状态"
          description={
            <span className="text-[12.5px]">
              在 ACL 中，<Text code>acls</Text> 键<b>不存在</b> 与 <Text code>acls: []</Text>（空数组）语义完全相反：
              前者放行一切流量，后者拒绝一切流量。添加第一条规则后即进入「按规则放行、未命中即拒绝」模式。
            </span>
          }
        />
      )}
      {aclsKeyExists && rules.length === 0 && (
        <Alert
          type="error"
          showIcon
          message="acls 为空数组 —— 所有设备之间完全无法互访"
          description={
            <span className="text-[12.5px]">
              这是「全禁」配置。若并非有意为之，请添加规则或删掉 <Text code>acls</Text> 键（删掉会变成全通，同样危险）。
            </span>
          }
        />
      )}

      {/* -------- 规则列表 -------- */}
      <div className="hsa-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold text-ink-800">访问规则</span>
            <Tag color={rules.length ? 'blue' : 'default'}>{rules.length} 条</Tag>
            <Tooltip title="未命中任何规则的流量一律拒绝（默认拒绝），不能写 deny 规则">
              <InfoCircleOutlined className="text-ink-400" />
            </Tooltip>
          </div>
          {aclsKeyExists && (
            <Popconfirm
              title="删除 acls 字段？"
              description="删掉后整张网络将变为「全通」——任何人都能访问任何设备。"
              okText="确认删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => {
                const next = { ...policy };
                delete next.acls;
                onChange(next);
              }}
              disabled={disabled}
            >
              <Button size="small" danger type="text" disabled={disabled}>
                删除 acls 字段（→ 全通）
              </Button>
            </Popconfirm>
          )}
        </div>

        {rules.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              aclsKeyExists ? '规则列表为空（全禁）' : '尚无规则（全通）'
            }
          />
        ) : (
          <div className="space-y-2">
            {rules.map((r, i) => (
              <div key={i} className="rounded-lg border border-ink-200/80 bg-white p-3 transition-shadow hover:shadow-sm">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-1 shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">
                    #{i + 1}
                  </span>

                  {/* src */}
                  <div className="min-w-[220px] flex-1">
                    <div className="mb-1 text-[11.5px] text-ink-500">源</div>
                    <Select
                      mode="multiple"
                      size="small"
                      className="w-full"
                      value={r.src}
                      options={allAliases}
                      onChange={(v: string[]) => patchRule(i, { src: v })}
                      placeholder="选择或输入源"
                      disabled={disabled}
                      maxTagCount="responsive"
                      allowClear
                    />
                  </div>

                  <ArrowRightOutlined className="mt-6 text-ink-300" />

                  {/* dst */}
                  <div className="min-w-[240px] flex-1">
                    <div className="mb-1 text-[11.5px] text-ink-500">目的（必须带端口）</div>
                    <Space.Compact className="w-full">
                      <Select
                        size="small"
                        className="flex-1"
                        value={splitDest(r.dst[0] ?? '*:*').dest}
                        options={dstAliases}
                        onChange={(v: string) => {
                          const cur = splitDest(r.dst[0] ?? '*:*');
                          patchRule(i, { dst: [joinDest({ dest: v, port: cur.port })] });
                        }}
                        disabled={disabled}
                        showSearch
                        optionFilterProp="label"
                        placeholder="目的别名"
                      />
                      <Input
                        size="small"
                        className="!w-[68px]"
                        value={splitDest(r.dst[0] ?? '*:*').port}
                        onChange={(e) => {
                          const cur = splitDest(r.dst[0] ?? '*:*');
                          patchRule(i, { dst: [joinDest({ dest: cur.dest, port: e.target.value })] });
                        }}
                        disabled={disabled}
                        placeholder="端口"
                      />
                    </Space.Compact>
                    <div className="mt-1 text-[11px] text-ink-400">
                      支持单端口 <Text code>443</Text>、区间 <Text code>8000-8100</Text>、多个 <Text code>80,443</Text>、通配 <Text code>*</Text>
                    </div>
                  </div>

                  {/* proto */}
                  <div className="w-[110px]">
                    <div className="mb-1 text-[11.5px] text-ink-500">协议</div>
                    <Select
                      size="small"
                      className="w-full"
                      value={r.proto}
                      options={protocols.map((p) => ({ value: p, label: p }))}
                      onChange={(v: string) => patchRule(i, { proto: v })}
                      disabled={disabled}
                      showSearch
                    />
                    <div className="mt-1 text-[11px] text-ink-400">不接受 *</div>
                  </div>

                  <Button
                    className="mt-5"
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeRule(i)}
                    disabled={disabled}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* -------- 新增规则 -------- */}
        {!disabled && (
          <>
            <Divider className="!my-4" />
            <div className="flex flex-wrap items-start gap-2 rounded-lg bg-brand-50/50 p-3">
              <div className="min-w-[220px] flex-1">
                <div className="mb-1 text-[11.5px] text-ink-500">新规则 · 源</div>
                <Select
                  mode="multiple"
                  size="small"
                  className="w-full"
                  value={newSrc}
                  options={allAliases}
                  onChange={setNewSrc}
                  placeholder="例如 labadmin@ 或 tag:prod"
                  maxTagCount="responsive"
                />
              </div>
              <ArrowRightOutlined className="mt-6 text-ink-300" />
              <div className="min-w-[240px] flex-1">
                <div className="mb-1 text-[11.5px] text-ink-500">新规则 · 目的</div>
                <Space.Compact className="w-full">
                  <Select
                    size="small"
                    className="flex-1"
                    value={newDst.dest}
                    options={dstAliases}
                    onChange={(v: string) => setNewDst((s) => ({ ...s, dest: v }))}
                    showSearch
                    optionFilterProp="label"
                  />
                  <Input
                    size="small"
                    className="!w-[68px]"
                    value={newDst.port}
                    onChange={(e) => setNewDst((s) => ({ ...s, port: e.target.value }))}
                    placeholder="端口"
                  />
                </Space.Compact>
              </div>
              <Button
                className="mt-5"
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                onClick={addRule}
                disabled={!newSrc.length || !newDst.dest}
              >
                添加规则
              </Button>
            </div>
          </>
        )}
      </div>

      {/* -------- 主机与分组 -------- */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* hosts */}
        <div className="hsa-card p-4">
          <div className="mb-2 text-[13.5px] font-semibold text-ink-800">
            主机别名 <Tag className="ml-1">{Object.keys(hosts).length}</Tag>
          </div>
          <div className="mb-3 text-[11.5px] text-ink-400">
            把 IP / CIDR 起个名字，供规则的源与目的引用。资源中心同步过来的条目也会出现在这里。
          </div>
          <div className="space-y-1.5">
            {Object.entries(hosts).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 text-[12.5px]">
                <Text code className="!text-[12px]">{k}</Text>
                <span className="text-ink-500">→</span>
                <span className="font-mono text-[12px] text-ink-700">{v}</span>
                <div className="flex-1" />
                <Button
                  size="small"
                  type="text"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={disabled}
                  onClick={() => {
                    const next = { ...hosts };
                    delete next[k];
                    update({ hosts: next });
                  }}
                />
              </div>
            ))}
            {!Object.keys(hosts).length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无" />}
          </div>
          {!disabled && (
            <Space.Compact className="mt-3 w-full">
              <Input
                size="small"
                placeholder="名称"
                className="!w-[38%]"
                value={newHost.name}
                onChange={(e) => setNewHost((s) => ({ ...s, name: e.target.value }))}
              />
              <Input
                size="small"
                placeholder="IP 或 CIDR"
                value={newHost.value}
                onChange={(e) => setNewHost((s) => ({ ...s, value: e.target.value }))}
              />
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={!newHost.name || !newHost.value}
                onClick={() => {
                  update({ hosts: { ...hosts, [newHost.name]: newHost.value } });
                  setNewHost({ name: '', value: '' });
                }}
              />
            </Space.Compact>
          )}
        </div>

        {/* groups */}
        <div className="hsa-card p-4">
          <div className="mb-2 text-[13.5px] font-semibold text-ink-800">
            用户分组 <Tag className="ml-1">{Object.keys(groups).length}</Tag>
          </div>
          <div className="mb-3 text-[11.5px] text-ink-400">
            分组名必须以 <Text code>group:</Text> 开头，成员写 <Text code>user@</Text> 形式。
          </div>
          <div className="space-y-2">
            {Object.entries(groups).map(([k, members]) => (
              <div key={k} className="rounded border border-ink-200/80 p-2">
                <div className="mb-1 flex items-center gap-1.5">
                  <Text code className="!text-[12px]">{k}</Text>
                  <div className="flex-1" />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...groups };
                      delete next[k];
                      update({ groups: next });
                    }}
                  />
                </div>
                <Select
                  mode="tags"
                  size="small"
                  className="w-full"
                  value={members}
                  options={allAliases}
                  disabled={disabled}
                  onChange={(v: string[]) => update({ groups: { ...groups, [k]: v } })}
                  placeholder="成员"
                />
              </div>
            ))}
            {!Object.keys(groups).length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无" />}
          </div>
          {!disabled && (
            <Space.Compact className="mt-3 w-full">
              <Input
                size="small"
                placeholder="group:名称"
                value={newGroup.name}
                onChange={(e) => setNewGroup((s) => ({ ...s, name: e.target.value }))}
              />
              <Select
                mode="multiple"
                size="small"
                className="flex-1"
                placeholder="成员"
                value={newGroup.members}
                options={allAliases}
                onChange={(v: string[]) => setNewGroup((s) => ({ ...s, members: v }))}
                maxTagCount="responsive"
              />
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={!/^group:[a-zA-Z0-9._-]+$/.test(newGroup.name) || !newGroup.members.length}
                onClick={() => {
                  update({ groups: { ...groups, [newGroup.name]: newGroup.members } });
                  setNewGroup({ name: '', members: [] });
                }}
              />
            </Space.Compact>
          )}
        </div>

        {/* tagOwners */}
        <div className="hsa-card p-4">
          <div className="mb-2 text-[13.5px] font-semibold text-ink-800">
            标签归属 <Tag className="ml-1">{Object.keys(tagOwners).length}</Tag>
          </div>
          <Alert
            type="warning"
            showIcon
            className="!mb-3 !py-1"
            message={<span className="text-[11.5px]">标签只在「归属者」名下可被设备获取</span>}
          />
          <div className="space-y-2">
            {Object.entries(tagOwners).map(([k, owners]) => (
              <div key={k} className="rounded border border-ink-200/80 p-2">
                <div className="mb-1 flex items-center gap-1.5">
                  <Text code className="!text-[12px]">{k}</Text>
                  <div className="flex-1" />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={disabled}
                    onClick={() => {
                      const next = { ...tagOwners };
                      delete next[k];
                      update({ tagOwners: next });
                    }}
                  />
                </div>
                <Select
                  mode="tags"
                  size="small"
                  className="w-full"
                  value={owners}
                  options={allAliases}
                  disabled={disabled}
                  onChange={(v: string[]) => update({ tagOwners: { ...tagOwners, [k]: v } })}
                  placeholder="归属者（user@ / group:x / autogroup:member）"
                />
              </div>
            ))}
            {!Object.keys(tagOwners).length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无" />}
          </div>
          {!disabled && (
            <Space.Compact className="mt-3 w-full">
              <Input
                size="small"
                placeholder="tag:名称"
                value={newTag.name}
                onChange={(e) => setNewTag((s) => ({ ...s, name: e.target.value }))}
              />
              <Select
                mode="multiple"
                size="small"
                className="flex-1"
                placeholder="归属者"
                value={newTag.owners}
                options={allAliases}
                onChange={(v: string[]) => setNewTag((s) => ({ ...s, owners: v }))}
                maxTagCount="responsive"
              />
              <Button
                size="small"
                type="primary"
                icon={<PlusOutlined />}
                disabled={!/^tag:[a-zA-Z0-9._-]+$/.test(newTag.name) || !newTag.owners.length}
                onClick={() => {
                  update({ tagOwners: { ...tagOwners, [newTag.name]: newTag.owners } });
                  setNewTag({ name: '', owners: [] });
                }}
              />
            </Space.Compact>
          )}
        </div>
      </div>

      {disabled && (
        <Alert type="info" showIcon message="当前账户没有 ACL 写权限，编辑器为只读" />
      )}
    </div>
  );
}
