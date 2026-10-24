/**
 * RBAC 权限模型。
 *
 * 设计取舍：不引入 casbin 之类的通用引擎，用「静态权限目录 + 组内权限集合取并集」。
 * 理由：权限点数量有限且稳定，显式目录可读性远好于策略表达式，审计时也能一眼看清谁有什么。
 */

/** 权限目录：所有可用权限点。新增功能时在此登记，UI 会自动列出来 */
export const PERMISSIONS = {
  'node:read': '查看设备列表与详情',
  'node:write': '重命名/删除/过期/打标签/注册设备',
  'route:read': '查看子网路由',
  'route:write': '启用或禁用子网路由',
  'user:read': '查看 Headscale 用户',
  'user:write': '创建/重命名/删除 Headscale 用户',
  'preauthkey:read': '查看预授权密钥',
  'preauthkey:write': '创建/过期/删除预授权密钥',
  'apikey:read': '查看 Headscale API Key',
  'apikey:write': '创建/过期/删除 Headscale API Key',
  'acl:read': '查看 ACL 策略与版本历史',
  'acl:write': '编辑 ACL 策略（含可视化/原始/AI 生成）',
  'acl:apply': '将 ACL 策略推送到 Headscale（高危）',
  'dns:read': '查看 DNS 额外记录',
  'dns:write': '管理 DNS 额外记录',
  'resource:read': '查看资源中心',
  'resource:write': '管理资源中心并同步到 ACL',
  'metric:read': '查看监控统计与拓扑',
  'paneluser:read': '查看面板账户',
  'paneluser:write': '创建/禁用/删除面板账户，重置密码与 2FA',
  'group:read': '查看用户组与权限',
  'group:write': '创建/编辑用户组与权限分配',
  'oidc:read': '查看 OIDC 客户端与配置',
  'oidc:write': '管理 OIDC 客户端与密钥轮换',
  'settings:read': '查看系统设置',
  'settings:write': '修改系统设置与同步数据（高危）',
  'audit:read': '查看审计日志',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** 内置角色模板：初始化时写入 panel_groups，可被管理员二次调整 */
export interface BuiltinRole {
  name: string;
  description: string;
  permissions: Permission[];
}

export const BUILTIN_ROLES: BuiltinRole[] = [
  {
    name: '超级管理员',
    description: '系统内置，拥有全部权限，不可删除',
    permissions: ALL_PERMISSIONS,
  },
  {
    name: '网络管理员',
    description: '负责组网与节点日常运维，不含账户与系统设置',
    permissions: [
      'node:read',
      'node:write',
      'route:read',
      'route:write',
      'user:read',
      'preauthkey:read',
      'preauthkey:write',
      'acl:read',
      'dns:read',
      'resource:read',
      'metric:read',
      'audit:read',
    ],
  },
  {
    name: '策略管理员',
    description: '负责 ACL 策略与资源中心，可编辑并推送策略',
    permissions: [
      'node:read',
      'route:read',
      'user:read',
      'acl:read',
      'acl:write',
      'acl:apply',
      'resource:read',
      'resource:write',
      'dns:read',
      'metric:read',
    ],
  },
  {
    name: '只读审计',
    description: '仅可查看，适合审计与巡检场景',
    permissions: [
      'node:read',
      'route:read',
      'user:read',
      'preauthkey:read',
      'acl:read',
      'dns:read',
      'resource:read',
      'metric:read',
      'paneluser:read',
      'group:read',
      'oidc:read',
      'settings:read',
      'audit:read',
    ],
  },
];

/** 权限分组，供 UI 分栏展示 */
export const PERMISSION_GROUPS: { label: string; prefix: string }[] = [
  { label: '设备与路由', prefix: 'node' },
  { label: '用户与密钥', prefix: 'user' },
  { label: 'ACL 策略', prefix: 'acl' },
  { label: 'DNS 与资源', prefix: 'dns' },
  { label: '监控统计', prefix: 'metric' },
  { label: '面板治理', prefix: 'paneluser' },
  { label: '系统设置', prefix: 'settings' },
];
