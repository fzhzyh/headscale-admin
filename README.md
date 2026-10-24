# headscale-admin

基于 **Headscale v0.29.6** 的 Web 管理面板。应用 / 系统 / 网络三层统一运维入口。

> 所有 API 用法均在真实 headscale v0.29.6 实例上实测验证，踩坑记录见
> [`docs/headscale-v0.29-api-notes.md`](docs/headscale-v0.29-api-notes.md)。

---

## 能力边界（先说清楚，不夸大）

headscale 本身做不到的事，本面板不会假装能做：

| 需求 | 现实 | 面板做法 |
|------|------|---------|
| 设备/用户/密钥/路由/ACL 管理 | ✅ API 完整 | 直接对接 REST `/api/v1/*` |
| ACL 访问检查 | ⚠️ `policy/check` 只校验语法语义 | 面板自研规则求值引擎 |
| ACL 版本历史 | ❌ 无 API | 面板自建版本库 |
| 实时推送 | ❌ 无流式 API | 面板轮询上游 + WebSocket 扇出 |
| DNS extra_records | ⚠️ 无写 API，但 v0.29 有 fsnotify 文件监听 | 写文件 → 热生效 |
| 每节点流量字节 | ❌ headscale 不转发数据，物理上统计不到 | 可插拔采集：节点侧 metrics + 外部 NetFlow/sFlow 入库接口 |
| 在线时长 | ⚠️ 可从 `online` 状态迁移推算 | 采样器 + InfluxDB，精度 = 采样间隔 |

---

## 架构

```
浏览器 (React SPA)
   │  REST + Cookie        WebSocket
   ▼                          ▼
┌──────────────────────────────────────────┐
│  headscale-admin 面板 (Fastify + Node)    │
│  ├─ 会话/RBAC/2FA    ├─ ACL 引擎与版本库   │
│  ├─ WS Hub           ├─ 状态采样器         │
│  └─ 内置 OIDC Provider├─ 资源中心          │
└────┬──────────────┬──────────────┬────────┘
     │ REST         │ 写文件        │ line protocol
     ▼              ▼              ▼
 Headscale      extra-records   InfluxDB 2.x
 v0.29.6       (fsnotify 热加载)  (未配置则降级 SQLite)
```

## 技术选型与取舍

| 层 | 选型 | 理由 / 取舍 |
|----|------|------------|
| 后端 | Node 22 + TypeScript + Fastify | 全栈同语言；管理面低 QPS，Node 够用。放弃 Go：功能广度上开发效率差距太大 |
| 面板库 | Node 内置 `node:sqlite` | **零原生编译依赖**（国内网络下 better-sqlite3 的 prebuild 常下载失败）。代价：Node 22 中标记 experimental，故用仓储层封装，将来可无痛换 Postgres |
| 时序库 | InfluxDB 2.7（line protocol） | 写入量大、读模式是聚合查询。未配置时自动降级 SQLite，功能不中断 |
| 前端 | React 18 + Vite + Tailwind + Recharts + React Flow | 对应拓扑可视化与图表诉求 |
| 认证 | 服务端 Session + bcrypt + TOTP + jose | 选 Session 而非纯 JWT：换取「可撤销」（禁用账户/改密立即踢下线） |
| 传输 | REST（`/api/v1/*`） | 实测确认不需要 gRPC；gRPC 作为备选保留 |

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 准备配置
cp .env.example server/.env
$EDITOR server/.env          # 至少填 PANEL_ADMIN_SECRET 与 HS_API_KEY

# 3. 初始化数据库（含内置角色 + 初始管理员）
npm run migrate

