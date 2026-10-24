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

## 跑面板端到端

```bash
export PANEL_URL=http://127.0.0.1:8080
export PANEL_ADMIN_USER=admin
export PANEL_ADMIN_SECRET=<你的引导口令>
export LAB_VIEWER_PASS=<测试用受限账户口令>
python3 e2e_panel.py
```

脚本不硬编码任何密钥，全部从环境变量读取。

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `HS_URL` | `http://127.0.0.1:18080` | headscale 实例地址 |
| `HS_API_KEY` | 无 | 必须设置 |
| `PANEL_URL` | `http://127.0.0.1:8080` | 面板地址 |
| `PANEL_ADMIN_USER` / `PANEL_ADMIN_SECRET` | `admin` / 无 | 面板管理员 |
| `LAB_VIEWER_PASS` | `ViewerPass2026` | 测试创建的受限账户口令 |
