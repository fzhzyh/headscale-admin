/** 快速连接：按平台生成接入命令，一键复制 */
import { useState } from 'react';
import { Button, Card, Input, Select, Form, Tabs, Alert, Tag, Typography, App as AntApp, Space } from 'antd';
import { CopyOutlined, ApiOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { PageHeader } from '../components/ui';
import { useAuth } from '../store/auth';

const { Text, Paragraph } = Typography;

interface CommandsResponse {
  loginServer: string;
  hasAuthKey: boolean;
  commands: Record<string, string>;
  notes: string[];
}

const TABS = [
  { key: 'linux', label: 'Linux / macOS' },
  { key: 'windows', label: 'Windows' },
  { key: 'docker', label: 'Docker' },
  { key: 'subnetRouter', label: '子网路由' },
  { key: 'exitNode', label: '出口节点' },
  { key: 'ssh', label: 'Tailscale SSH' },
  { key: 'logout', label: '退出 / 断开' },
];

export default function ConnectPage(): React.ReactElement {
  const { message } = AntApp.useApp();
  const { can } = useAuth();
  const [form] = Form.useForm();
  const [params, setParams] = useState<Record<string, string | undefined>>({});

  const { data, isFetching, refetch } = useQuery({
    queryKey: ['connect-commands', params],
    queryFn: () =>
      api.get<CommandsResponse>('/api/connect/commands', {
        hostname: params.hostname,
        tags: params.tags,
        key: params.key,
        loginServer: params.loginServer,
      }),
  });

  const preauthQuery = useQuery({
    queryKey: ['preauthkeys'],
    queryFn: () => api.get<{ keys: { id: number; key: string; user: { name: string } | null; reusable: boolean; expired: boolean }[] }>('/api/preauthkeys'),
    enabled: can('preauthkey:read'),
  });

  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制到剪贴板');
    } catch {
      message.warning('复制失败，请手动选择文本复制');
    }
  };

  const cmds = data?.commands ?? {};

  return (
    <>
      <PageHeader
        title="快速连接"
        description="按参数生成设备接入命令，直接复制到目标机器执行。"
        extra={
          <Button icon={<ThunderboltOutlined />} onClick={() => void refetch()} loading={isFetching}>
            重新生成
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
        {/* 参数表单 */}
        <Card size="small" title={<span className="text-[13.5px] font-semibold text-ink-800">生成参数</span>}>
          <Form
            form={form}
            layout="vertical"
            onChange={() => {
              const v = form.getFieldsValue() as Record<string, string | undefined>;
              setParams(v);
            }}
            initialValues={{ tags: '', hostname: '' }}
          >
            <Form.Item name="hostname" label="设备名（可选）" tooltip="接入后设备在面板中显示的名字">
              <Input placeholder="例如 lab-alpha" allowClear />
            </Form.Item>

            <Form.Item name="key" label="预授权密钥" tooltip="填了就用密钥免浏览器授权；留空则需要浏览器登录">
              <Select
                allowClear
                showSearch
                placeholder="留空 = 浏览器授权"
                optionFilterProp="label"
                options={(preauthQuery.data?.keys ?? [])
                  .filter((k) => !k.expired)
                  .map((k) => ({
                    value: k.key,
                    label: `${k.user?.name ?? '?'} · ${k.key.slice(0, 22)}…`,
                  }))}
              />
            </Form.Item>

            <Form.Item name="tags" label="标签（逗号分隔，可选）" tooltip="需先在 ACL tagOwners 中定义，否则设备接入后打标签会被拒绝">
              <Input placeholder="tag:lab,tag:prod" allowClear />
            </Form.Item>

            <Form.Item
              name="loginServer"
              label="登录服务器（可选）"
              tooltip="留空则用面板配置的 Headscale 地址。若设备走另一条地址接入，可在此覆写"
            >
              <Input placeholder="https://hs.example.com" allowClear />
            </Form.Item>
          </Form>

          {!data?.hasAuthKey && (
            <Alert
              type="info"
              showIcon
              className="mt-2"
              message="当前未选择预授权密钥"
              description={
                <span className="text-[12px]">
                  设备执行命令后会返回一个待批 authId，需在「设备管理 → 注册设备」中批准。
                </span>
              }
            />
          )}
        </Card>

        {/* 命令输出 */}
        <Card
          size="small"
          title={
            <div className="flex items-center gap-2">
              <ApiOutlined className="text-brand-500" />
              <span className="text-[13.5px] font-semibold text-ink-800">接入命令</span>
              {data?.loginServer && (
                <Tag className="!mr-0 font-mono !text-[11px]">{data.loginServer}</Tag>
              )}
            </div>
          }
        >
          <Tabs
            size="small"
            items={TABS.map((t) => ({
              key: t.key,
              label: t.label,
              children: (
                <div>
                  <div className="relative">
                    <Paragraph
                      className="!mb-0 !rounded-lg !border !border-ink-200 !bg-ink-50 !p-3 !font-mono !text-[12.5px] !leading-relaxed"
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                    >
                      {cmds[t.key] ?? '—'}
                    </Paragraph>
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      className="!absolute !right-2 !top-2"
                      onClick={() => void copy(cmds[t.key] ?? '')}
                    >
                      复制
                    </Button>
                  </div>

                  {t.key === 'ssh' && (
                    <Alert
                      type="warning"
                      showIcon
                      className="mt-3"
                      message="Tailscale SSH 需两步就绪"
                      description={
                        <span className="text-[12.5px]">
                          1）对端设备需开启 <span className="font-mono">tailscale ssh</span>；
                          2）ACL 的 <span className="font-mono">ssh</span> 段需为你的身份放行。
                          两者缺一，连接都会被拒绝。
                        </span>
                      }
                    />
                  )}

                  {t.key === 'subnetRouter' && (
                    <Alert
                      type="info"
                      showIcon
                      className="mt-3"
                      message="发布后需在「路由管理」中批准"
                      description={
                        <span className="text-[12.5px]">
                          设备通告的路由默认<b>不会生效</b>，必须在面板中逐条启用，客户端才会把对应网段的流量交给它。
                        </span>
                      }
                    />
                  )}

                  {t.key === 'exitNode' && (
                    <Alert
                      type="warning"
                      showIcon
                      className="mt-3"
                      message="出口节点会承载全网流量"
                      description={
                        <span className="text-[12.5px]">
                          启用后需在 ACL 中通过 <span className="font-mono">autogroup:internet</span> 或
                          <span className="font-mono"> via </span>允许客户端使用它。带宽与稳定性要求较高。
                        </span>
                      }
                    />
                  )}
                </div>
              ),
            }))}
          />

          {data?.notes && data.notes.length > 0 && (
            <div className="mt-4 border-t border-ink-100 pt-3">
              <Text type="secondary" className="!text-[11.5px]">
                {data.notes.map((n, i) => (
                  <div key={i} className="flex gap-1.5">
                    <span>·</span>
                    <span>{n}</span>
                  </div>
                ))}
              </Text>
            </div>
          )}

          <Space className="mt-4" wrap>
            <Button size="small" onClick={() => void copy(cmds['linux'] ?? '')} icon={<CopyOutlined />}>
              复制 Linux 命令
            </Button>
            <Button
              size="small"
              onClick={() => {
                const all = TABS.map((t) => `### ${t.label}\n${cmds[t.key] ?? ''}`).join('\n\n');
                void copy(all);
              }}
              icon={<CopyOutlined />}
            >
              复制全部
            </Button>
          </Space>
        </Card>
      </div>
    </>
  );
}
