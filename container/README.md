# 容器化开发/测试环境（Apple container）

用 Apple 原生 `container` 跑 headscale + 面板，**对外统一走 `100.64.0.3`**（本机 Tailscale IP）。
测试脚本不再连 `127.0.0.1` —— 容器化后服务不在宿主回环上，且只有走真实对外地址
才能顺带验证「发布是否真的通」。

## 快速开始

```bash
container/up.sh                       # 拉起整套环境（首次会构建镜像）
container/down.sh                     # 停止（保留数据）
container/down.sh --purge             # 停止并清空数据/密钥
```

`up.sh` 结束时会打印访问信息，并生成两个文件（均已 gitignore）：

| 文件 | 内容 |
|------|------|
| `container/lab.env` | 面板密钥（`PANEL_MASTER_KEY` / `PANEL_SESSION_SECRET` / 管理员口令） |
| `container/endpoints.env` | 测试用的对外地址，lab 脚本自动读取 |

## 架构

```
                        宿主 macOS 27.0.1 / arm64
                        Tailscale IP: 100.64.0.3 (macmini-home)
                                    │
              lab/hostport.py  ←────┴────→  100.64.0.3:{8080,18080,19090,50443}
                    （TCP 转发，见下文"为什么需要"）
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │        Apple container 网络 hs-lab-net 192.168.80.0/24 │
        │                                                        │
        │   hs-lab   headscale v0.29.6    192.168.80.x           │
        │            :8080 HTTP / :9090 metrics / :50443 gRPC    │
        │                          ▲                             │
        │                          │ 按容器名访问（容器 DNS 可用）│
        │   hs-panel 面板 (Fastify+SPA)   192.168.80.y  :3000    │
        └────────────────────────────────────────────────────────┘
```

- **面板 → headscale 走容器名** `http://hs-lab:8080`：不依赖宿主 IP，容器重建也不受影响
- **测试 → 服务走 `100.64.0.3`**：与真实使用者路径一致
- 数据持久化在 `container/state/`（headscale SQLite、面板 SQLite、API Key）

## 为什么需要 `lab/hostport.py`（而不是 `container -p`）

实测 **Apple container 1.5.0 的端口发布在本机不可用**：

| 测试 | 结果 |
|------|------|
| `container -p 100.64.0.3:18099:80` | 宿主 `LISTEN` ✓，但 HTTP 请求 `Connection reset by peer` ✗ |
| `container -p 18098:80`（全接口） | 同样 reset ✗ |
| 默认网络 / 自定义网络 | 都是 reset ✗ |
| `container system stop && start` 后复测 | 仍然 reset ✗ |
| **宿主直连容器 IP** `192.168.64.13:80` | **`OK-HELLO` 正常** ✓ |

即端口发布这一层坏了，但容器网络本身没问题。因此用一层极简 TCP 转发绕开。
**若将来 `-p` 修好，删掉 `start_proxy` 即可，测试侧地址不变。**

选 `hostport.py` 而不用 `tailscale serve` 的原因：`serve` 是 HTTP/HTTPS 导向、
会给出 `*.ts.net` 域名，与「统一用 `100.64.0.3`」的约定不符；
而且面板的实时推送是 WebSocket，需要透明 TCP 转发。

## 本次踩到的坑（都已修复，改代码前值得看）

### 1. 官方 headscale 镜像不带默认 CMD

`ghcr.io/juanfont/headscale` 的 ENTRYPOINT 是 `headscale`，但**没有默认子命令**。
`container run ... IMAGE` 会打印一屏 help 然后以 **exit 0** 退出——
容器"启动成功"又立刻停止，日志里只有 help，极易误判成"没报错就是不启动"。
⇒ 必须显式 `... IMAGE serve`。

### 2. `dns.nameservers.global` 缺失是 **fatal**

v0.29 在 `override_local_dns: true` 时强制要求它，缺了直接启动失败：
`Fatal config error: dns.nameservers.global must be set when dns.override_local_dns is true`

