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

// ============================================================
// 监控统计（P4，数据来自 InfluxDB 时序库）
//
// ⚠️ 注意**没有流量相关类型**，这是刻意的：
// headscale 是控制面，数据面 WireGuard 流量不经过它，其 /metrics 与节点对象
// 均无流量字段。后端 /api/stats/traffic 明确返回 501，前端因此也不做流量图。
// ============================================================

/** /api/stats/health —— 时序库与采样器自检 */
export interface StatsHealth {
  ok: boolean;
  influx: { enabled: boolean; detail: string };
  sampler: {
    enabled: boolean;
    trackedNodes: number;
    recordedRounds: number;
    skippedRounds: number;
  };
  writer: {
    written: number;
    dropped: number;
    buffered: number;
    lastError: string | null;
    lastErrorAgoSec: number | null;
  };
  capabilities: {
    onlineStatus: boolean;
    onlineDuration: boolean;
    topology: boolean;
    aclMatrix: boolean;
    /** 恒为 false：当前架构下设备流量不可得 */
    deviceTraffic: boolean;
  };
  notes: { deviceTraffic: string };
}

/** 集群曲线上的一个点（一次采样） */
export interface ClusterPoint {
  t: string;
  nodesTotal: number | null;
  nodesOnline: number | null;
  nodesOffline: number | null;
  onlineRatio: number | null;
  routesAvailable: number | null;
  routesApproved: number | null;
}

export interface ClusterSeries {
  degraded: boolean;
  error?: string;
  hours: number;
  points: ClusterPoint[];
}

/** 单节点曲线上的一个点 */
export interface NodeSeriesPoint {
  t: string;
  online: boolean;
  onlineStreakSec: number | null;
  lastSeenAgeSec: number | null;
  routesAvailable: number | null;
  routesApproved: number | null;
}

/**
 * 在线时长统计。
 * gapSec 是**采样空洞**（面板重启/上游中断）——如实暴露，不做平滑。
 * onlineRatio 只按「实际覆盖到的区间」计算，不对空洞做假设。
 */
export interface NodeUptime {
  onlineSec: number;
  coveredSec: number;
  gapSec: number;
  sampleCount: number;
  onlineRatio: number | null;
}

export interface NodeSeries {
  degraded: boolean;
  error?: string;
  nodeId: number;
  hours: number;
  name: string | null;
  points: NodeSeriesPoint[];
  uptime?: NodeUptime;
}

/** /api/stats/overview —— 全节点 24h 聚合 */
export interface StatsOverviewNode {
  nodeId: number;
  name: string;
  lastOnline: boolean;
  sampleRatio: number | null;
  sampleCount: number;
  observedFrom: string;
  observedTo: string;
}

export interface StatsOverview {
  degraded: boolean;
  error?: string;
  windowHours: number;
  nodes: StatsOverviewNode[];
}

// ============================================================
// 网络拓扑（P4）
//
// 边来源：后端逐对调用 ACL 求值引擎（与「访问检查」同一套），
// 不是照抄策略文本——选择器展开、autogroup:self、出口节点、子网路由
// 这些语义手工画不准。
// ============================================================

export interface TopologyNode {
  id: number;
  name: string;
  displayName: string;
  ips: string[];
  online: boolean;
  expired: boolean;
  user: string | null;
  tags: string[];
  isExitNode: boolean;
  approvedRoutes: string[];
  /** 标签设备已脱离用户归属，展示上要区分 */
  identity: 'user' | 'tagged';
}

export interface TopologyEdge {
  from: number;
  to: number;
  ruleIndex: number | null;
  matchedSrc: string;
  matchedDst: string;
}

export interface TopologyResponse {
  /** allow-all / deny-all 时不画边，由 mode 表达结论 */
  mode: 'allow-all' | 'deny-all' | 'rules';
  explanation: string;
  highImpact: boolean;
  source: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  users: { name: string; deviceCount: number }[];
  stats: {
    nodeCount: number;
    consideredCount: number;
    pairEvaluated: number;
    allowedEdges: number;
    maxPairs: number;
    /** 设备过多导致逐对求值被截断——未算过的组合不会出现在图上 */
    truncated: boolean;
  };
  notes: { edges: string; traffic: string };
}

