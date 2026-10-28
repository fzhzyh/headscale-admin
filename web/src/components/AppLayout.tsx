/**
 * 应用外壳：侧边导航 + 顶栏 + 内容区。
 *
 * 布局用 Tailwind（骨架/配色/动画），复杂交互组件用 antd（Menu/Tooltip/Dropdown）。
 * 实时连接状态在顶栏可见，避免用户「以为页面是实时的」。
 */
import { useMemo } from 'react';
import { Layout, Menu, Dropdown, Avatar, Tag, Tooltip, Badge, App as AntApp } from 'antd';
import {
  DashboardOutlined,
  ClusterOutlined,
  PartitionOutlined,
  TeamOutlined,
  KeyOutlined,
  SafetyCertificateOutlined,
  UserOutlined,
  ApiOutlined,
  SettingOutlined,
  FileSearchOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  WifiOutlined,
  DisconnectOutlined,
  ApartmentOutlined,
  DatabaseOutlined,
  GlobalOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { useAuth } from '../store/auth';
import { useRealtime } from '../hooks/useRealtime';
import type { WsMessage } from '../api/types';

const { Header, Sider, Content } = Layout;

interface NavItem {
  key: string;
  label: string;
  icon: React.ReactNode;
  /** 需要的权限（任一即可）；不填表示登录即可见 */
  perms?: string[];
  group: string;
}

const NAV: NavItem[] = [
  { key: '/dashboard', label: '控制台', icon: <DashboardOutlined />, group: '概览', perms: ['node:read'] },
  { key: '/nodes', label: '设备管理', icon: <ClusterOutlined />, group: '网络', perms: ['node:read'] },
  { key: '/topology', label: '网络拓扑', icon: <ApartmentOutlined />, group: '网络', perms: ['node:read'] },
  { key: '/resources', label: '资源中心', icon: <DatabaseOutlined />, group: '网络', perms: ['resource:read'] },
  { key: '/routes', label: '路由管理', icon: <PartitionOutlined />, group: '网络', perms: ['route:read'] },
  { key: '/users', label: '网络用户', icon: <TeamOutlined />, group: '网络', perms: ['user:read'] },
  { key: '/acl', label: 'ACL 管理', icon: <SafetyCertificateOutlined />, group: '网络', perms: ['acl:read'] },
  { key: '/dns', label: 'DNS 记录', icon: <GlobalOutlined />, group: '网络', perms: ['dns:read'] },
  { key: '/keys', label: '密钥管理', icon: <KeyOutlined />, group: '网络', perms: ['preauthkey:read', 'apikey:read'] },
  { key: '/connect', label: '快速连接', icon: <ApiOutlined />, group: '网络', perms: ['node:read'] },
  { key: '/panel-users', label: '面板账户', icon: <UserOutlined />, group: '治理', perms: ['paneluser:read', 'group:read'] },
  { key: '/audit', label: '审计日志', icon: <FileSearchOutlined />, group: '治理', perms: ['audit:read'] },
  { key: '/settings', label: '系统设置', icon: <SettingOutlined />, group: '治理', perms: ['settings:read'] },
];

export default function AppLayout(): React.ReactElement {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const { user, canAny, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);

  /**
   * 小屏自动收起侧栏。
   * 固定 224px 侧栏 + 内容左边距会撑破移动端视口（实测 390px 宽时溢出到 446px）。
   */
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const apply = (narrow: boolean): void => {
      if (narrow) setCollapsed(true);
    };
    apply(mq.matches);
    const onChange = (e: MediaQueryListEvent): void => apply(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // WebSocket：收到变更事件就失效相关缓存，让 react-query 自动重取
  const handleWsMessage = useMemo(
    () => (msg: WsMessage) => {
      switch (msg.type) {
        case 'nodes.changed':
        case 'users.changed':
          void qc.invalidateQueries({ queryKey: ['nodes'] });
          void qc.invalidateQueries({ queryKey: ['hs-users'] });
          void qc.invalidateQueries({ queryKey: ['overview'] });
          break;
        case 'routes.changed':
          void qc.invalidateQueries({ queryKey: ['routes'] });
          break;
        case 'stats':
          void qc.invalidateQueries({ queryKey: ['overview'] });
          break;
        case 'error':
          message.error(msg.message ?? '实时通道异常');
          break;
      }
    },
    [qc, message],
  );

  const realtime = useRealtime({ enabled: Boolean(user), onMessage: handleWsMessage });

  const visibleNav = NAV.filter((n) => !n.perms || canAny(...n.perms));

  // 按 group 分节，Menu 的 items 支持嵌套
  const menuItems = useMemo(() => {
    const groups = new Map<string, NavItem[]>();
    for (const n of visibleNav) {
      if (!groups.has(n.group)) groups.set(n.group, []);
      groups.get(n.group)!.push(n);
    }
    return Array.from(groups.entries()).map(([label, items]) => ({
      key: `g:${label}`,
      type: 'group' as const,
      label: collapsed ? '' : <span className="px-2 text-[11px] font-medium tracking-wide text-ink-400">{label}</span>,
      children: items.map((i) => ({ key: i.key, icon: i.icon, label: i.label })),
    }));
  }, [visibleNav, collapsed]);

  const selectedKey = visibleNav
    .map((n) => n.key)
    .filter((k) => location.pathname === k || location.pathname.startsWith(`${k}/`))
    .sort((a, b) => b.length - a.length)[0];

  const statusTag = (() => {
    if (realtime.status === 'open') {
      return (
        <Tooltip title={`实时推送已连接${realtime.lastEventAt ? `，最后事件 ${new Date(realtime.lastEventAt).toLocaleTimeString('zh-CN')}` : ''}${realtime.pollIntervalSec ? `；服务端每 ${realtime.pollIntervalSec}s 采样一次` : ''}`}>
          <Tag icon={<WifiOutlined />} color="success" className="!mr-0">
            实时
          </Tag>
        </Tooltip>
      );
    }
    if (realtime.status === 'connecting') {
      return (
        <Tooltip title="正在建立实时通道…">
          <Tag icon={<DisconnectOutlined />} color="processing" className="!mr-0">
            连接中
          </Tag>
        </Tooltip>
      );
    }
    return (
      <Tooltip title="实时通道已断开，数据可能不是最新的；页面仍可手动刷新">
        <Tag icon={<DisconnectOutlined />} color="default" className="!mr-0">
          离线
        </Tag>
      </Tooltip>
    );
  })();

  return (
    <Layout className="min-h-screen">
      <Sider
        theme="light"
        width={224}
        collapsedWidth={64}
        collapsed={collapsed}
        className="!fixed left-0 top-0 z-20 h-screen overflow-auto border-r border-ink-200/70 !bg-white/95 backdrop-blur"
      >
        {/* Logo */}
        <div className="flex h-14 items-center gap-2.5 border-b border-ink-100 px-4">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-[13px] font-bold text-white shadow-sm">
            HS
          </div>
          {!collapsed && (
            <div className="min-w-0 animate-fade-in">
              <div className="truncate text-[13.5px] font-semibold leading-tight text-ink-800">Headscale</div>
              <div className="truncate text-[11px] leading-tight text-ink-400">网络控制台</div>
            </div>
          )}
        </div>

        <Menu
          mode="inline"
          selectedKeys={selectedKey ? [selectedKey] : []}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          className="!border-0 !bg-transparent pb-4 pt-2"
        />
      </Sider>

      <Layout style={{ marginLeft: collapsed ? 64 : 224, transition: 'margin-left 0.2s cubic-bezier(0.22,1,0.36,1)' }}>
        <Header className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 border-b border-ink-200/70 !px-3 backdrop-blur sm:!px-5">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent text-ink-500 transition-colors hover:bg-ink-100 hover:text-brand-600"
              aria-label={collapsed ? '展开导航' : '收起导航'}
            >
              {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
            </button>
            <div className="hidden truncate text-[13px] text-ink-500 sm:block">
              {visibleNav.find((n) => n.key === selectedKey)?.label ?? '控制台'}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {statusTag}
            <Dropdown
              placement="bottomRight"
              menu={{
                items: [
                  {
                    key: 'who',
                    label: (
                      <div className="px-1 py-1">
                        <div className="text-[13px] font-medium text-ink-800">{user?.displayName || user?.username}</div>
                        <div className="text-[11.5px] text-ink-400">
                          {user?.isSuperuser ? '超级管理员' : '受限账户'}
                          {user?.totpEnabled ? ' · 已启用 2FA' : ''}
                        </div>
                      </div>
                    ),
                    disabled: true,
                  },
                  { type: 'divider' },
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: '退出登录',
                    onClick: () => {
                      void logout().then(() => navigate('/login', { replace: true }));
                    },
                  },
                ],
              }}
            >
              <button
                type="button"
                className="flex items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 py-1 transition-colors hover:bg-ink-100"
              >
                <Badge dot={Boolean(user?.mustChangePassword)} offset={[-2, 2]}>
                  <Avatar size={28} className="!bg-gradient-to-br !from-brand-500 !to-brand-700 text-[12px]">
                    {(user?.displayName || user?.username || '?').slice(0, 1).toUpperCase()}
                  </Avatar>
                </Badge>
                <span className="hidden text-[13px] text-ink-700 sm:inline">{user?.username}</span>
              </button>
            </Dropdown>
          </div>
        </Header>

        <Content className="overflow-x-hidden p-3 sm:p-4 lg:p-5">
          <div key={location.pathname} className="hsa-enter mx-auto w-full max-w-[1600px]">
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