### 3. 官方镜像里没有 wget/curl → 容器内探活永远失败

用 `container exec ... wget -qO- http://127.0.0.1:8080/health` 做健康检查会一直失败，
而服务其实早就起来了。⇒ **健康检查从宿主用 curl 打容器 IP**。

### 4. `COPY server/node_modules` 会构建失败

npm workspaces 把依赖**全部提升到根 `node_modules`**，子包目录下没有
`node_modules` → `failed to compute cache key: /app/server/node_modules: not found`。
⇒ 只 COPY 根 `node_modules`，Node 的解析会从 `server/dist` 逐级向上找到。

### 5. `schema.sql` 不会被 `tsc` 产出

服务端运行期用 `readFileSync(join(here,'schema.sql'))` 读 schema，
但 `tsc` 只编译 `.ts`。⇒ `server/package.json` 的 build 脚本里补了复制步骤
（比只在 Dockerfile 里补更好：本地 `npm run build` 也一起修好）。

### 6. 静态资源路径不能基于 `process.cwd()`

`webDist: resolve('../web/dist')` 在本地恰好对（npm workspace 把 cwd 设为 `server/`），
但容器里 `WORKDIR=/app` + `node server/dist/index.js` → 算成 `/web/dist`，
面板首页 404 并提示「前端资源未构建」，而文件其实在 `/app/web/dist`。
⇒ 改为相对**模块自身位置**解析（`import.meta.url`）。

### 7. bash：变量后紧跟全角字符必须写 `${VAR}`

`log "创建网络 $NET（$NET_SUBNET）"` 在非 UTF-8 locale 下，
bash 会把全角括号的首字节当成变量名的一部分 → `NET<乱码>: unbound variable`。
⇒ 脚本里所有变量引用统一写 `${VAR}`。

### 8. Apple container 没有 registry 镜像加速器配置

只有 `registry login/logout/list`，没有 mirror 设置。
⇒ 把加速器写进镜像引用（如 `docker.m.daocloud.io/library/node:22-alpine`）。

**各源实测结论（本机，2026-10）：**

| 源 | 结果 | 备注 |
|---|---|---|
| `docker.io` | ✗ `HTTPClientError.connectTimeout` | `auth.docker.io` 不可达，一律超时 |
| `docker.m.daocloud.io` | ✓ 可用 | docker.io 唯一可用的加速器 |
| `ghcr.io` | ✓ 可用（直连） | 慢但稳定，headscale 80MB 约 2m11s |
| `ghcr.m.daocloud.io` | ✗ `403 missing Bearer challenge` | 与 `docker.1panel.live` 同一错误形态 |
| `dockerproxy.cn` | ✗ `server closed session with no notification` | |
| `docker.1panel.live` | ✗ `403 missing Bearer challenge` | 需先 login，无法匿名 |

**注意两条路径的镜像其实是同一个**（digest 一致，可互换）：

    ghcr.io/juanfont/headscale:v0.29.6        digest=cabe84f06999
    docker.io/headscale/headscale:v0.29.6     digest=cabe84f06999

⇒ ghcr 拉不到时可直接换 docker.io 的官方名（再套 daocloud 加速器）。

### 9. 不指定平台会解包**所有架构**，单个镜像可吃掉 65G

`container image pull` 默认解多架构镜像的**全部平台**。实测日志里就出现过
`Unpacking image for platform linux/s390x`——本机是 arm64，s390x 那一份纯属浪费。

后果：本机 `~/Library/Application Support/com.apple.container/snapshots`
累计 **156G**，其中**两个快照各占 65G**（就是 `node:22-alpine` 的全架构解包）。

⇒ 拉取一律限定平台：

    container image pull --platform linux/arm64 <ref>
    # 或全局：export CONTAINER_DEFAULT_PLATFORM=linux/arm64

`up.sh` 里的 `resolve_hs_image()` 已带 `--platform linux/arm64`。

清理（**会一并删掉其它项目未使用的镜像，先确认再执行**）：

    container image prune          # 只清 dangling
    container image prune --all    # 清所有未使用镜像