// ============================================================
// 面板自身控制面指标（方案 B）
//
// ⚠️ **不是设备流量**。设备流量在 headscale 架构下不可得。
// 这里统计面板自己的 API 吞吐、错误率、延迟、WS 推送量——
// 用于区分「上游 headscale 慢」与「面板自己慢」。
// ============================================================

export interface PanelMetrics {
  total: number;
  /** 最近 60 秒请求数 */
  rpm: number;
  status: { s2xx: number; s3xx: number; s4xx: number; s5xx: number };
  /** 5xx 占比（0~1）；无请求时为 null（不是 0——没样本不等于很健康） */
  errorRate: number | null;
  latency: { p50: number | null; p95: number | null; p99: number | null; samples: number };
  topRoutes: { route: string; count: number; errors: number; avgMs: number }[];
  uptimeSec: number;
  windowSec: number;
  ws: {
    clients: number;
    events: number;
    frames: number;
    /** 有事件但零帧 → 推了没人订阅 */
    noSubscriber: boolean;
  };
  scope: 'panel';
  disclaimer: string;
}

// ============================================================
// 资源中心（P5）
//
// 模型要点：`name` + `ip` → 同步进 ACL 的 hosts；
// `ports` / `protocol` **不进 hosts**（hosts 只承载 IP/CIDR），
// 只用于生成参考规则的 dst（`资源名:端口`）。
// ============================================================

export interface Resource {
  id: number;
  name: string;
  ip: string;
  ports: string[];
  protocol: string;
  description: string;
  ownerGroup: string | null;
  enabled: boolean;
  /** 最后一次写入 ACL hosts 的时间；改名/改 IP 后清空 */
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 生成规则时用的 dst 片段：name:port，或 name:* */
  dstForms: string[];
}

export interface ResourceListResponse {
  resources: Resource[];
  stats: { total: number; enabled: number; synced: number; unsynced: number };
}

export interface ResourceSyncPreview {
  hostDiff: {
    adds: { name: string; ip: string }[];
    updates: { name: string; from: string; to: string }[];
    conflicts: { name: string; existing: string; wanted: string; resourceId: number }[];
    orphans: string[];
  };
  referenceRules: {
    resource: string;
    ownerGroup: string;
    src: string[];
    dst: string[];
    protocol: string;
    /** 组内无成员绑定网络身份时为 false，生成不了 src */
    executable: boolean;
    note: string;
  }[];
  policy: {
    mode: 'allow-all' | 'deny-all' | 'rules';
    explanation: string;
    /** 非 rules 模式下 hosts 不会被引用，同步无效果 */
    hostsEffective: boolean;
    warning: string | null;
  };
  stats: {
    resources: number;
    enabled: number;
    toAdd: number;
    toUpdate: number;
    conflicts: number;
    orphans: number;
  };
}

// ============================================================
// DNS extra-records（P5）
//
// 硬约束（均实测确认）：
//   · 只支持 A / AAAA
//   · 非法 JSON 会让 headscale **启动失败**
//   · 运行时重载静默（无日志、无查询接口）→「已写入」≠「已可解析」
// ============================================================

export interface DnsRecord {
  id: number;
  name: string;
  type: string;
  value: string;
  comment: string;
  createdAt: string;
  updatedAt: string;
}

export interface DnsListResponse {
  records: DnsRecord[];
  path: string;
  stats: { total: number; a: number; aaaa: number };
}

export interface DnsStatus {
  path: string;
  exists: boolean;
  /** 文件是否是可解析的 JSON 数组；false 时 headscale 重启会失败 */
  valid: boolean;
  error: string | null;
  fileCount: number;
  dbCount: number;
  /** 文件与库不一致；valid=false 时为 null */
  drift: boolean | null;
  mtime: string | null;
  /** 文件里有、面板库里没有的条目（手改痕迹） */
  fileOnly: string[];
  constraints: {
    onlyAandAAAA: boolean;
    hotReload: string;
    invalidJsonIsFatal: string;
    silentReload: string;
  };
}

export interface DnsApplyResult {
  ok: boolean;
  path: string;
  count: number;
  /** 覆盖前文件里的条数 */
  replaced: number;
  note: string;
}
