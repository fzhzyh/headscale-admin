-- ============================================================
-- headscale-admin 面板自身数据库结构（SQLite）
-- 注意：面板库与 Headscale 库完全隔离，面板从不直接读写 headscale 的库
-- ============================================================

-- ---------- 迁移版本 ----------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- ============================================================
-- 一、面板账户与认证
-- ============================================================

CREATE TABLE IF NOT EXISTS panel_users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE,
  display_name      TEXT,
  email             TEXT,
  pwd_hash          TEXT    NOT NULL,
  is_superuser      INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  -- TOTP 两步验证：密钥加密存储，仅开启后写值
  totp_secret       TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  -- 恢复码：只存 bcrypt 哈希，JSON 数组
  recovery_codes    TEXT,
  must_change_pwd   INTEGER NOT NULL DEFAULT 0,
  -- 外部 OIDC 登录身份（与本地口令可并存）
  external_issuer   TEXT,
  external_subject  TEXT,
  auth_source       TEXT    NOT NULL DEFAULT 'local',   -- local | oidc
  last_login_at     TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_panel_users_ext
  ON panel_users(external_issuer, external_subject)
  WHERE external_subject IS NOT NULL;

-- 服务端会话（登出/禁用可立即失效，比纯 JWT 可控）
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  csrf_token   TEXT    NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT    NOT NULL,
  expires_at   TEXT    NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_exp  ON sessions(expires_at);

-- 登录尝试（限流与锁定依据）
CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT    NOT NULL,
  ip          TEXT,
  success     INTEGER NOT NULL,
  reason      TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_login_attempts ON login_attempts(username, created_at);

-- ============================================================
-- 二、RBAC 权限模型
-- ============================================================

CREATE TABLE IF NOT EXISTS panel_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- 细粒度权限串，如 node:read / acl:write / settings:write
CREATE TABLE IF NOT EXISTS panel_group_permissions (
  group_id   INTEGER NOT NULL REFERENCES panel_groups(id) ON DELETE CASCADE,
  permission TEXT    NOT NULL,
  PRIMARY KEY (group_id, permission)
);

CREATE TABLE IF NOT EXISTS panel_user_groups (
  user_id    INTEGER NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL REFERENCES panel_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

-- 面板账户 ↔ Headscale 用户 绑定（一个面板账户可绑多个网络身份）
CREATE TABLE IF NOT EXISTS panel_user_hs_users (
  user_id       INTEGER NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  hs_user_id    INTEGER NOT NULL,
  hs_user_name  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  PRIMARY KEY (user_id, hs_user_id)
);

-- ============================================================
-- 三、审计日志
-- ============================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  user_id     INTEGER,
  username    TEXT,
  ip          TEXT,
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  result      TEXT    NOT NULL DEFAULT 'ok',   -- ok | error
  detail      TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_ts     ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs(action);

-- ============================================================
-- 四、ACL 策略版本历史
-- ============================================================

CREATE TABLE IF NOT EXISTS acl_versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  content       TEXT    NOT NULL,          -- HuJSON 原文
  comment       TEXT,
  source        TEXT    NOT NULL DEFAULT 'manual', -- manual | yaml-editor | ai | sync | rollback
  author_id     INTEGER,
  author_name   TEXT,
  -- 是否已成功推送到 headscale
  applied       INTEGER NOT NULL DEFAULT 0,
  apply_error   TEXT,
  hs_updated_at TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_acl_versions_ts ON acl_versions(created_at DESC);

-- ============================================================
-- 五、资源中心（ACL 主机别名来源）
-- ============================================================

CREATE TABLE IF NOT EXISTS resources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,    -- 资源名，同步为 ACL hosts 的键
  ip            TEXT    NOT NULL,           -- IP 或已有 host 别名
  ports         TEXT,                       -- JSON 数组，如 [22,443] 或 ["8000-8100"]
  protocol      TEXT    NOT NULL DEFAULT 'tcp',
  description   TEXT,
  owner_group   TEXT,                       -- 面板组的 durable 标识，用于访问控制
  enabled       INTEGER NOT NULL DEFAULT 1,
  synced_at     TEXT,                       -- 最后一次同步进 ACL 的时间
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL
);

