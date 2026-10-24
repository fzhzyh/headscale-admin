/**
 * 登录页：口令 + TOTP 两步。
 *
 * 视觉：左侧品牌区（渐变 + 拓扑装饰）右侧表单，移动端堆叠。
 */
import { useEffect, useState } from 'react';
import { Form, Input, Button, Alert, Typography, App as AntApp } from 'antd';
import { UserOutlined, LockOutlined, SafetyOutlined } from '@ant-design/icons';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../store/auth';
import { errorText } from '../api/client';
import BrandPanel from '../components/BrandPanel';

const { Title, Text } = Typography;

export default function LoginPage(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntApp.useApp();
  const { login, verify2fa, user, ready } = useAuth();

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  // 已登录直接跳走，避免停留
  useEffect(() => {
    if (ready && user) navigate(from, { replace: true });
  }, [ready, user, navigate, from]);

  const onLogin = async (values: { username: string; password: string }): Promise<void> => {
    setLoading(true);
    setErr(null);
    try {
      const res = await login(values.username, values.password);
      if (res.need2fa && res.challengeId) {
        setChallenge(res.challengeId);
        message.info('请输入动态验证码');
      } else {
        message.success('登录成功');
        navigate(from, { replace: true });
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  const onVerify = async (values: { code: string }): Promise<void> => {
    if (!challenge) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await verify2fa(challenge, values.code);
      if (res.warn) message.warning(res.warn);
      message.success('登录成功');
      navigate(from, { replace: true });
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      <BrandPanel />

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[380px] animate-fade-in-up">
          <div className="mb-7">
            <Title level={3} className="!mb-1 !text-ink-900">
              {challenge ? '两步验证' : '登录控制台'}
            </Title>
            <Text type="secondary" className="text-[13px]">
              {challenge ? '请输入认证器生成的 6 位动态码，或使用恢复码' : 'Headscale 网络统一管理入口'}
            </Text>
          </div>

          {err && (
            <Alert
              type="error"
              message={err}
              showIcon
              closable
              onClose={() => setErr(null)}
              className="mb-5 animate-fade-in"
            />
          )}

          {!challenge ? (
            <Form layout="vertical" onFinish={onLogin} requiredMark={false} size="large" autoComplete="on">
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                <Input prefix={<UserOutlined className="text-ink-400" />} placeholder="用户名" autoFocus autoComplete="username" />
              </Form.Item>
              <Form.Item name="password" label="口令" rules={[{ required: true, message: '请输入口令' }]}>
                <Input.Password
                  prefix={<LockOutlined className="text-ink-400" />}
                  placeholder="口令"
                  autoComplete="current-password"
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large" className="!mt-1">
                登录
              </Button>
            </Form>
          ) : (
            <Form layout="vertical" onFinish={onVerify} requiredMark={false} size="large">
              <Form.Item
                name="code"
                label="动态码 / 恢复码"
                rules={[{ required: true, message: '请输入动态码或恢复码' }]}
              >
                <Input
                  prefix={<SafetyOutlined className="text-ink-400" />}
                  placeholder="6 位数字，或 XXXX-XXXX 恢复码"
                  autoFocus
                  autoComplete="one-time-code"
                  inputMode="text"
                  className="!font-mono !tracking-widest"
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={loading} block size="large" className="!mt-1">
                验证并登录
              </Button>
              <Button
                type="link"
                block
                className="!mt-2"
                onClick={() => {
                  setChallenge(null);
                  setErr(null);
                }}
              >
                返回重新输入口令
              </Button>
            </Form>
          )}

          <div className="mt-8 border-t border-ink-100 pt-4 text-[12px] leading-relaxed text-ink-400">
            面板账户与 Headscale 网络用户相互独立，可绑定管理多个网络身份。
            <br />
            连续登录失败会触发账户临时锁定。
          </div>
        </div>
      </div>
    </div>
  );
}
