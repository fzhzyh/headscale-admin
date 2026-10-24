# Headscale v0.29 API 实测笔记

> 本文所有结论均在 **headscale v0.29.6**（commit `a2b1d786`，Go 1.27.3）真实实例上实测得出，
> 不是从文档或旧版本经验推断。带 ⚠️ 的条目是**照抄网上教程必踩的坑**。

## 一、API 形态

headscale 的 HTTP 服务（`listen_addr`）上同时挂着：

| 路径 | 用途 | 认证 |
|------|------|------|
| `/api/v1/*` | REST API（grpc-gateway 转发到内部 gRPC） | `Authorization: Bearer <apikey>` |
| `/health` | 存活探针 | 无 |
| `/version` | 版本信息 | 无 |
| `/ts2021` | Tailscale 客户端 Noise 协议接入 | 无 |
| `/register/{auth_id}`、`/auth/{auth_id}` | 设备注册页 | 无 |
| `/swagger` | Swagger UI | 无 |

**结论：做面板不需要 gRPC。** REST 就够了，gRPC（`grpc_listen_addr`，默认 50443）是备选传输。

源码依据：`hscontrol/app.go` 中 `createRouter()` 把 `grpcGatewayMux.ServeHTTP` 挂在
`r.Route("/api", ...)` 下，并套了 `httpAuthenticationMiddleware`。

### 认证行为

```
无 Authorization          → 401 "Unauthorized"
Authorization: Token xxx  → 401（前缀必须精确是 "Bearer "）
Authorization: Bearer 错  → 401
```

API Key 由 `headscale apikeys create` 生成，形如 `hskey-api-<prefix>_<secret>`。
列表接口只返回 `prefix`（`hskey-api-G31r11_mhD3f-***`），**明文只在创建时返回一次**。

---

## 二、⚠️ 三个端点没有 body 绑定

proto 里这几个 rpc 的 `google.api.http` 注解**只写了路径，没有 `body: "*"`**，
因此 grpc-gateway 会**静默丢弃请求体**，参数必须走查询字符串。

| 端点 | 传 body 的后果 |
|------|----------------|
| `POST /api/v1/node/{id}/expire` | body 被忽略 → 无论传什么都是「立即过期」 |
| `POST /api/v1/node/register` | body 被忽略 → 返回**误导性报错** `auth ID has invalid prefix: expected prefix "hskey-authreq-"`（因为 key 读成了空串） |
| `DELETE /api/v1/preauthkey` | body 被忽略（`?id=` 可用，body 也恰好能生效，但不要依赖） |

### 实测对照

```
POST /api/v1/node/2/expire  body {"disableExpiry":true}      → expiry=2026-10-24T19:01:26Z  ✗ 无效
POST /api/v1/node/2/expire?disable_expiry=true               → expiry=null                  ✓ 生效
POST /api/v1/node/2/expire?expiry=2027-06-01T00:00:00Z       → expiry=2027-06-01T00:00:00Z  ✓ 生效
POST /api/v1/node/2/expire                                   → 立即过期                      ✓ 默认行为
```

```
POST /api/v1/node/register  body {"user":"devops","key":aid}  → 500 auth ID has invalid prefix  ✗
POST /api/v1/node/register?user=devops&key=<aid>              → 200 创建成功                   ✓
```

`expiry` 与 `disable_expiry` 同时传会被上游拒绝：`cannot set both disable_expiry and expiry`。

**无 body 绑定的完整端点清单**（26 个 HTTP 端点中）：

```
RenameUser          POST   /api/v1/user/{old_id}/rename/{new_name}
DeleteUser          DELETE /api/v1/user/{id}
DeletePreAuthKey    DELETE /api/v1/preauthkey
GetNode             GET    /api/v1/node/{node_id}
RegisterNode        POST   /api/v1/node/register          ⚠️ 必踩
DeleteNode          DELETE /api/v1/node/{node_id}
ExpireNode          POST   /api/v1/node/{node_id}/expire  ⚠️ 必踩
RenameNode          POST   /api/v1/node/{node_id}/rename/{new_name}
BackfillNodeIPs     POST   /api/v1/node/backfillips
DeleteApiKey        DELETE /api/v1/apikey/{prefix}
```

---

## 三、⚠️ RenameNode 改的是 givenName，不是 name

节点有两个名字字段，语义完全不同：

| 字段 | 含义 | 谁写入 |
|------|------|--------|
| `name` | 客户端上报的主机名 | tailscale 客户端 |
| `givenName` | 人工重命名后的名字 | `RenameNode` |