-- ============================================================
-- 六、DNS extra_records 本地镜像
-- ============================================================

CREATE TABLE IF NOT EXISTS dns_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  type        TEXT    NOT NULL,             -- A | AAAA
  value       TEXT    NOT NULL,
  comment     TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  UNIQUE (name, type)
);

-- ============================================================
-- 七、内置 OIDC Provider：客户端与授权码
-- ============================================================

CREATE TABLE IF NOT EXISTS oauth_clients (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id          TEXT    NOT NULL UNIQUE,
  client_secret_hash TEXT,                  -- bcrypt；public client 为空
  name               TEXT    NOT NULL,
  redirect_uris      TEXT    NOT NULL,      -- JSON 数组
  post_logout_uris   TEXT,                  -- JSON 数组
  scopes             TEXT    NOT NULL DEFAULT '["openid","profile","email","groups"]',
  grant_types        TEXT    NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  is_public          INTEGER NOT NULL DEFAULT 0,
  require_pkce       INTEGER NOT NULL DEFAULT 1,
  enabled            INTEGER NOT NULL DEFAULT 1,
  secret_prefix      TEXT,                  -- 展示用，如 oidc_ab12
  secret_rotated_at  TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code                  TEXT    PRIMARY KEY,
  client_id             TEXT    NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id               INTEGER NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  redirect_uri          TEXT    NOT NULL,
  scope                 TEXT    NOT NULL,
  nonce                 TEXT,
  code_challenge        TEXT,
  code_challenge_method TEXT,
  auth_time             TEXT    NOT NULL,
  expires_at            TEXT    NOT NULL,
  consumed_at           TEXT
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token       TEXT    PRIMARY KEY,
  client_id   TEXT    NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES panel_users(id) ON DELETE CASCADE,
  scope       TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  revoked_at  TEXT
);

-- OIDC 签名密钥（RS256），支持轮换
CREATE TABLE IF NOT EXISTS oidc_keys (
  kid           TEXT    PRIMARY KEY,
  alg           TEXT    NOT NULL DEFAULT 'RS256',
  public_jwk    TEXT    NOT NULL,
  private_jwk   TEXT    NOT NULL,           -- 加密存储
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL,
  retired_at    TEXT
);

-- ============================================================
-- 八、设置（键值，敏感值加密）
-- ============================================================

CREATE TABLE IF NOT EXISTS settings (
  key          TEXT    PRIMARY KEY,
  value        TEXT,
  is_encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT    NOT NULL
);

-- ============================================================
-- 九、时序数据降级表（未配置 InfluxDB 时使用）
-- ============================================================

CREATE TABLE IF NOT EXISTS metric_points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT    NOT NULL,
  measurement TEXT    NOT NULL,
  tags        TEXT    NOT NULL DEFAULT '{}',
  fields      TEXT    NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS ix_metric_points ON metric_points(measurement, ts DESC);

-- 节点在线会话（在线时长统计的事实表）
CREATE TABLE IF NOT EXISTS node_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id     INTEGER NOT NULL,
  node_name   TEXT,
  user_name   TEXT,
  started_at  TEXT    NOT NULL,
  ended_at    TEXT,
  duration_s  INTEGER,
  last_ip     TEXT
);
CREATE INDEX IF NOT EXISTS ix_node_sessions ON node_sessions(node_id, started_at DESC);

-- ============================================================
-- 十、同步元数据
-- ============================================================

CREATE TABLE IF NOT EXISTS sync_state (
  key         TEXT    PRIMARY KEY,
  value       TEXT,
  updated_at  TEXT    NOT NULL
);
