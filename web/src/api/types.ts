/**
 * 后端返回的数据结构定义。
 * 字段与 server/src/routes/*.ts 的响应保持一致。
 */

export interface SessionInfo {
  authenticated: boolean;
  user?: {
    id: number;
    username: string;
    displayName: string | null;
    email: string | null;
    isSuperuser: boolean;
    mustChangePassword: boolean;
    totpEnabled: boolean;
  };
  csrfToken?: string;
  permissions?: string[];
}

export interface LoginResponse {
  ok?: boolean;
  need2fa?: boolean;
  challengeId?: string;
  user?: { id: number; username: string };
  csrfToken?: string;
  mustChangePassword?: boolean;
  warn?: string;
}

export interface ConnectionTest {
  ok: boolean;
  transport: string;
  address: string;
  hasApiKey: boolean;
  databaseConnectivity?: boolean;
  latencyMs?: number;
  error?: string;
  errorCode?: string;
  checkedAt: string;
  diagnosis?: string[];
}

export interface OverviewStats {
  hsNodes: number;
  hsNodesOnline: number;
  hsNodesOffline: number;
  hsUsers: number;
  routeEnabled: number;
  routeAvailable: number;
  expiringSoon: number;
  expired: number;
  panelUsers: number;
  panelGroups: number;
  resources: number;
  dnsRecords: number;
  aclVersions: number;
  oauthClients: number;
}

export interface Overview {
  connection: ConnectionTest;
  upstreamError: string | null;
  stats: OverviewStats;
  lastSyncAt: string | null;
}

export interface NodeUser {
  id: number;
  name: string;
  displayName: string | null;
}

export interface HsNode {
  id: number;
  name: string;
  givenName: string;
  displayName: string;
  renamed: boolean;
  user: NodeUser | null;
  ipAddresses: string[];
  tags: string[];
  online: boolean;
  lastSeen: string | null;
  lastSeenAgoSec: number | null;
  createdAt: string | null;
  expiry: string | null;
  expiryRaw: string | null;
  neverExpires: boolean;
  expired: boolean;
  expiresInSec: number | null;
  approvedRoutes: string[];
  availableRoutes: string[];
  subnetRoutes: string[];
  registerMethod: string | null;
  machineKey: string;
  nodeKey: string;
  preAuthKeyPrefix: string | null;
}

export interface NodeListResponse {
  total: number;
  nodes: HsNode[];
  facets: { users: string[]; tags: string[] };
}

export interface RouteRow {
  nodeId: number;
  nodeName: string;
  userName: string | null;
  online: boolean;
  route: string;
  approved: boolean;
  isExit: boolean;
}

export interface RouteListResponse {
  total: number;
  enabled: number;
  routes: RouteRow[];
}

export interface HsUser {
  id: number;
  name: string;
  displayName: string | null;
  email: string | null;
  provider: string | null;
  providerId: string | null;
  profilePicUrl: string | null;
  createdAt: string | null;
}

export interface PreAuthKey {
  id: number;
  key: string;
  user: { id: number; name: string } | null;
  reusable: boolean;
  ephemeral: boolean;
  used: boolean;
  aclTags: string[];
  expiration: string | null;
  createdAt: string | null;
  expired: boolean;
  expiresInSec: number | null;
}

export interface ApiKeyRow {
  id: number;
  prefix: string;
  expiration: string | null;
  createdAt: string | null;
  lastSeen: string | null;
  lastSeenAgoSec: number | null;
  expired: boolean;
}

export interface PanelUser {
  id: number;
  username: string;
  displayName: string | null;
  email: string | null;
  isSuperuser: boolean;
  isActive: boolean;
  totpEnabled: boolean;
  mustChangePassword: boolean;
  authSource: string;
  lastLoginAt: string | null;
  createdAt: string;
  groups: { id: number; name: string }[];
  hsUsers: { id: number; name: string }[];
}

export interface PanelGroup {
  id: number;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  createdAt: string;
  permissions: string[];
  memberCount: number;
}

export interface GroupListResponse {
  catalog: Record<string, string>;
  allPermissions: string[];
  groups: PanelGroup[];
}

export interface SettingItem {
  key: string;
  label: string;
  group: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  options?: string[];
  hint?: string;
  value: string | null;
  configured: boolean;
}

export interface AuditRow {
  id: number;
  ts: string;
  username: string | null;
  ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  result: string;
  detail: string | null;
}

/** WebSocket 事件 */
export interface WsMessage {
  type: string;
  ts: string;
  changed?: string[];
  data?: unknown;
  message?: string;
}
