/**
 * 内置 OIDC Provider 管理页
 *
 * 面板自身作为 OIDC 认证源，供 headscale（或其他服务）对接。
 *
 * ## 页面要讲清的三件事
 * 1. **给 headscale 用的三个配置项**：issuer / client_id / client_secret。
 *    直接把值列出来可复制，省得用户去猜端点路径。
 * 2. **client_secret 只显示一次**。之后只能看到前缀——这是刻意的，
 *    面板不保留明文，只有 bcrypt 哈希。
 * 3. **密钥轮换的两种模式差别很大**：
 *    · 保留旧密钥（推荐）：新 token 用新 key，旧 token 仍能验签
 *    · 强制退役：旧 key 立刻从 JWKS 移除 → **已签发 token 全部失效**
 *    这个代价必须写在按钮旁边，不能只写在文档里。
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
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  InfoCircleOutlined,
  KeyOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyOutlined,
} from '@ant-design/icons';

import { api, errorText } from '../api/client';
import type { OidcClient, OidcClientList, OidcKeysResponse, OidcCreatedClient } from '../api/types';
import { PageHeader, StatePill } from '../components/ui';
import { useAuth } from '../store/auth';

const { Text } = Typography;

interface FormValues {
  name: string;
  redirectUris: string;
  postLogoutUris?: string;
  isPublic: boolean;
  requirePkce: boolean;
}

export default function OidcPage(): React.ReactElement {
  const qc = useQueryClient();
  const { message, modal } = AntApp.useApp();
  const { can } = useAuth();
  const canWrite = can('oidc:write');

  const [editing, setEditing] = useState<OidcClient | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [form] = Form.useForm<FormValues>();

  const listQuery = useQuery({
    queryKey: ['oidc-clients'],
    queryFn: () => api.get<OidcClientList>('/api/oidc/clients'),
  });

  const keysQuery = useQuery({
    queryKey: ['oidc-keys'],
    queryFn: () => api.get<OidcKeysResponse>('/api/oidc/keys'),
  });

  const clients = listQuery.data?.clients ?? [];
  const keys = keysQuery.data?.keys ?? [];
  const issuer = keysQuery.data?.issuer ?? '';

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ isPublic: false, requirePkce: true, redirectUris: '' });
    setModalOpen(true);
  };

  const openEdit = (c: OidcClient): void => {
    setEditing(c);
    form.setFieldsValue({
      name: c.name,
      redirectUris: c.redirectUris.join('\n'),
      postLogoutUris: c.postLogoutUris.join('\n'),
      isPublic: c.isPublic,
      requirePkce: c.requirePkce,
    });
    setModalOpen(true);
  };

  const splitLines = (s?: string): string[] =>
    (s ?? '')
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean);

  const submit = async (): Promise<void> => {
    const v = await form.validateFields();
    try {
      if (editing) {
        await api.put(`/api/oidc/clients/${editing.id}`, {
          name: v.name,
          redirectUris: splitLines(v.redirectUris),
          postLogoutUris: splitLines(v.postLogoutUris),
          requirePkce: v.requirePkce,
        });
        message.success('已保存');
      } else {
        const res = await api.post<OidcCreatedClient>('/api/oidc/clients', {
          name: v.name,
          redirectUris: splitLines(v.redirectUris),
          postLogoutUris: splitLines(v.postLogoutUris),
          isPublic: v.isPublic,
          requirePkce: v.requirePkce,
        });
        setModalOpen(false);
        // secret 只返回一次，必须单独弹窗让人抄走
        modal.info({
          title: '客户端已创建',
          width: 620,
          content: (
            <div className="space-y-2 text-[12.5px]">
              <div>
                client_id：<Text code copyable>{res.client?.clientId ?? ''}</Text>
              </div>
              {res.clientSecret ? (
                <>
                  <div>
                    client_secret：<Text code copyable>{res.clientSecret}</Text>
                  </div>
                  <Alert
                    type="warning"
                    showIcon
                    message="client_secret 只显示这一次"
                    description="面板只保存 bcrypt 哈希，关闭后无法再查看明文。请立即保存。"
                  />
                </>
              ) : (
                <Alert type="info" showIcon message="public client 无 secret，依赖 PKCE" />
              )}
            </div>
          ),
        });
      }
      await qc.invalidateQueries({ queryKey: ['oidc-clients'] });
      await qc.invalidateQueries({ queryKey: ['overview'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doDelete = async (c: OidcClient): Promise<void> => {
    try {
      await api.del(`/api/oidc/clients/${c.id}`);
      message.success('已删除；该客户端的授权码与 refresh token 同时失效');
      await qc.invalidateQueries({ queryKey: ['oidc-clients'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doRotateSecret = async (c: OidcClient): Promise<void> => {
    try {
      const res = await api.post<{ clientSecret: string; note: string }>(
        `/api/oidc/clients/${c.id}/rotate`,
      );
      modal.info({
        title: 'client_secret 已轮换',
        width: 600,
        content: (
          <div className="space-y-2 text-[12.5px]">
            <div>
              新 secret：<Text code copyable>{res.clientSecret}</Text>
            </div>
            <Alert type="warning" showIcon message={res.note} />
          </div>
        ),
      });
      await qc.invalidateQueries({ queryKey: ['oidc-clients'] });
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const doRotateKey = async (retireOld: boolean): Promise<void> => {
    setRotating(true);
    try {
      const res = await api.post<{ kid: string; retired: string[]; note: string }>(
        '/api/oidc/keys/rotate',
        { retireOld },
      );
      message.success(`新签名密钥：${res.kid}`);
      modal.info({
        title: '签名密钥已轮换',
        width: 600,
        content: (
          <div className="space-y-2 text-[12.5px]">
            <div>
              新 kid：<Text code>{res.kid}</Text>
            </div>
            {res.retired.length > 0 && (
              <div>
                已退役：<Text code>{res.retired.join(', ')}</Text>
              </div>
            )}
            <Alert
              type={retireOld ? 'warning' : 'success'}
              showIcon
              message={res.note}
            />
          </div>
        ),
      });
      await qc.invalidateQueries({ queryKey: ['oidc-keys'] });
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setRotating(false);
    }
  };

  const columns: ColumnsType<OidcClient> = [
    {
      title: '客户端',
      dataIndex: 'name',
      key: 'name',
      render: (name: string, c) => (
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-ink-800">{name}</span>
            {c.isPublic && <Tag color="purple" className="!m-0 !text-[10px]">public</Tag>}
            {!c.enabled && <StatePill tone="idle">已禁用</StatePill>}
          </div>
          <div className="font-mono text-[11px] text-ink-400">{c.clientId}</div>
        </div>
      ),
    },
    {
      title: '回调地址',
      dataIndex: 'redirectUris',
      key: 'redirectUris',
      render: (uris: string[]) => (
        <div className="space-y-0.5">
          {uris.map((u) => (
            <div key={u} className="font-mono text-[11.5px] text-ink-600">
              {u}
            </div>
          ))}
        </div>
      ),
    },
    {
      title: (
        <span className="inline-flex items-center gap-1">
          PKCE
          <Tooltip title="授权码是 bearer 凭据；PKCE 让「截到 code 但没 verifier」也换不到 token。public client 必须开。">
            <InfoCircleOutlined className="text-[11px] text-ink-300" />
          </Tooltip>
        </span>
      ),
      dataIndex: 'requirePkce',
      key: 'requirePkce',
      width: 90,
      render: (v: boolean) => (v ? <StatePill tone="ok">强制</StatePill> : <StatePill tone="warn">未强制</StatePill>),
    },
    {
      title: 'secret',
      dataIndex: 'secretPrefix',
      key: 'secretPrefix',
      width: 150,
      render: (p: string | null, c) => {
        if (c.isPublic) return <span className="text-[11.5px] text-ink-400">无（public）</span>;
        return (
          <div className="text-[11.5px]">
            <span className="font-mono text-ink-600">{p ?? '—'}</span>
            {c.secretRotatedAt && (
              <div className="text-[10.5px] text-ink-400">
                轮换于 {new Date(c.secretRotatedAt).toLocaleDateString('zh-CN')}
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: '操作',
      key: 'ops',
      width: 220,
      render: (_: unknown, c) => (
        <Space size={2}>
          <Button size="small" type="link" icon={<EditOutlined />} disabled={!canWrite} onClick={() => openEdit(c)}>
            编辑
          </Button>
          {!c.isPublic && (
            <Popconfirm
              title="轮换 client_secret？"
              description="旧 secret 立即失效，下游需同步更新"
              okText="轮换"
              cancelText="取消"
              onConfirm={() => void doRotateSecret(c)}
              disabled={!canWrite}
            >
              <Button size="small" type="link" icon={<ReloadOutlined />} disabled={!canWrite}>
                换 secret
              </Button>
            </Popconfirm>
          )}
          <Popconfirm
            title="删除这个客户端？"
            description="其授权码与 refresh token 会同时失效"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void doDelete(c)}
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
        <Spin size="large" tip="加载 OIDC 配置…" />
      </div>
    );
  }

  if (listQuery.error) {
    return (
      <div className="hsa-card p-6">
        <Alert type="error" showIcon message="加载 OIDC 配置失败" description={errorText(listQuery.error)} />
      </div>
    );
  }

  const activeKeys = keys.filter((k) => k.active);

  return (
    <>
      <PageHeader
        title="OIDC Provider"
        description="面板作为 OIDC 认证源，供 Headscale 等下游服务对接"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!canWrite}>
            新建客户端
          </Button>
        }
      />

      {/* 对接信息：直接给出 headscale 需要填的三个值 */}
      <div className="mb-4 hsa-card p-5">
        <div className="mb-3 flex items-center gap-2">
          <SafetyOutlined className="text-brand-500" />
          <h3 className="text-[14px] font-semibold text-ink-800">Headscale 侧对接配置</h3>
        </div>
        <div className="space-y-2 text-[12.5px]">
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-ink-500">oidc.issuer</span>
            <Text code copyable className="text-[11.5px]">
              {issuer}
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-ink-500">jwks_uri</span>
            <Text code copyable className="text-[11.5px]">
              {keysQuery.data?.jwksUri ?? `${issuer}/oidc/jwks`}
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-ink-500">oidc.client_id</span>
            <span className="text-ink-400">
              {clients.length > 0 ? '从下方客户端列表取 client_id' : '先新建一个客户端'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-ink-500">oidc.client_secret</span>
            <span className="text-ink-400">创建客户端时只显示一次，请当时保存</span>
          </div>
        </div>
        <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-600">
          {`oidc:
  issuer: "${issuer}"
  client_id: "<客户端 client_id>"
  client_secret: "<创建时保存的 secret>"
  scope: ["openid", "profile", "email", "groups"]
  pkce:
    enabled: true
    method: "S256"`}
        </div>
        <div className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
          注：headscale 侧还需按需配置 <Text code>oidc.allowed_domains</Text> 等策略；
          本面板只负责签发，不做下游授权决策。
        </div>
      </div>

      {/* 签名密钥 */}
      <div className="mb-4 hsa-card p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <KeyOutlined className="text-brand-500" />
            <h3 className="text-[14px] font-semibold text-ink-800">签名密钥</h3>
            <span className="text-[11.5px] text-ink-400">
              RS256 · {activeKeys.length} 把在签发/验签
            </span>
          </div>
          <Space>
            <Tooltip title="新密钥用于签发，旧密钥保留在 JWKS 继续验签。已签发的 token 不受影响。">
              <Button
                size="small"
                icon={<ReloadOutlined />}
                loading={rotating}
                disabled={!canWrite}
                onClick={() => void doRotateKey(false)}
              >
                轮换（保留旧密钥）
              </Button>
            </Tooltip>
            <Popconfirm
              title="强制退役旧密钥？"
              description="旧密钥立即从 JWKS 移除，已签发的 ID Token 会全部验签失败（在线会话掉线）"
              okText="确认退役"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void doRotateKey(true)}
              disabled={!canWrite}
            >
              <Button size="small" danger disabled={!canWrite}>
                强制退役
              </Button>
            </Popconfirm>
          </Space>
        </div>

        <div className="space-y-1.5">
          {keys.length === 0 ? (
            <div className="text-[12.5px] text-ink-500">
              还没有签名密钥。首次访问 JWKS 或签发 token 时会自动生成。
            </div>
          ) : (
            keys.map((k) => (
              <div
                key={k.kid}
                className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-50/70 px-3 py-2 text-[11.5px]"
              >
                <span className="font-mono text-ink-700">{k.kid}</span>
                <Tag className="!m-0 !text-[10px]">{k.alg}</Tag>
                {k.active ? <StatePill tone="ok">签发中</StatePill> : <StatePill tone="idle">仅验签</StatePill>}
                <span className="text-ink-400">
                  创建 {new Date(k.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  {k.retiredAt && ` · 退役 ${new Date(k.retiredAt).toLocaleString('zh-CN', { hour12: false })}`}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="mt-2.5 border-t border-ink-100 pt-2.5 text-[11px] leading-relaxed text-ink-400">
          私钥以 AES-256-GCM 加密落库；JWKS 只公开公钥（不含 d/p/q 等字段）。
          轮换时保留旧密钥是推荐做法——强制退役会让所有已签发 token 立刻失效。
        </div>
      </div>

      {/* 客户端列表 */}
      <div className="hsa-card overflow-hidden p-0">
        {clients.length === 0 ? (
          <div className="p-10">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-[12.5px] text-ink-500">
                  还没有 OIDC 客户端。下游服务（如 headscale）需要先在这里登记。
                </span>
              }
            >
              {canWrite && (
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新建客户端
                </Button>
              )}
            </Empty>
          </div>
        ) : (
          <Table<OidcClient>
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={clients}
            pagination={false}
            scroll={{ x: 'max-content' }}
            className="hsa-table"
          />
        )}
      </div>

      <Modal
        open={modalOpen}
        title={editing ? `编辑客户端 ${editing.name}` : '新建 OIDC 客户端'}
        okText="保存"
        cancelText="取消"
        onOk={() => void submit()}
        onCancel={() => setModalOpen(false)}
        destroyOnClose
        width={620}
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="headscale" autoComplete="off" />
          </Form.Item>

          <Form.Item
            name="redirectUris"
            label="回调地址（每行一个）"
            rules={[{ required: true, message: '至少填一个回调地址' }]}
            extra="必须与下游配置完全一致（精确匹配，不做前缀/通配）。headscale 通常是 https://<域名>/oidc/callback"
          >
            <Input.TextArea rows={3} placeholder="https://hs.example.com/oidc/callback" className="font-mono !text-[12px]" />
          </Form.Item>

          <Form.Item name="postLogoutUris" label="登出回跳地址（每行一个，可选）">
            <Input.TextArea rows={2} placeholder="https://hs.example.com/" className="font-mono !text-[12px]" />
          </Form.Item>

          <Form.Item
            name="isPublic"
            label="Public client（无 secret）"
            valuePropName="checked"
            extra="开启后不发 secret，安全性完全依赖 PKCE。服务端到服务端对接一般用 confidential（关闭）"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            name="requirePkce"
            label="强制 PKCE"
            valuePropName="checked"
            extra="强烈建议开启：授权码走 query，可能进浏览器历史/代理日志；PKCE 让截到 code 也换不到 token"
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