本机根分区 1.9Ti、可用 1.5Ti，此问题不紧急，但会随镜像增多持续膨胀。

## 目录

```
container/
├── up.sh                 # 一键拉起
├── down.sh               # 停止 / --purge 清空
├── hs-config.yaml        # headscale v0.29.6 容器内配置
├── Dockerfile.panel      # 面板镜像（多阶段构建）
├── Dockerfile.headscale  # headscale 源码构建（官方镜像不可用时的备用路径）
├── state/                # 运行期数据（gitignore）
├── lab.env               # 生成的密钥（gitignore）
└── endpoints.env         # 生成的对外地址（gitignore）
```

## 备用路径：容器内源码构建 headscale

官方镜像拉取失败时，`up.sh` 会自动回落到 `Dockerfile.headscale`。
这条路径还有个额外好处：**完全不碰宿主机 Go 环境**——
本机 `~/go/pkg/mod` 有 193 个 root 所有的路径（598MB），
任何宿主机上的 Go 构建都会 permission denied，在容器里构建则不受影响。

注意 `go.mod` 要求 **Go 1.27.3**，基础镜像必须 ≥ 该版本，否则直接构建失败。

### 9. 容器名解析返回 IPv6，Node 的 fetch 走不通

`container exec hs-panel nslookup hs-lab` → **`2001:2::19`**（IPv6），
ping 又显示 `198.18.0.85`（合成地址）。而 Node 的 `fetch` **优先 IPv6** →
`fetch failed` / 超时，可 `ping` 却是通的，很容易误判成"网络没问题"。

实测对照：

| 面板内访问 | 结果 |
|---|---|
| `http://hs-lab:8080/health` | ✗ 超时 |
| `http://192.168.80.2:8080/health` | ✓ `{"status":"pass"}` |

⇒ **面板连 headscale 一律用容器 IP**，不用容器名。

### 10. 面板把 hs.url 存在自己的库里，只在首次从环境变量播种

容器重建后 headscale 的 IP 会变，但面板 DB 里还是旧地址 → 所有业务接口超时。
⇒ `up.sh` 每次启动都登录面板、`PUT /api/settings` 对齐 `hs.url` / `hs.apiKey`。
**验证连通性必须用真正访问 headscale 的接口**（如 `/api/nodes`）；
用 `/api/system/overview` 会得到假阳性——它只读本地面板库。

### 11. `socket.create_connection(timeout=)` 的超时会泄漏到 recv

`hostport.py` 早期用 `create_connection(target, timeout=8)` 后直接开始搬运数据。
这个 timeout **会一直作用于后续 recv**，于是任何超过 8s 的请求（面板查上游超时、
大文件、长轮询）都被转发器自己掐断，客户端只看到 `curl: (52) Empty reply from server`
——看着像后端崩了，其实是中间层干的。

⇒ 连上之后立刻 `settimeout(None)`。

### 12. 容器化后 `/debug/*` 一律 403

headscale 的 debug 端点仅允许**本机回环**访问。容器化后请求源是容器网关，
`/debug/filter` 返回 `403 debug access denied`；
而官方镜像又是 **distroless（连 `sh` 都没有）**，无法 `container exec` 进去查。

⇒ `lab/e2e_acl.py` 里两项「与上游编译结果交叉验证」在容器模式下**显式 SKIP 并说明原因**，
不伪装成通过。需要在裸进程模式下才完整跑。

### 13. 实验网段的节点 IP 与宿主 Tailscale IP 重叠

headscale 从 `100.64.0.0/10` 分配，实验里 `lab-beta` 拿到了 **`100.64.0.3`**，
正好是本机的 Tailscale 地址。

对**纯控制面实验**无害（headscale 不向节点转发数据流量，节点也是合成的、从不存在真实客户端），
但**绝不能往这套实验环境接真实 Tailscale 客户端**，否则会与本机路由冲突。
若将来要接真实客户端，需把 `hs-config.yaml` 的 `prefixes.v4` 换到不冲突的网段。