实测：

```
改名前      name='lab-alpha'   givenName='lab-alpha'
rename → lab-alpha-RENAMED
响应        name='lab-alpha'   givenName='lab-alpha-RENAMED'   ← name 没变
```

**面板必须优先展示 `givenName`**，否则用户点了「重命名」看不到任何变化。

---

## 四、⚠️ expiry 的两种「永不过期」表示

```json
{"expiry": null}                     // 通过 disable_expiry 设置后
{"expiry": "0001-01-01T00:00:00Z"}   // Go time.Time 零值，调试创建的节点即此形态
```

两种都表示**永不过期**。若直接 `new Date(expiry) <= now` 判断，第二种会被误判为
「已过期」，导致面板把正常设备标红。

判据：`时间戳 <= 0002-01-01T00:00:00Z` 即视为永不过期。

---

## 五、策略（ACL）

### 无策略时的初始状态

数据库模式（`policy.mode: database`）下，从未设置过策略时：

```
GET /api/v1/policy → 400 {"code":2, "message":"loading ACL from database: acl policy not found"}
```

这是**正常初始状态**，面板必须归一成空策略，不能当错误抛给用户。

### `policy/check` 的校验强度（比预期强）

`POST /api/v1/policy/check` 不仅查语法，还查语义，全部返回 400 code 3：

| 输入 | 结果 |
|------|------|
| 合法策略 | `200 {}` |
| 语法错误（缺括号） | `parsing HuJSON: hujson: line 1, column 55: parsing array after value: unexpected EOF` |
| 非法 action | `action="allow" is not supported: invalid ACL action` |
| 引用未定义 tag | `src=tag not found: "tag:nope"` |
| 引用未定义 host | `host not defined in policy: "nohost"` |

**结论：可以直接拿它当「保存前强校验」用**，不需要面板自己实现语法检查。
但它**不是访问权限检查**（不回答「A 能否访问 B」）——那个必须面板自研求值引擎。

### 策略字段结构（v2，与 Tailscale 语法对齐）

```json
{
  "groups":   { "group:dev": ["alice@", "tag:ci"] },
  "hosts":    { "db": "100.64.0.5", "nas": "192.168.1.10" },
  "tagOwners":{ "tag:lab": ["labadmin@"] },
  "acls":     [ { "action":"accept", "proto":"tcp", "src":["group:dev"], "dst":["db:5432"] } ],
  "grants":   [ { "src":["..."], "dst":["..."], "ip":["tcp:443"], "app":{...}, "via":["tag:x"] } ],
  "nodeAttrs":[ { "target":["tag:ci"], "attr":["..."] } ],
  "autoApprovers": { "routes": { "192.168.0.0/24": ["tag:router"] }, "exitNode": ["tag:exit"] },
  "ssh":      [ { "action":"accept", "src":["group:dev"], "dst":["tag:srv"], "users":["root"], "checkPeriod":"12h", "acceptEnv":["FOO"] } ],
  "randomizeClientPort": true,
  "tests":    [ ... ],
  "sshTests": [ ... ]
}
```

⚠️ **`randomizeClientPort` 在 v0.29 从 config 移到了 ACL**，老配置里的 `randomize_client_port` 已废弃。

---

## 六、⚠️ 标签必须先定义在 tagOwners

```
POST /api/v1/node/1/tags  {"tags":["tag:lab","tag:prod"]}
→ 400 {"code":3, "message":"requested tags [tag:lab tag:prod] are invalid or not permitted"}

POST /api/v1/node/1/tags  {"tags":["bad-format"]}
→ 500 {"code":2, "message":"tag must start with the string 'tag:'"}   ← 上游缺陷，非法输入报 500
```

**面板必须在本地先做格式校验**（`^tag:[a-zA-Z0-9._-]+$`），不能依赖上游报错，
否则用户会看到无意义的 500。同时要提示「标签需先在 ACL 的 tagOwners 中定义」。

---

## 七、⚠️ approve_routes 是全量覆盖，且不校验通告

```
POST /api/v1/node/1/approve_routes  {"nodeId":"1","routes":["192.168.10.0/24"]}
```

- **全量覆盖语义**：传入的 `routes` 就是最终启用集合，不是增量。
  面板必须「读当前 → 增删 → 写回」，注意并发覆盖。
- **不校验路由是否真的被设备通告**：批准一个设备从未通告的网段，上游返回 200 并真的写入，
  但客户端永远收不到该网段流量（路由黑洞）。面板加了「强制批准」二次确认护栏。

