# 联调脚本

对**本地编译的真实 headscale v0.29.6 实例**做实测，所有结论都来自这些脚本的输出。

## 准备

```bash
# 1. 编译 headscale v0.29.6（需 Go >= 1.27.3）
git clone --depth 1 --branch v0.29.6 https://github.com/juanfont/headscale.git
cd headscale && go build -o /tmp/hs/bin/headscale ./cmd/headscale

# 2. 起实例（配置样例见本目录 hs-lab-config.yaml）
#    注意：headscale 启动要求 DERP 地图至少一个条目，且 v0.29 用
#    node.ephemeral.inactivity_timeout，旧键 ephemeral_node_inactivity_timeout 已废弃
/tmp/hs/bin/headscale serve -c hs-lab-config.yaml

# 3. 造测试用户与 API Key
HS="/tmp/hs/bin/headscale -c hs-lab-config.yaml"
$HS users create labadmin && $HS users create devops
export HS_API_KEY=$($HS apikeys create --expiration 90d | tail -1)

# 4. 造测试节点（debug/node 只校验 authID 格式，可自造）
python3 mk_nodes.py
```

## 脚本说明

| 脚本 | 用途 |
|------|------|
| `mk_nodes.py` | 用自造 authID 经 `debug/node` + `auth/register` 造真实节点 |
| `probe_api.py` | 策略校验强度、节点/用户/API Key 写操作、错误路径、认证失败语义 |
| `probe_params.py` | 验证「无 body 绑定」端点：body 被忽略、必须走查询参数 |
| `probe_rename.py` | 验证 RenameNode 改的是 `givenName` 而非 `name` |
| `e2e_panel.py` | 面板端到端 54 项：认证 → CSRF → 透传 → 写操作 → RBAC 越权 → 登出 |
| `e2e_2fa.py` | 2FA 端到端 25 项：TOTP 启用/校验/两步登录/恢复码/关闭（自实现 RFC 6238 交叉验证） |
| `verify_web.mjs` | 前端 23 项：Chromium 真实 DOM 断言（渲染、跳转、真实数据、七页可达、移动端无溢出、无 JS 错误） |
| `verify_ws.py` | WebSocket 18 项：握手/订阅/心跳/未认证拒绝/**写操作触发实时推送**（自实现 WS 客户端，无第三方依赖） |

## 跑面板端到端

```bash
export PANEL_URL=http://127.0.0.1:8080
export PANEL_ADMIN_USER=admin
export PANEL_ADMIN_SECRET=<你的引导口令>
export LAB_VIEWER_PASS=<测试用受限账户口令>
python3 e2e_panel.py
```

脚本不硬编码任何密钥，全部从环境变量读取。

## 跑前端与 WebSocket 验证

```bash
# 前端需要 Playwright（首次会下载 Chromium）
npm i -D playwright && npx playwright install chromium

PANEL_ADMIN_SECRET=<引导口令> node lab/verify_web.mjs
PANEL_ADMIN_SECRET=<引导口令> python3 lab/verify_ws.py
```

`verify_ws.py` 只用标准库实现 WebSocket 帧编解码，不依赖任何第三方包。

## 跑 ACL 相关验证（P3）

```bash
# 一次性：清掉上轮中断留下的孤儿设备，并把策略重置为基线
HS_API_KEY=<api key> python3 lab/reset_lab.py --baseline

# 后端语义（93 项）——注意会自建一台一次性设备并在结束时删除
HS_API_KEY=<api key> PANEL_ADMIN_SECRET=<口令> python3 lab/e2e_acl.py

# 面板求值结论 vs 上游 /debug/filter 编译结果交叉验证
HS_API_KEY=<api key> python3 lab/verify_acl_semantics.py

# 前端 ACL 页真实 DOM 断言（Playwright）
PANEL_ADMIN_SECRET=<口令> node lab/verify_acl_ui.mjs
```

### ⚠️ 打标签不可逆 —— 测试必须自建自清

headscale 的 `SetTags` 是**单向**操作：一旦给设备打上标签，它就永久脱离原用户归属
（API 层无任何还原路径），且 `SetTags(id, [])` 会被上游直接拒绝。

因此**不要**用「给共享设备打标签 → 测完清标签」的思路写测试——第二次运行必然失败。
`lab/e2e_acl.py` 的做法是：自己造一台一次性设备（`debug/node` + `auth/register`），
用它完成全部标签用例，结束时删除，全程不碰既有数据。

`lab/reset_lab.py` 用于清理测试崩溃/中断时留下的孤儿设备（名字以 `lab-acl-tmp-` 开头）。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `HS_URL` | `http://127.0.0.1:18080` | headscale 实例地址 |
| `HS_API_KEY` | 无 | 必须设置 |
| `PANEL_URL` | `http://127.0.0.1:8080` | 面板地址 |
| `PANEL_ADMIN_USER` / `PANEL_ADMIN_SECRET` | `admin` / 无 | 面板管理员 |
| `LAB_VIEWER_PASS` | `ViewerPass2026` | 测试创建的受限账户口令 |
| `HS_DEBUG_URL` | `http://127.0.0.1:19090` | headscale metrics/debug 端口，用于读 `/debug/filter` |

### ⚠️ 为什么所有脚本都要 `bypass_proxy_for_local()`

macOS 上 `urllib.request` 会**读取系统代理设置**。本机存在代理（实测 `127.0.0.1:7897`）时，
发往 `127.0.0.1:8080` / `:18080` 的请求会被送去代理，是否成功取决于代理当时状态 ——
表现为「同一 API Key，curl 200 而 Python 401」且**时好时坏**。

确认方法：
```bash
python3 -c "import urllib.request; print(urllib.request.getproxies())"
```
修复：`lab/_local_net.py` 装无代理的全局 opener 并设 `no_proxy`。
**这是测试脚本的职责，不要改用户的系统代理设置。**

## 探针脚本一览

| 脚本 | 用途 |
|------|------|
| `probe_api.py` | 策略校验强度与错误路径 |
| `probe_params.py` | 确认哪些端点的 body 被 grpc-gateway 静默忽略 |
| `probe_rename.py` | 确认 `RenameNode` 改的是 `givenName` 而非 `name` |
| `probe_tag_user.py` | 确认标签设备 `user` 字段在列表/单节点接口上不一致 |
| `mk_nodes.py` | 批量造联调节点 |
| `reset_lab.py` | 清理孤儿临时设备、重置策略基线 |
| `_local_net.py` | **本地直连前置**：禁用代理 + 自检本地服务可达（所有脚本都 import 它） |
| `diag_auth.py` | 诊断「同一 Key 时而 200 时而 401」的网络原因 |
