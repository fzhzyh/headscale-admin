/**
 * 系统设置：Headscale 连接、DNS 路径、InfluxDB、采样参数 + 连接自检。
 *
 * 交互设计：
 *   - API Key / Token 是敏感项，留空表示「保持原值不变」，不会因为误提交被清空
 *   - 保存前可先「测试连接」，避免改了地址把自己连不上
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Form,
  Input,
  Button,
  Card,
  Alert,
  Switch,
  InputNumber,
  Select,
  Tag,
  Divider,
  App as AntApp,
  Spin,
  Tooltip,
} from 'antd';
import { SaveOutlined, ApiOutlined, ReloadOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, errorText } from '../api/client';
import type { ConnectionTest, SettingItem } from '../api/types';
import { PageHeader, StatePill, KV } from '../components/ui';
import { useAuth } from '../store/auth';

const GROUP_LABELS: Record<string, string> = {
  headscale: 'Headscale 连接',
  dns: 'DNS 额外记录',
  influx: '时序库（InfluxDB）',
  poll: '状态采样',
  system: '系统',
};

/**
 * 判断是否为敏感项。
 * 后端对敏感项只回掩码（含 •），因此「已配置且值含 •」即可判定；
 * 未配置的敏感项从 key 命名推断（apiKey / token）。
 */
function isSecretItem(i: SettingItem): boolean {
  if ((i.value ?? '').includes('•')) return true;
  return /apiKey|token|secret|password/i.test(i.key);
}

