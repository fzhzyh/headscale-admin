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
  /**
   * 是否已由「用户身份」转为「标签身份」（headscale 的 tags-as-identity 语义）。
   * 为 true 时该设备已脱离原用户归属：user@ 形式的 ACL 规则不再命中它，
   * 只能用 tag: / autogroup:tagged 引用。此转换不可逆。
   */
  taggedIdentity: boolean;
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

// ============================================================
// ACL 策略（v0.29.6）
// 注意：`acls` 键「不存在」与「为空数组」语义完全相反 —— 前者全通、后者全禁。
// 因此类型里所有可选字段都必须允许 undefined，前端绝不能把它们归一化成 []。
// ============================================================

export type AclAction = 'accept';

export interface AclRule {
  action: AclAction;
  proto: string;
  src: string[];
  dst: string[];
}

export interface SshRule {
  action: 'accept' | 'check' | 'deny';
  src: string[];
  dst: string[];
  users: string[];
}

export interface NodeAttrGrant {
  target: string[];
  attr?: string[];
  ipPool?: string[];
}

export interface AutoApprovers {
  routes?: Record<string, string[]>;
  exitNode?: string[];
}

export interface AclPolicy {
  acls?: AclRule[];
  grants?: unknown[];
  ssh?: SshRule[];
  groups?: Record<string, string[]>;
  hosts?: Record<string, string>;
  tagOwners?: Record<string, string[]>;
  nodeAttrs?: NodeAttrGrant[];
  autoApprovers?: AutoApprovers;
  randomizeClientPort?: boolean;
}

export interface AclValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
  hint?: string;
}

export interface AclValidationStats {
  acls: number;
  grants: number;
  ssh: number;
  groups: number;
  hosts: number;
  tagOwners: number;
  nodeAttrs: number;
  autoApproverRoutes: number;
  autoApproverExitNodes: number;
  bytes: number;
}

export interface AclValidation {
  ok: boolean;
  issues: AclValidationIssue[];
  stats: AclValidationStats;
}

export interface AclInterpretation {
  mode: 'allow-all' | 'deny-all' | 'rules';
  explanation: string;
  /** 高危模式（全通/全禁），应用前需显式确认 */
  highImpact: boolean;
}

export interface AclDrift {
  drifted: boolean;
  explanation: string | null;
  hsUpdatedAt: string | null;
  lastAppliedVersionId: number | null;
  lastAppliedAt: string | null;
}

export interface AclPolicyResponse {
  content: string;
  normalized: string | null;
  parsed: AclPolicy | null;
  parseError: string | null;
  hsUpdatedAt: string | null;
  interpretation: AclInterpretation;
  validation: AclValidation;
  drift: AclDrift;
  canApply: boolean;
}

export interface AclVersion {
  id: number;
  content: string;
  comment: string | null;
  source: 'manual' | 'visual-editor' | 'ai' | 'rollback' | 'import';
  applied: boolean;
  applyError: string | null;
  hsUpdatedAt: string | null;
  createdAt: string;
  authorName: string | null;
  summary: AclValidationStats;
}

export interface AclVersionListResponse {
  total: number;
  versions: AclVersion[];
}

export interface AclDiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
  leftNo: number | null;
  rightNo: number | null;
}

export interface AclDiffResponse {
  from: AclVersion;
  to: AclVersion;
  lines: AclDiffLine[];
}

export type AclCheckSide =
  | { nodeId: number }
  | { cidr: string }
  | { user: string }
  | { tag: string }
  | { internet: true };

export interface AclCheckResult {
  allowed: boolean;
  reason: string;
  explanation: string;
  matched: { rule: string; index: number; side: 'acl' | 'ssh' }[];
  trace: string[];
  error?: string | null;
  source?: string;
}

export interface AclContext {
  users: { id: number; name: string; token: string }[];
  nodes: { id: number; name: string; userName: string | null; ips: string[]; tags: string[]; neverExpires: boolean }[];
  tags: string[];
  groups: string[];
  hosts: string[];
  routes: string[];
  autogroups: { src: string[]; dst: string[] };
  protocols: string[];
}
