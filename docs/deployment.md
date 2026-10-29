# 部署实施手册

面向生产环境的完整部署指引。覆盖两种主流拓扑：

- **[场景 A](#场景-a对接已有生产-headscale)**：面板对接**已有的**生产 headscale（最常见）
- **[场景 B](#场景-b一体化部署面板--headscale-同机新建)**：面板 + headscale 一起从零部署

> 本文所有结论都在真机验证过（Deepin 25 / Docker 29.8.1 / Compose v5.5.1 /
> InfluxDB 3.12.1 / headscale v0.29.6）。文中列出的报错信息都是实际抓到的原文。

---

## 目录

1. [部署前：选拓扑](#一部署前选拓扑)
2. [场景 A：对接已有生产 headscale](#场景-a对接已有生产-headscale)
3. [场景 B：一体化部署](#场景-b一体化部署面板--headscale-同机新建)
4. [TLS 与反向代理](#四tls-与反向代理两场景通用)
5. [单点登录（OIDC）对接](#五单点登录oidc对接)
6. [DNS extra-records 对接](#六dns-extra-records-对接)
7. [备份与恢复](#七备份与恢复)
8. [升级与回滚](#八升级与回滚)
9. [故障排查](#九故障排查)
10. [上线前安全检查清单](#十上线前安全检查清单)

---

## 一、部署前：选拓扑

| 你的情况 | 选哪个 | COMPOSE_FILE |
|---|---|---|
| headscale 已在生产跑着（容器或二进制） | **场景 A** | `docker-compose.yml` |
| 全新环境，要一次把面板和 headscale 都建起来 | **场景 B** | `docker-compose.yml:docker-compose.headscale.yml` |
| 还要历史曲线 / 在线时长 | 在 A 或 B 后追加 | 再加 `:docker-compose.metrics.yml` |

三个编排文件是**叠加**关系，不是三选一：

```
docker-compose.yml              面板（核心，永远需要）
docker-compose.headscale.yml    headscale（场景 B 才加）
docker-compose.metrics.yml      InfluxDB 3.x（要时序数据才加）
```

### 关键差异：HS_URL 怎么填

| headscale 在哪 | HS_URL |
|---|---|
| 同 compose（场景 B） | `http://headscale:8080` |
| 另一个 compose 项目，共享网络 | `http://headscale:8080` |
| 另一个 compose 项目，走宿主端口 | `http://host.docker.internal:8080` |
| 宿主机二进制（systemd） | `http://host.docker.internal:8080` |
| 局域网另一台机 | `http://192.168.1.50:8080` |
| 有域名 + TLS（生产推荐） | `https://hs.example.com` |

> ⚠️ 面板访问 headscale 是**从容器内部**发起的，不是从你的笔记本。
> 所以 `HS_URL=127.0.0.1` 几乎总是错的 —— 那指的是面板容器自己。

### 资源要求

| 组件 | CPU | 内存 | 磁盘 |
|---|---|---|---|
| panel | 0.5 核 | 512 MB | 1 GB（SQLite + 日志） |
| headscale | 0.5 核 | 256 MB | 1 GB |
| influxdb 3.x | 1 核 | 1 GB | 采样数据，约 100 MB/月（10 设备、15s 间隔） |

面板镜像约 483 MB（压缩 88 MB）。

---

## 场景 A：对接已有生产 headscale

最常用的路径。面板是**旁挂**的：只读/写 headscale 的 API，不影响数据面流量。

### A.1 前置检查

在**将要跑面板的这台机器**上逐项确认：

```bash
# 1. Docker 与 Compose
docker --version                 # 需要 20.10+
docker compose version           # 需要 v2（v1 的 docker-compose 不支持 profiles）

# 2. 能访问 headscale 的 API
curl -sI https://hs.example.com/health | head -1
#   期望 200。若返回 000/超时 → 网络或防火墙问题，先解决再继续

# 3. 端口没被占
ss -tlnp | grep -E ':3000|:8080'
```

> **headscale 版本要求**：v0.26 及以上（有 REST `/api/v1/*`）。本面板在
> v0.29.6 上验证。更早版本只有 gRPC，本面板未适配。

### A.2 在 headscale 侧创建 API Key

```bash
# headscale 是容器
docker exec headscale headscale apikeys create --expiration 999d

# headscale 是宿主机二进制
headscale apikeys create --expiration 999d
```

输出形如（`<前缀>_<密钥>`，总长约 87 字符）：

```
hskey-api-<prefix>_<secret>
```

**只显示这一次**，立刻记下来。

> **关于有效期**：`--expiration 999d` 是省事做法。生产更稳妥的是设 90d 并
> 建一个到期提醒 —— 否则某天面板会突然全部 401（现象是「所有操作都失败」，
> 但面板本身健康，非常容易误判成面板 bug）。

### A.3 准备配置

```bash
cd /opt/headscale-admin          # 或任意部署目录
cp .env.example .env
chmod 600 .env
mkdir -p data/dns
```

编辑 `.env`，最少改这 5 项：

```bash
COMPOSE_FILE=docker-compose.yml

# 生成两个强密钥
PANEL_MASTER_KEY=<openssl rand -hex 32>
PANEL_SESSION_SECRET=<openssl rand -hex 32>

# 浏览器实际访问地址（反代后的域名，务必与地址栏一致）
PANEL_PUBLIC_URL=https://hs-admin.example.com

# 上游 headscale
HS_URL=https://hs.example.com
HS_API_KEY=hskey-api-xxxxxxxx_yyyyyyyy...
```

生成密钥：

```bash
openssl rand -hex 32      # → PANEL_MASTER_KEY
openssl rand -hex 32      # → PANEL_SESSION_SECRET
```

> ⚠️ `PANEL_MASTER_KEY` 一旦设定**不可更改**。它加密库里的 headscale API Key、
> TOTP 密钥、OIDC 私钥。换了之后旧密文全部解不开，表现为「所有操作 401」。
> 设定后请立刻备份（见[第七节](#七备份与恢复)）。

### A.4 启动

```bash
docker compose up -d
docker compose ps                    # 应为 healthy
docker compose logs -f panel         # 首次会打印管理员账号与口令
```

首次启动日志里会有类似：

```
面板版本  1.1.0   监听 0.0.0.0:3000   数据库 /data/panel.sqlite   时序库 未配置
首次启动，已创建管理员账户：admin / Xk9mP2vQ7nR4
```

**记下这个口令**，登录后立即修改。若 `PANEL_ADMIN_SECRET` 已在 `.env` 里设过，
则用它、日志不会打印明文。

### A.5 验证

```bash
# 1. 进程健康（同时校验 DB 可达）
curl -s localhost:3000/api/system/health
# 期望：{"ok":true,"db":true,"panelVersion":"1.1.0",...}

# 2. ★ 关键：容器内能否访问 headscale
docker compose exec panel node -e \
  "fetch(process.env.HS_URL+'/health').then(r=>console.log('HTTP',r.status)).catch(e=>console.log('失败',e.message))"
# 期望：HTTP 200

# 3. 登录后看「系统设置」页的连接自检，应为绿色
```

第 2 步失败但第 1 步成功，说明**面板本身没问题，是到 headscale 的网络不通** ——
去查防火墙、DNS、headscale 的监听地址。

### A.6 接入反代（必须）

面板走 http 传输口令，**生产必须加 TLS**。见[第四节](#四tls-与反向代理两场景通用)。

---

## 场景 B：一体化部署（面板 + headscale 同机新建）

### B.1 与场景 A 的差别

多一个 headscale 容器，且 headscale 的配置文件在本仓库里。**主要工作量在改
headscale 配置**，不在面板。

### B.2 必须先改 headscale 配置

编辑 `config/headscale/config.yaml`，有 3 处占位符必须改，否则「headscale 起来了
但客户端连不上」：

```yaml
# ① 客户端能访问到的地址（不是 127.0.0.1，不是容器名）
server_url: https://hs.example.com

# ② MagicDNS 内部域名
dns:
  base_domain: hs.internal

# ③ oidc 段默认整段注释掉了。需要单点登录时才启用，见第五节
```

`server_url` 的取值规则：

| 客户端怎么连 | server_url |
|---|---|
| 经反代 + 域名 | `https://hs.example.com` |
| 直接连 IP（无 TLS，仅内网试验） | `http://192.168.1.50:8080` |

> ⚠️ `server_url` 一旦有客户端注册过就**不要随意改** —— 已注册客户端会
> 因为地址变化而失联，需要重新登录。

### B.3 启动

分两步起，因为建 API Key 需要 headscale 先跑起来：

```bash
mkdir -p data/dns

# ① 先只起 headscale
docker compose up -d headscale
docker compose ps headscale            # 等到 healthy

# ② 建 API Key
docker compose exec headscale headscale apikeys create --expiration 999d
#    → 填回 .env 的 HS_API_KEY

# ③ 再起面板
docker compose up -d panel
docker compose logs -f panel
```

> ⚠️ **`HS_URL` 仍必须写**，一体化场景固定为 `http://headscale:8080`。
>
> 这里有个容易想当然的地方：overlay 看起来可以「补默认值」，但**不行**。
> Compose 的变量插值发生在**每个文件解析时**，不是合并之后 —— 核心文件里的
> `${HS_URL:?...}` 在解析阶段就因缺值失败了，overlay 没有机会覆盖它。实测：
>
> ```
> $ docker compose -f docker-compose.yml -f docker-compose.headscale.yml config
> error while interpolating services.panel.environment.HS_URL:
> required variable HS_URL is missing a value
> ```
>
> 保留必填是刻意的：宁可启动时报错让人明确知道要连哪里，也不要靠隐式默认值。
> 默认值一旦与实际拓扑不符，故障表现是「容器起来了但连不上」，
> 比直接报错难查得多。

### B.4 验证 headscale 自身

```bash
# 容器内健康
docker compose exec headscale headscale health

# 从宿主机看（端口默认只绑回环）
curl -s localhost:8080/health
curl -s localhost:8080/version

# 节点列表（应为空）
curl -s -H "Authorization: Bearer $HS_API_KEY" localhost:8080/api/v1/node | head -c 200
```

### B.5 客户端接入

```bash
# 建用户
docker compose exec headscale headscale users create alice

# 建预授权密钥（把 <用户ID> 换成上一步返回的 id）
docker compose exec headscale headscale preauthkeys create --user <用户ID> --expiration 24h

# 客户端（另一台设备）
tailscale up --login-server https://hs.example.com --authkey <上一步的密钥>
```

---

## 四、TLS 与反向代理（两场景通用）

面板和后端 headscale 都建议走同一个反代。两个域名、两张证书。

### 4.1 nginx

```nginx
# ============ 面板 ============
server {
    listen 443 ssl;
    http2 on;
    server_name hs-admin.example.com;

    ssl_certificate     /etc/letsencrypt/live/hs-admin.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hs-admin.example.com/privkey.pem;

    # 面板上传 ACL 策略（HuJSON 可能较大）+ OIDC 表单
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ★ WebSocket：面板的实时推送走 /api/ws，不加这两行会一直重连
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

> **为什么要 `proxy_read_timeout`**：WebSocket 长连接默认 60s 无数据就断，
> 面板会不停重连。设长一些。

> **不要加** `proxy_buffering on` 到 `/api/ws` —— 会让实时推送延迟。
> nginx 对 upgrade 请求会自动关闭 buffering，所以上面的配置够用。

Caddy 用户更简单（自动 TLS + 自动 WebSocket 升级）：

```caddyfile
hs-admin.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### 4.2 headscale 的反代（场景 B 或已有实例也需要）

headscale 需要转发的路径比面板多：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name hs.example.com;

    ssl_certificate     /etc/letsencrypt/live/hs.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hs.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ★ /ts2021 是 Tailscale 的 Noise 协议长连接，必须支持 upgrade
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

### 4.3 端口暴露的最简原则

| 端口 | 对外 | 说明 |
|---|---|---|
| 面板 3000 | ❌ 只绑 127.0.0.1 | 由反代对外 |
| headscale 8080 | ❌ 只绑 127.0.0.1 | 由反代对外（客户端注册也走这个） |
| InfluxDB 8086 | ❌ 只绑 127.0.0.1 | 只给面板容器访问，绝不对外 |

三者在 compose 里默认就是这个行为。**不要**为了图省事改成 `0.0.0.0`。

---

## 五、单点登录（OIDC）对接

面板内置 OIDC Provider，headscale 作 Relying Party。这样 Tailscale 客户端
登录走面板的账号体系（含 2FA），而不是 headscale 的裸 API Key。

### 5.1 顺序不能反

```
① 面板跑起来 → ② 在面板建 OIDC 客户端 → ③ 把凭据填进 headscale 配置 → ④ 重启 headscale
```

**反过来会失败**。headscale 只要看到 `oidc` 段存在且
`only_start_if_oidc_is_available: true`，启动时就会去拉 issuer 的 well-known：

```
Error: initializing: creating new headscale: creating OIDC provider
from issuer config: Get "https://hs-admin.example.com/.well-known/
openid-configuration": dial tcp: lookup hs-admin.example.com: no such host
→ 容器起来就退出
```

所以本仓库的 `config/headscale/config.yaml` 里 **oidc 段默认整段注释掉**。

### 5.2 操作步骤

```bash
# ① 确认面板在跑
curl -s localhost:3000/api/system/health

# ② 面板 → 「OIDC Provider」→ 新建客户端
#    Redirect URI 填 headscale 的回调地址（headscale 的 issuer 下面）：
#      https://hs.example.com/oidc/callback
#    记下 client_id 与 client_secret（secret 只显示一次）
```

③ 改 headscale 的 `config.yaml`：

```yaml
oidc:
  only_start_if_oidc_is_available: true
  issuer: "https://hs-admin.example.com"     # ★ 必须与 PANEL_PUBLIC_URL 完全一致
  client_id: "oidc_xxxxxxxx"
  client_secret: "oidcs_xxxxxxxx"
  scope: ["openid", "profile", "email", "groups"]
  pkce:
    enabled: true
    method: "S256"
```

```bash
# ④ 重启
docker compose restart headscale
docker compose logs -f headscale | grep -i oidc
```

### 5.3 常见失败

| 现象 | 原因 |
|---|---|
| `iss` 校验失败 | `issuer` 与 `PANEL_PUBLIC_URL` 不一致（差个 https、多个端口、多个斜杠都算） |
| `redirect_uri_mismatch` | 面板里登记的 URI 与 headscale 实际发起的完全不一致 |
| `invalid_client` | client_secret 填错或已被轮换 |
| headscale 启动即退出 | issuer 不可达（面板没起 / 域名解析不了）；或残留 `strip_email_domain` / `map_legacy_users`（v0.29 已移除，写了就 fatal） |

---

## 六、DNS extra-records 对接

面板提供 DNS 记录管理界面，写 JSON 文件；headscale 通过 fsnotify 监听该文件，
**写文件即生效，无需重启**。

### 6.1 两个硬前提

**① 文件必须预先存在**，否则 headscale 启动就退出：

```
Error: headscale ran into an error and had to shut down:
setting up extrarecord manager: getting file info:
stat /dns/extra-records.json: no such file or directory
```

```bash
echo '[]' > data/dns/extra-records.json
```

**② 双方要看到同一个文件**：

| headscale 部署方式 | 做法 |
|---|---|
| 场景 B（同 compose） | 已配好：两边都挂 `./data/dns` → `/dns` |
| 另一个 compose（同机） | 让对方也挂同一个宿主机目录 |
| 宿主机二进制 | headscale 的 `extra_records_path` 指向宿主机上的 `./data/dns/extra-records.json` |
| 另一台机器 | 需要共享存储（NFS 等），否则**不要启用这个功能** |

### 6.2 配置

headscale 的 `config.yaml`：

```yaml
dns:
  extra_records_path: /dns/extra-records.json    # 容器内路径
```

`.env`：

```bash
HS_EXTRA_RECORDS_PATH=/dns/extra-records.json
DNS_RECORDS_DIR=./data/dns
```

> ⚠️ 路径**不能**放在 `/var/lib/headscale` 下面 —— 那是挂载点，其下再挂子目录
> 会被父挂载遮蔽，fsnotify 监听一个不存在的路径，写文件毫无反应且**没有任何日志**。

### 6.3 只支持 A / AAAA

headscale 的 extra-records 只接受 `A` 与 `AAAA` 记录。TXT、CNAME 等写进去会被忽略。

---

## 七、备份与恢复

### 7.1 必须备份的三样

| 位置 | 内容 | 丢失后果 |
|---|---|---|
| `panel-data` 卷的 `panel.sqlite` | 账号、角色、ACL 版本历史、审计日志、面板设置 | 全部重新配置 |
| `panel-data` 卷的 `master.key` | 加密主密钥 | **库内所有加密字段报废**：headscale API Key、TOTP 密钥、OIDC 私钥 |
| `headscale-data` 卷（场景 B） | headscale 的 SQLite、noise key、DERP 私钥 | 所有设备失联，需要重新注册 |

> **只备份 `panel.sqlite` 而不备份 `master.key`，等于没备份。** 恢复后数据库能
> 打开、账号能登录，但所有加密字段都是废数据 —— 这种「看起来恢复了」的状态
> 比彻底失败更难排查。

### 7.2 备份（用脚本，别手写 cp）

```bash
# 手工跑一次
./scripts/backup.sh

# 定时任务
0 3 * * * cd /opt/headscale-admin && ./scripts/backup.sh >> /var/log/hsa-backup.log 2>&1

# 自定义目录与保留天数
BACKUP_DIR=/var/backups/hsa ./scripts/backup.sh --keep 90
```

脚本做的事（这些细节决定了备份到底能不能用）：

| 步骤 | 为什么必须这样 |
|---|---|
| 用 SQLite 的 `backup()` 热备 | 面板跑在 WAL 模式，直接 `cp` 会漏掉 WAL 里已提交的事务，恢复后「最近的操作全丢了」且备份过程不报错 |
| 备份后立刻校验（表数/账户数） | 「文件存在」≠「文件可用」。校验不过直接以退出码 3 失败，让 cron 能报警 |
| 一并备份 `master.key` | 只恢复库不恢复 key，加密字段全废（见下） |
| headscale 用 `dump` 子命令 | 一体化场景才有；直接取 `db.sqlite` 可能拿到不一致快照，脚本会明确标注 |
| 自动按天数清理 | 避免磁盘被备份撑满 |

输出示例：

```
备份目标：/opt/headscale-admin/backups
  面板数据库：容器内生成一致性快照
  校验快照可用性
  取出文件
  ✓ panel-20261029-030000.sqlite（20 张表 / 3 个账户 / 12 个迁移）
  加密主密钥
  ✓ master-20261029-030000.key
  （未发现 headscale 容器 —— 对接外部 headscale 的场景属正常，跳过）
```

### 7.3 恢复

```bash
# 看有哪些备份
./scripts/restore.sh --list

# 恢复（库与 key 必须成对）
./scripts/restore.sh \
  --panel backups/panel-20261029-030000.sqlite \
  --key   backups/master-20261029-030000.key

# 无人值守（CI/演练）
./scripts/restore.sh --panel ... --key ... --yes
```

脚本会自动：

1. 把**当前**的库与 key 留存到 `.restore-backup-<戳>/`（恢复错了能回去）
2. 停止面板
3. 用 stdin 写入数据库与密钥（不用 `docker cp` —— 那会以 root 属主落盘，
   而容器内进程是 `node`(1000)，且 `cap_drop: ALL` 下无法 chown）
4. **清理残留的 `-wal` / `-shm`** —— 否则旧 WAL 会被套用到新库上，导致数据错乱
5. 启动并等待健康检查通过

### 7.4 恢复后必须手工确认的三件事

脚本只能验证「SQLite 打得开」，不能验证「业务数据正确」：

| 检查项 | 为什么 | 失败意味着 |
|---|---|---|
| 能用备份时的管理员口令登录 | 账号表恢复了 | 恢复的库不对 |
| **系统设置页 → Headscale 连接正常** | 这一步才真正验证 `master.key` 与库匹配 | key 与库不配对，加密字段全是废数据 |
| 2FA、OIDC 客户端等加密项回显正常（不是乱码） | 同上，逐项确认 | 同上 |

> 只做第一步是**不够的**。健康端点返回 `db:true` 只说明 SQLite 文件完好，
> 与「加密数据能否解开」完全无关 —— 这是恢复演练里最容易漏的一环。

## 八、升级与回滚

### 8.1 面板升级

```bash
# 0. 先备份（见第七节）
./backup.sh

# 1. 取新代码
git pull

# 2. 看有没有配置变更
diff .env.example .env    # 关注新增的必填项与改名项

# 3. 重建镜像。--no-cache 只在版本号没变却要更新时必要；
#    通常 build 会走缓存，很快
docker compose build panel
docker compose up -d panel

# 4. 验证
curl -s localhost:3000/api/system/health    # 看 panelVersion
docker compose logs --tail 30 panel
```

### 8.2 回滚

```bash
# 回滚到上一个 git tag
git fetch --tags
git checkout v1.1.0
docker compose build panel
docker compose up -d panel
```

> **跨大版本回滚要注意数据库 schema**：面板启动时会自动迁移 schema（只升不降）。
> 从新版本回滚到旧版本时，旧代码可能不认识新加的表/列。
> 保险做法是连同备份一起回滚：`git checkout <tag>` + 恢复对应日期的备份。

### 8.3 headscale 升级（场景 B）

```bash
# 1. 备份（用统一脚本，会短暂停 headscale 保证数据一致）
sudo ./scripts/backup.sh

# 2. 改 .env 的 HEADSCALE_IMAGE
sed -i 's|HEADSCALE_IMAGE=.*|HEADSCALE_IMAGE=headscale/headscale:v0.30.0|' .env

# 3. 重建
docker compose pull headscale
docker compose up -d headscale
docker compose logs -f headscale | grep -iE "error|fatal|deprecat"
```

> **为什么不用 `headscale dump`**：这个命令不存在。实测 `headscale dump`
> 报 `Error: unknown command "dump" for "headscale"`，官方子命令只有
> apikeys / auth / configtest / debug / generate / health / nodes / policy /
> preauthkeys / serve / users / version。而且官方镜像基于 distroless —
> 连 `ls` 都没有，无法在容器内打包。
>
> 所以 `scripts/backup.sh` 的做法是：**短暂停容器**（1~3 秒，客户端会自动重连）
> → `docker compose cp` 整个 `/var/lib/headscale` 目录 → 重启。
> 整个目录一起打包而不只拷 `db.sqlite`，是因为里面还有
> `noise_private.key` 与 DERP 私钥 —— 只恢复库而丢了这些密钥，
> 所有客户端都会失联、需要重新注册。

> headscale 跨小版本会有**配置项改名或移除**。典型：v0.29 移除了
> `oidc.strip_email_domain`、`oidc.map_legacy_users`、`dns.use_username_in_magic_dns`，
> 把 `ephemeral_node_inactivity_timeout` 挪到 `node.ephemeral.inactivity_timeout`。
> 残留旧键会 **fatal 退出**（不是警告）。升级前先看官方 release notes 的
> Breaking Changes。

---

## 九、故障排查

### 9.1 面板起不来

```bash
docker compose logs --tail 50 panel
```

| 报错 | 原因 | 处理 |
|---|---|---|
| `未设置 PANEL_MASTER_KEY` | `.env` 缺必填项 | 补上（`openssl rand -hex 32`） |
| `未设置 HS_URL` | 场景 A 忘了填 | 按第一节的表格填 |
| `EACCES: permission denied, open '/data/panel.sqlite'` | 卷属主不对（少见） | 卷应是 node(1000) 所有；不要用 root 预建目录 |
| 容器 `Restarting` 且日志空 | 只读根文件系统缺 tmpfs | 确认 compose 里有 `/tmp` 与 `/run` 的 tmpfs 声明 |

### 9.2 面板能起，但连不上 headscale

按顺序查，不要跳：

```bash
# ① 容器内 DNS 能不能解析
docker compose exec panel node -e \
  "require('dns').promises.lookup('hs.example.com').then(console.log).catch(e=>console.log(e.code))"

# ② 容器内能不能连通
docker compose exec panel node -e \
  "fetch(process.env.HS_URL+'/health').then(r=>console.log('HTTP',r.status)).catch(e=>console.log(e.name, e.message))"
```

| 结果 | 含义 | 处理 |
|---|---|---|
| `ENOTFOUND` | 解析失败 | 检查 HS_URL 拼写；容器内 DNS 与宿主可能不同 |
| `ECONNREFUSED` | 端口不通 | headscale 没监听 / 只绑 127.0.0.1 / 防火墙 |
| `HTTP 401` | 通但 API Key 不对 | 重建 key，检查有没有多余空格 |
| `HTTP 404` | 地址对但路径不对 | HS_URL 末尾不要带 `/api/v1`，面板自己拼 |
| `证书错误` | 上游自签证书 | 换受信证书，或临时 `HS_TLS_SKIP_VERIFY=true` |

> `HS_URL` 末尾的 `/` 会被自动去掉，但**不要**自己加上 `/api/v1` ——
> 面板会拼成 `/api/v1/api/v1/node`。

### 9.3 WebSocket 一直重连

浏览器 Network 面板看 `/api/ws`：

| 现象 | 原因 |
|---|---|
| 401 | Cookie 没带上（跨域或反代丢了 header） |
| 一直 `pending` 然后断 | 反代没配 `Upgrade` / `Connection` header |
| 每 60s 断一次 | 反代读超时太短，加 `proxy_read_timeout 3600s` |

### 9.4 趋势图空白

```bash
curl -s -b "cookie" localhost:3000/api/stats/health
```

| 返回 | 含义 |
|---|---|
| `influx.enabled: false` | 没配时序库 —— 正常降级，不是故障 |
| `influx.ok: false` | 配了但连不上，看 `influx.detail` |
| `sampler.recordedRounds: 0` 且 `skippedRounds` 增长 | 采样被跳过（通常因为 headscale 里没有节点） |
| `writer.dropped > 0` | 写入失败，看 `writer.lastError` |

时序库相关细节见 `docker-compose.metrics.yml` 头部注释。

### 9.5 端口冲突

```
Bind for 0.0.0.0:8080 failed: port is already allocated
```

改 `.env` 里的宿主端口，容器内端口不要动：

```bash
HS_PORT=18080        # headscale
PANEL_PORT=13000     # 面板
INFLUX_PORT=18086    # 时序库
```

改完 `docker compose up -d` 会重建容器。

### 9.6 headscale 起不来（场景 B）

| 报错 | 原因 |
|---|---|
| `initial DERPMap is empty` | `derp.regions: {}` 被拒。本仓库配置用内置 DERP server（region 999），已规避 |
| `getting DERPMap: ... TLS handshake timeout` | 配了 `derp.urls` 拉远程地图但外网不通。删掉 `urls` 用内置 DERP |
| `dns.nameservers.global must be set when dns.override_local_dns is true` | v0.29 是 fatal，不是警告。补 `nameservers.global` |
| `table ... not found` / `stat /dns/extra-records.json` | extra_records 文件不存在。`echo '[]' > data/dns/extra-records.json` |
| 容器 `Exited (0)` 且日志只有 usage | 忘写 `command: serve`。官方镜像没有默认 CMD |

---

## 十、上线前安全检查清单

逐项打勾，缺一项不建议上线：

- [ ] `PANEL_PUBLIC_URL` 是 **https**，且与浏览器地址栏完全一致
- [ ] 面板端口**只绑 127.0.0.1**，由反代终止 TLS
- [ ] headscale 端口只绑回环（或客户端直连时另有 TLS 方案）
- [ ] InfluxDB 端口不对公网开放
- [ ] `.env` 权限 600，且不在版本库里（`git check-ignore .env` 应命中）
- [ ] `PANEL_MASTER_KEY` 已备份到安全位置（与数据库分开存放）
- [ ] 管理员初始口令已修改，且开了 2FA
- [ ] `CSRF_ENABLED=true`
- [ ] `HS_TLS_SKIP_VERIFY=false`（除非有充分理由）
- [ ] headscale API Key 有明确的有效期与续期负责人
- [ ] 备份任务已配 cron 并**实际做过一次恢复演练**
- [ ] 反代配了 `Upgrade` / `Connection`（WebSocket 可用）
- [ ] 容器以非 root 运行（`docker inspect -f '{{.Config.User}}' headscale-admin` 应为 `node` 或空+镜像内默认非 root）
- [ ] 只读根文件系统生效（`docker inspect -f '{{.HostConfig.ReadonlyRootfs}}'` → `true`）
- [ ] 日志有轮转（compose 里已配 `max-size` / `max-file`）
- [ ] 监控告警已接入（面板 `/api/system/health` 与 headscale `/health`）

---

## 附：文件清单

| 文件 | 作用 | 何时改 |
|---|---|---|
| `docker-compose.yml` | 面板核心编排 | 一般不改 |
| `docker-compose.headscale.yml` | 一体化时才叠加 | 一般不改 |
| `docker-compose.metrics.yml` | 时序库才叠加 | 一般不改 |
| `.env` | 部署参数与密钥 | **每个环境都要改** |
| `config/headscale/config.yaml` | headscale 配置 | 场景 B 必改；场景 A 不用 |
| `Dockerfile` | 镜像构建 | 一般不改 |

有问题先看[第九节](#九故障排查)，那里按症状组织，覆盖了我实际踩过的全部坑。