export default function SettingsPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { can } = useAuth();
  const [form] = Form.useForm();
  const [testResult, setTestResult] = useState<ConnectionTest | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ items: SettingItem[] }>('/api/settings'),
  });

  const runtimeQuery = useQuery({
    queryKey: ['settings-runtime'],
    queryFn: () =>
      api.get<{
        node: string;
        platform: string;
        uptimeSec: number;
        memory: { rssMB: number; heapUsedMB: number };
        headscale: { transport: string; url: string; hasApiKey: boolean };
      }>('/api/settings/runtime'),
  });

  const items = data?.items ?? [];
  const grouped = useMemo(() => {
    const m = new Map<string, SettingItem[]>();
    for (const i of items) {
      if (i.key === 'system.lastSyncAt') continue;
      if (!m.has(i.group)) m.set(i.group, []);
      m.get(i.group)!.push(i);
    }
    return m;
  }, [items]);

  // 表单初值：敏感项留空（占位显示「已配置」状态）
  useEffect(() => {
    if (items.length === 0) return;
    const v: Record<string, unknown> = {};
    for (const i of items) {
      if (i.key === 'system.lastSyncAt') continue;
      if (i.configured && (i.value ?? '').includes('•')) {
        v[i.key] = '';
      } else if (i.type === 'boolean') {
        v[i.key] = i.value === 'true';
      } else if (i.type === 'number') {
        v[i.key] = i.value ? Number(i.value) : undefined;
      } else {
        v[i.key] = i.value ?? '';
      }
    }
    form.setFieldsValue(v);
  }, [items, form]);

  const saveMut = useMutation({
    mutationFn: (body: { items: Record<string, string> }) => api.put<{ changed: string[]; skipped: string[] }>('/api/settings', body),
    onSuccess: async (r) => {
      if (r.changed.length === 0) {
        message.info('没有需要保存的变更');
      } else {
        message.success(`已保存 ${r.changed.length} 项设置`);
      }
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['overview'] });
      await qc.invalidateQueries({ queryKey: ['settings-runtime'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  const testMut = useMutation({
    mutationFn: () => api.post<ConnectionTest>('/api/settings/test-connection'),
    onSuccess: (r) => {
      setTestResult(r);
      if (r.ok) message.success(`连接正常（${r.latencyMs ?? '?'} ms）`);
      else message.error(`连接失败：${r.error ?? '未知原因'}`);
    },
    onError: (e) => message.error(errorText(e)),
  });

  const onSave = async (): Promise<void> => {
    const values = form.getFieldsValue() as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const i of items) {
      if (i.key === 'system.lastSyncAt') continue;
      const raw = values[i.key];
      // 敏感项留空 = 保持原值，不提交
      if (i.configured && (i.value ?? '').includes('•') && (raw === '' || raw === undefined)) continue;
      if (raw === undefined || raw === null) continue;
      out[i.key] = typeof raw === 'boolean' ? String(raw) : String(raw);
    }
    await saveMut.mutateAsync({ items: out });
  };

  const editable = can('settings:write');

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <Spin size="large" tip="正在加载设置…" />
      </div>
    );
  }

  if (error) {
    return <Alert type="error" showIcon message="无法加载设置" description={errorText(error)} />;
  }

  return (
    <>
      <PageHeader
        title="系统设置"
        description="连接参数以数据库为准，保存后立即生效（环境变量只用于首次启动引导）。"
        extra={
          <>
            <Button icon={<ReloadOutlined spin={testMut.isPending} />} onClick={() => testMut.mutate()} loading={testMut.isPending}>
              测试连接
            </Button>
            {editable && (
              <Button type="primary" icon={<SaveOutlined />} onClick={() => void onSave()} loading={saveMut.isPending}>
                保存设置
              </Button>
            )}
          </>
        }
      />

      {!editable && (
        <Alert type="warning" showIcon className="mb-4" message="当前账户无「系统设置」写权限，以下为只读视图。" />
      )}

      {/* 连接自检结果 */}
      {testResult && (
        <Card
          size="small"
          className="mb-4 animate-fade-in"
          title={
            <div className="flex items-center gap-2">
              {testResult.ok ? (
                <CheckCircleOutlined className="text-emerald-500" />
              ) : (
                <CloseCircleOutlined className="text-rose-500" />
              )}
              <span className="text-[13.5px]">连接自检结果</span>
              {testResult.ok ? <StatePill tone="ok">通过</StatePill> : <StatePill tone="danger">失败</StatePill>}
            </div>
          }
          extra={
            <Button type="text" size="small" onClick={() => setTestResult(null)}>
              收起
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
            <div>
              <KV label="接口地址" mono value={testResult.address || null} />
              <KV label="传输方式" value={testResult.transport} />
              <KV label="API Key" value={testResult.hasApiKey ? '已配置' : '未配置'} />
            </div>
            <div>
              <KV label="响应延迟" mono value={testResult.latencyMs !== undefined ? `${testResult.latencyMs} ms` : null} />
              <KV
                label="上游数据库"
                value={
                  testResult.databaseConnectivity === undefined
                    ? '未探测'
                    : testResult.databaseConnectivity
                      ? '连通'
                      : '异常'
                }
              />
              <KV label="检查时间" value={new Date(testResult.checkedAt).toLocaleString('zh-CN')} />
            </div>
          </div>

          {testResult.error && (
            <Alert type="error" showIcon className="mt-3" message={testResult.error} />
          )}
          {testResult.diagnosis && testResult.diagnosis.length > 0 && (
            <Alert
              type="warning"
              showIcon
              className="mt-3"
              message="排障建议"
              description={
                <ul className="ml-4 list-disc text-[12.5px]">
                  {testResult.diagnosis.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              }
            />
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <Form form={form} layout="vertical" disabled={!editable}>
            {Array.from(grouped.entries()).map(([group, list]) => (
              <Card
                key={group}
                size="small"
                className="mb-4 hsa-card-hover"
                title={
                  <span className="text-[13.5px] font-semibold text-ink-800">
                    {GROUP_LABELS[group] ?? group}
                  </span>
                }
              >
                {list.map((i) => (
                  <Form.Item
                    key={i.key}
                    name={i.key}
                    label={
                      <span className="flex items-center gap-1.5">
                        <span className="text-[12.5px]">{i.label}</span>
                        {i.configured && i.value?.includes('•') && <StatePill tone="ok">已配置</StatePill>}
                      </span>
                    }
                    tooltip={i.hint}
                    valuePropName={i.type === 'boolean' ? 'checked' : 'value'}
                    className="!mb-4"
                  >
                    {i.type === 'boolean' ? (
                      <Switch />
                    ) : i.type === 'number' ? (
                      <InputNumber style={{ width: '100%' }} min={1} />
                    ) : i.type === 'select' ? (
                      <Select options={(i.options ?? []).map((o) => ({ label: o, value: o }))} />
                    ) : isSecretItem(i) ? (
                      <Input.Password
                        placeholder={i.configured ? '已配置（留空表示不修改）' : '未配置，请填入'}
                        autoComplete="new-password"
                      />
                    ) : (
                      <Input placeholder={i.hint ? '' : undefined} />
                    )}
                  </Form.Item>
                ))}
              </Card>
            ))}
          </Form>
        </div>

        <div>
          <Card size="small" className="mb-4" title={<span className="text-[13.5px] font-semibold text-ink-800">运行信息</span>}>
            {runtimeQuery.data ? (
              <div>
                <KV label="Node 版本" mono value={runtimeQuery.data.node} />
                <KV label="运行平台" mono value={runtimeQuery.data.platform} />
                <KV
                  label="已运行"
                  value={`${Math.floor(runtimeQuery.data.uptimeSec / 3600)} 小时 ${Math.floor((runtimeQuery.data.uptimeSec % 3600) / 60)} 分`}
                />
                <KV label="内存占用" mono value={`RSS ${runtimeQuery.data.memory.rssMB} MB / Heap ${runtimeQuery.data.memory.heapUsedMB} MB`} />
                <Divider className="!my-3" />
                <KV label="上游传输" value={<Tag className="!mr-0">{runtimeQuery.data.headscale.transport}</Tag>} />
                <KV label="上游地址" mono value={runtimeQuery.data.headscale.url || null} />
                <KV
                  label="API Key"
                  value={runtimeQuery.data.headscale.hasApiKey ? <StatePill tone="ok">已配置</StatePill> : <StatePill tone="danger">未配置</StatePill>}
                />
              </div>
            ) : (
              <div className="hsa-skeleton h-32 rounded" />
            )}
          </Card>

          <Card size="small" className="mb-4" title={<span className="text-[13.5px] font-semibold text-ink-800">安全提示</span>}>
            <div className="space-y-2 text-[12.5px] leading-relaxed text-ink-600">
              <div className="flex gap-2">
                <ApiOutlined className="mt-0.5 shrink-0 text-brand-500" />
                <span>
                  Headscale API Key 与 InfluxDB Token 以 <b>AES-256-GCM</b> 加密落库，
                  保存后不再回显明文，读取时只返回掩码。
                </span>
              </div>
              <div className="flex gap-2">
                <Tooltip title="主密钥位于 PANEL_DATA_DIR/master.key，权限 600">
                  <span className="mt-0.5 shrink-0 text-brand-500">🔑</span>
                </Tooltip>
                <span>
                  主密钥来自环境变量 <span className="font-mono">PANEL_MASTER_KEY</span>，
                  未设置时首次启动自动生成到 <span className="font-mono">data/master.key</span>。
                  <b>该文件丢失将导致已加密的凭据无法解密</b>，请纳入备份。
                </span>
              </div>
              <div className="flex gap-2">
                <span className="mt-0.5 shrink-0 text-brand-500">⚠️</span>
                <span>
                  敏感项留空表示<b>保持原值不变</b>，不会被清空。要清除请显式填入新值。
                </span>
              </div>
            </div>
          </Card>

          {items.find((i) => i.key === 'system.lastSyncAt')?.value && (
            <Card size="small" title={<span className="text-[13.5px] font-semibold text-ink-800">同步状态</span>}>
              <KV
                label="最后同步"
                value={new Date(items.find((i) => i.key === 'system.lastSyncAt')!.value!).toLocaleString('zh-CN')}
              />
              <Button
                size="small"
                className="mt-2"
                icon={<ReloadOutlined />}
                disabled={!can('settings:write')}
                onClick={async () => {
                  try {
                    const r = await api.post<{ nodes: number; users: number }>('/api/system/sync');
                    message.success(`同步完成：${r.nodes} 台设备 / ${r.users} 个用户`);
                    await refetch();
                  } catch (e) {
                    message.error(errorText(e));
                  }
                }}
              >
                立即同步
              </Button>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