# 4. 启动（生产用 npm run build && npm start）
npm run dev:server           # http://127.0.0.1:8080
```

获取 Headscale API Key：

```bash
headscale apikeys create --expiration 90d
# 输出 hskey-api-xxxxxxxx_yyyyyyyy...，填进 server/.env 的 HS_API_KEY
```

### 关键环境变量

| 变量 | 说明 |
|------|------|
| `PANEL_MASTER_KEY` | 加密落库敏感字段（Headscale API Key、TOTP 密钥、OIDC 私钥）。留空自动生成到 `data/master.key`（600） |
| `PANEL_ADMIN_SECRET` | 首次启动创建管理员的口令；留空则随机生成并打印到日志一次 |
| `HS_URL` | Headscale 的 `listen_addr`，**不是** `grpc_listen_addr` |
| `HS_EXTRA_RECORDS_PATH` | 与 headscale 配置 `dns.extra_records_path` 保持一致，用于 DNS 热加载 |
| `INFLUX_*` | 留空则降级 SQLite |

---

## 安全设计

1. **API Key 加密落库**：AES-256-GCM，保存后永不回显明文，前端只见 `hskey-••••••••`
2. **会话可撤销**：禁用账户 / 改密 / 重置 2FA 立即踢掉该用户全部会话
3. **CSRF 强制**：所有写操作校验 `X-CSRF-Token`，缺失或错误一律 403
4. **登录防爆破**：失败计数 + 时间窗锁定；用户不存在与口令错误返回**同一提示**，不泄露账号是否存在
5. **自我保护护栏**：不能停用/降级/删除当前登录账户；不能移除最后一个超级管理员；不能删除面板正在用的 API Key（否则自锁）
6. **变更三要素**：危险写操作（删除设备/用户、强制批准未通告路由、启停出口路由）需显式确认，并留审计
7. **审计留痕**：所有变更记录操作人 / IP / 时间 / 前后值；敏感字段只记「已变更」不记值
8. **最小权限**：26 个细粒度权限点，4 个内置角色，组权限取并集

---

## 权限模型

权限点按功能域划分：`node:*` `route:*` `user:*` `preauthkey:*` `apikey:*`
`acl:*` `dns:*` `resource:*` `metric:*` `paneluser:*` `group:*` `oidc:*` `settings:*` `audit:*`

内置角色：

| 角色 | 范围 |
|------|------|
| 超级管理员 | 全部权限（不可裁剪，防止锁死系统） |
| 网络管理员 | 设备与路由日常运维，不含账户与系统设置 |
| 策略管理员 | ACL 策略与资源中心，可编辑并推送策略 |
| 只读审计 | 仅查看，适合审计与巡检 |

面板账户与 Headscale 用户**多对多绑定**，一个人可管理多个网络身份。

---

## 交付进度

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P1** | 仓库骨架、加密存储、Headscale REST 客户端、认证/RBAC/2FA、审计、设备/用户/密钥/路由/设置 | ✅ 已完成，54 项端到端用例全通过 |
| **P2** | WebSocket 实时推送、前端 SPA（控制台、设备、用户、密钥页） | 待开发 |
| **P3** | ACL 引擎：可视化编辑、原始 HuJSON、版本历史、访问检查求值器、AI 辅助 | 待开发 |
| **P4** | 监控：状态采样器、InfluxDB 写入、在线时长、拓扑图、ACL 访问矩阵 | 待开发 |
| **P5** | 资源中心、DNS 热加载、内置 OIDC Provider、外部 OIDC 登录 | 待开发 |

### P1 已验证内容（对真实 headscale v0.29.6）

认证链路、会话、CSRF 拦截、RBAC 越权拦截、上游数据透传与字段归一化、
设备重命名/过期/标签、路由启停与护栏、预授权密钥、审计、设置掩码回显。
完整用例见 `lab/e2e_panel.py`。

---

## 目录结构

```
├── server/                     # Fastify 后端
│   └── src/
│       ├── app.ts              # 应用装配（插件 → 鉴权 → 路由 → 错误归一）
│       ├── config.ts           # 配置加载（数据库优先于环境变量）
│       ├── db/                 # node:sqlite 访问层 + schema + 迁移 + 引导数据
│       ├── crypto/             # AES-256-GCM 密封盒
│       ├── auth/               # 会话、RBAC 目录、口令/TOTP、路由守卫
│       ├── headscale/client.ts # Headscale REST 客户端（含实测坑注释）
│       ├── services/           # 设置、审计、Headscale 装配与连接自检
│       └── routes/             # 业务路由
└── docs/
    └── headscale-v0.29-api-notes.md   # 实测 API 笔记（必读）
```

## 许可

内部项目。Headscale 为 BSD-3-Clause，本面板为其独立客户端，不包含 headscale 代码。