## 八、其他实测细节

### 用户
```
POST /api/v1/user  {"name":"temptest"}  重复创建 → 500 "UNIQUE constraint failed: users.name (2067)"
DELETE /api/v1/user/1                   该用户下仍有设备 → 500 "user not empty: node(s) found"
```
面板应在删除前先查该用户下设备数并给出友好提示，而不是透传 500。

### 不存在的资源
```
GET    /api/v1/node/99999  → 404 {"code":5, "message":"node not found"}
DELETE /api/v1/node/99999  → 404
GET    /api/v1/nonexistent → 404 {"code":5, "message":"Not Found"}
```

### 调试用造节点

`POST /api/v1/debug/node` 只校验 authID **格式**（`hskey-authreq-` + 24 位 url-safe 字符），
可以自造，然后走 `POST /api/v1/auth/register` 落成真实节点：

```
ID  = "hskey-authreq-" + <24 位随机>
POST /api/v1/debug/node      {"user":"labadmin","key":ID,"name":"lab-alpha","routes":["192.168.10.0/24"]}
POST /api/v1/auth/register   {"user":"labadmin","authId":ID}   ← 这里 body 是有效的
```
注册后节点 `online=false`（无真实客户端），但足以验证面板全链路。

---

## 九、v0.29 破坏性变更（相对旧版面板代码）

| 变更 | 说明 |
|------|------|
| 移除 `last_successful_update` | proto 里 `reserved 9` |
| 移除 `updated_at` / `deleted_at` | `reserved 14, 15` |
| 移除 `forced_tags` / `invalid_tags` / `valid_tags` | `reserved 18, 19, 20` |
| `randomize_client_port` | config → ACL 策略 |
| `ephemeral_node_inactivity_timeout` | config → `node.ephemeral.inactivity_timeout` |
| `oidc.strip_email_domain` | 已移除（fatal） |
| `oidc.map_legacy_users` | 已移除（fatal） |
| `dns.use_username_in_magic_dns` | 已移除（fatal） |

最低支持的 Tailscale 客户端版本：**v1.80.0**。

---

## 十、headscale 提供不了的（面板必须另想办法）

| 需求 | 现实 |
|------|------|
| **每节点流量字节** | ❌ headscale 不转发数据（WireGuard 直连或 DERP 中继），物理上统计不到。只能从节点侧或网络设备采集 |
| **DNS extra_records 写接口** | ❌ 无 API。但 v0.29 有 `fsnotify` 监听 `dns.extra_records_path`，**写文件即热生效，无需重启** |
| **ACL 版本历史** | ❌ 无，需面板自建 |
| **实时推送 / WebSocket** | ❌ 无流式 API，面板需自己轮询 + WS 扇出 |
| **访问检查（A 能否访问 B）** | ❌ `policy/check` 只做语法语义校验，需面板自研求值引擎 |
| **每节点流量 / 在线时长** | 在线时长可从 `online` 状态迁移推算（精度 = 采样间隔）；流量不行 |

### 可用的监控数据源

`metrics_listen_addr`（默认 19090）暴露 Prometheus 指标，但与节点流量无关：

```
mapresponse_sent_total / mapresponse_generated_total / mapresponse_ended_total
mapresponse_endpoint_updates_total / mapresponse_last_sent_seconds
ha_health_updates_total / mapper_changes_dropped_total
nodestore_nodes / nodestore_queue_depth / nodestore_batch_size
nodestore_operations_total / nodestore_operation_duration_seconds
nodestore_snapshot_builds_total / nodestore_snapshot_build_duration_seconds
nodestore_peers_calculation_duration_seconds
```

另有 `debug/overview` 端点（`/debug/overview`，Accept: application/json），
仅允许 loopback / Tailscale IP / 私网地址访问。

---

## 十一、extra_records 热加载机制

```yaml
dns:
  extra_records_path: /var/lib/headscale/extra-records.json
```

文件内容为 JSON 数组：

```json
[
  {"name": "grafana.internal", "type": "A", "value": "100.64.0.3"},
  {"name": "prom.internal",    "type": "A", "value": "100.64.0.4"}
]
```

`hscontrol/dns/extrarecords.go` 用 fsnotify 监听 `Create/Write/Chmod` 事件，
文件变更即重新加载并广播 `change.ExtraRecords()`。文件被删除/改名后会退避重试重新监听。

⚠️ `dns.extra_records`（inline）与 `dns.extra_records_path` **互斥**，同时配置会 fatal 退出。
⚠️ 只支持 A / AAAA 记录。
