# 开发坑记录

开发过程中踩到并已修复的问题。每条都写清**症状 → 根因 → 做法**，避免重复踩。

## 一、Fastify 静态资源：`wildcard: false` 让前端重建后白屏

**症状**：前端 `vite build` 后刷新页面整页白屏。DevTools 里主包请求返回 **200 但只有 774 字节**（其实是 `index.html`），浏览器按 JS 解析报语法错误。

**根因**：`@fastify/static` 的 `wildcard: false` 会在**服务启动时**枚举目录文件并逐条注册路由。Vite 产物文件名带内容哈希（`index-Cw67H6xv.js`），重建后哈希变了，新文件名不在已注册的路由表里 → 请求落到 `setNotFoundHandler` 的 SPA 回退 → 返回 `index.html`。

**做法**：
1. 用默认 `wildcard: true`，任意路径都从磁盘实时读取；
2. `setNotFoundHandler` 里对**带扩展名**的路径（`.js` / `.css` / `.png`…）直接返回 404，**绝不回退 index.html**。否则这类错误会伪装成 200，极难定位；
3. `index` 保持默认 `true`，设 `false` 会让根路径 `/` 返回 403。

## 二、路由注册必须在 `listen()` 之前

**症状**：启动即崩 —— `FastifyError: Fastify instance is already listening. Cannot add route!`

**做法**：所有 `app.get/post/...` 必须在 `buildApp()` 阶段完成。需要在启动后才有的端点，写进对应的路由模块。本次是把 `/api/realtime/status` 从 `index.ts` 移回 `realtime/hub.ts` 的 `registerRealtimeRoutes()`。

## 三、WebSocket 鉴权不能靠 HTTP 闸门（否则前端无限重连）

**症状**：未登录/会话过期时，`/api/ws` 在协议升级前被 `preHandler` 返回 HTTP 401。浏览器只看到 `onclose` 的 **code 1006**，前端无法区分「会话过期」与「网络抖动」→ 按指数退避**无限重连**，日志被刷爆。

**做法**：把 `/api/ws` 加进闸门豁免名单，交给 hub 自己鉴权：先发 `{type:'error'}` 帧，再 `socket.close(4401, 'unauthorized')`。前端的 `onclose` 见到 4401 就停止重连并跳登录页。

## 四、Tailwind 与 Ant Design 共存：必须关掉 preflight

**症状**：引入 antd 后按钮、输入框样式错乱（背景色丢失、边框异常）。

**根因**：Tailwind 的 preflight 会重置 `button` / `input` 等元素样式，与 antd v5 的 CSS-in-JS 打架。

**做法**：`corePlugins: { preflight: false }`，只保留 utilities；antd 自带完整 reset。窗口职责划分：**antd 管复杂组件，Tailwind 管版面**。

## 五、移动端横向溢出

**症状**：390px 宽视口下 `scrollWidth=446`，出现横向滚动条。

**根因**：侧栏固定 224px + 内容区 `marginLeft: 224px`，小屏必然溢出。

**做法**：`matchMedia('(max-width: 1023px)')` 监听，小屏自动 `collapsed = true`（64px）；内容区 `overflow-x-hidden` 并改为 `p-3 sm:p-4 lg:p-5`；顶栏 `flex-wrap` + 为左右两侧加 `min-w-0` / `shrink-0`。

## 六、go build 被 root 污染的模块缓存挡住

**症状**：`go build` 报 `open .../cache/download/golang.org/x/crypto/@v/v0.57.0.lock: permission denied`、`mkdir .../github.com/google/btree: permission denied`，产物为空。

**根因**：历史上某次 sudo 编译，把 `~/go/pkg/mod/cache/download/**` 部分目录属主改成了 root（本机实测有 193 个路径）。

**做法**（不需要 sudo，不污染全局环境）：
```bash
export GOMODCACHE=/path/to/own/cache GOPROXY=https://goproxy.cn,direct GOSUMDB=off
go build -o ./bin/headscale ./cmd/headscale
```
彻底修复则需 `sudo chown -R $(whoami):staff ~/go/pkg/mod`。

## 七、`node:sqlite` 的绑定值限制

**症状**：写入时抛类型错误。

**根因**：`node:sqlite` 的绑定值**只接受** `null` / `number` / `bigint` / `string` / `Uint8Array`，传 `boolean`、`undefined`、`Date` 会直接报错。

**做法**：在 `db/index.ts` 里统一做归一化（`boolean → 0/1`、`undefined → null`、`Date → ISO 字符串`、对象 → JSON 字符串）。

## 八、React 受控输入无法用 `.value =` 赋值

**症状**：自动化测试里给 antd 输入框赋 `.value` 后提交，值没生效。

**根因**：React 受控组件依赖 `onChange`，直接改 DOM 的 `value` 不触发。

**做法**：走原型链上的原生 setter 再派发事件：
```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(el, val);
el.dispatchEvent(new Event('input', { bubbles: true }));
```
（本项目的 `lab/verify_web.mjs` 改用 Playwright 的 `fill()`，天然处理该问题。）

## 九、Playwright `waitForURL` 的否定陷阱

**症状**：登录后断言「跳转到控制台」失败，但后续断言能读到控制台数据。

**根因**：`waitForURL(/\/(dashboard|login)/)` 在页面已经处于 `/login` 时**立即匹配成功**，根本没等跳转。

**做法**：只等目标 URL（`/\/dashboard/`），不要用包含当前页面的或表达式。

## 十、Node 22 下 supress `node:sqlite` 实验性警告

`node:sqlite` 属实验特性，每次启动打 `ExperimentalWarning`。在 `index.ts` 里挂钩 `process.emit` 过滤该条警告，避免污染日志（过滤条件同时匹配 `name === 'ExperimentalWarning'` 与消息含 `SQLite`，不会误伤其它警告）。

## 十一、把「不可逆操作」当成可重置的状态来设计

**症状**：ACL 端到端测试第一版写完是绿的，第二次运行必然失败 4~14 项；
手工「清理测试数据」的命令也报 `cannot remove all tags from a node`。

**根因**：headscale 的**打标签是单向操作**（`hscontrol/grpcv1.go:326` 注释：
*"Once tagged, a node cannot be converted back to user-owned"*）。
测试用「给共享设备打标签 → 测完清空标签复位」的思路，从根上就是错的：
清空标签会被上游直接拒绝，节点永久挂在虚拟用户 `tagged-devices` 名下。

**做法**：
1. 测试改为**自建自清**——自己造一台一次性设备（`debug/node` + `auth/register`），
   用完删除。全程不碰既有数据。（`lab/e2e_acl.py`）
2. 另配 `lab/reset_lab.py`，清理测试中断时留下的孤儿设备。
3. 产品侧同理：面板必须把这类操作**当高危动作拦截并说明后果**，
   而不是把上游的英文报错透传出去。

**推广**：写测试前先问「这个操作能不能撤销」。不能撤销的，测试就必须
自带隔离环境，绝不能依赖「复位共享状态」。

## 十二、前后端错误码前缀不一致导致提示框变成死代码

**症状**：设备页给标签失败的场景写了一个很友好的 Modal 提示，
但它**永远不会出现**——用户只能看到一条通用错误。

**根因**：全局 errorHandler 会把未被捕获的上游错误包装成 `HEADSCALE_<code>`，
但**路由内主动拦截**时返回的是不带前缀的码（如 `TAG_NOT_OWNED`）。
前端只判断了带前缀的那个。

**做法**：两种都判断，并加注释说明前缀规则：
```js
if (e instanceof ApiError && (e.code === 'TAG_NOT_OWNED' || e.code === 'HEADSCALE_TAG_NOT_OWNED'))
```
**检查手段**：e2e 用例里直接断言后端返回的 `error` 码，而不是只断言 HTTP 状态码——
状态码对了但 code 不匹配，前端的分支依然进不去。

## 十三、同一字段在两个接口上返回值不同（headscale 特有）

**症状**：ACL 求值把一台已打标签的设备判成「无归属」，导致 `user@` 规则意外不命中；
但同一台设备在设备列表里明明显示归属 `tagged-devices`。

**根因**：headscale v0.29.6 对已打标签设备的 `user` 字段：
- `GET /api/v1/node`（列表）→ `{id: 2147455555, name: "tagged-devices"}`
- `GET /api/v1/node/{id}`（单节点）→ `null`

**做法**：**不要相信单一接口的返回值来推断语义**。`shapeNode()` 改为
只要 `tags.length > 0` 就认定归属为 `tagged-devices`，并输出 `taggedIdentity` 标志，
完全不依赖接口给什么。（探针：`lab/probe_tag_user.py`）

**推广**：接入任何第三方 API 时，对同一个实体从列表接口与详情接口各取一次，
比对差异。这类不一致在真实项目里比想象中常见。

## 十四、把校验结果收敛到单一事实来源

**症状**：页面头部的「应用策略」按钮和编辑器工具栏的按钮**行为不一致**——
头部按钮在内容有校验错误时仍然可点，点下去必然弹错误框。

**根因**：校验请求写在子组件（RawEditor）里，父组件（AclPage）的头部按钮
拿不到校验结果，只能按「有没有改动」判断可用性。

**做法**：把校验查询**提升到页面级**，父组件持有结果，同时下发给头部按钮与子编辑器；
再加一个「校验结果是否已追上当前草稿」的判断（防抖期间不能误判为通过）。
好处有三：行为一致、避免重复请求、状态单一。

## 十五、antd 会在两个中文字符的按钮文字间插空格

**症状**：Playwright 用 `button:has-text("检查")` 定位按钮，报
`locator.isEnabled: Timeout 30000ms exceeded` ——看起来像"元素不存在"，实际是文字对不上。

**根因**：antd 对**恰好两个中文字符**的按钮会插入一个空格做排版（DOM 里是 `检 查`）。
四字及以上、单字（如 `登`）都不会触发，所以这个坑只在特定按钮上出现，极易误判。

**做法**：用容忍空格的匹配，别写死连续字符：
```js
page.getByRole('button', { name: /检\s*查/ })
```
**排查提示**：选择器超时时，先把 `await page.locator('button').allInnerTexts()` 打出来看实际文本，
不要凭猜测调选择器。

## 十六、`debug/node` 的 `routes` 参数是装饰性的

**症状**：用 `debug/node` 造节点时传了 `routes: ["192.168.10.0/24"]`，
`auth/register` 落成的节点 `availableRoutes` / `approvedRoutes` **全是空的**。

**根因**（`hscontrol/grpcv1.go:855` 注释原文）：

```go
// Echo back a synthetic [types.Node] so the debug response surface stays
// stable. The actual node is created later by [headscaleV1APIServer.AuthApprove] via
// [state.State.HandleNodeFromAuthPath] using the cached [types.RegistrationData].
echoNode := types.Node{ ... Hostinfo: &tailcfg.Hostinfo{ RoutableIPs: routes } }
```

`routes` 只被塞进了 **`debug/node` 自己返回的 echo 节点**；
真实节点由 `HandleNodeFromAuthPath` 从缓存的 `RegistrationData` 创建，
而 `RegistrationData`（`types/registration.go:21`）**根本没有 RoutableIPs 字段** —— 路由在注册那一刻就丢了。

**做法**：要造带路由的节点，必须显式批准：

```python
# 先注册节点，再单独批准路由
call("POST", f"/api/v1/node/{nid}/approve_routes", {"routes": ["192.168.10.0/24"]})
```

**教训**：第三方 debug/test 接口的参数不一定真的生效——它可能只影响返回值。
接这类接口时，**写完后必须回读一次确认副作用真的发生了**。

## 十七、测试硬编码实体 ID 会在夹具重建后静默失效

**症状**：`e2e_panel.py` 的路由用例全部失败，报「无路由」；
而重命名、过期等用例报「设备不存在」。之前一直是绿的。

**根因**：脚本里写死了 `/api/nodes/1/...`。为修复被永久打标签的设备，我删除了 node 1
并重建（新 ID 变成 5）——用例指向了一个不存在的设备。
更糟的是**有些用例「失败得很安静」**：比如「能读到已批准路由」只是断言为假，
看不出是夹具没了还是功能坏了。

**做法**：
1. 登录后**动态解析**目标实体，别写死 ID：
   ```python
   NODE_ID = next(n["id"] for n in nodes if n.get("displayName") == "lab-alpha")
   ```
2. 用例**自备夹具**，不依赖其它脚本先跑过或历史遗留数据。
3. 夹具缺失时给**明确报错**（`check("夹具：...", False, "原因")`），
   而不是让断言默默变假。

**推广**：凡是被测对象可能被删除/重建的环境，「按 ID 引用」都是定时炸弹。
按**稳定属性**（名字、标签）解析，或干脆自建自清。

## 十八、限流生效时，测试会「连锁失败」而非干净报错

**症状**：单独跑 `e2e_2fa.py` 全绿；把它放进整套回归里连着跑，就报
`NO_SETUP 请先获取 2FA 密钥`、`正确动态码登录失败` 等一堆看不出因果的错误。

**根因**：登录接口有 **20 次/5 分钟**限流（安全设计，必须保留）。整套回归会连续登录多次，
触发 429 后，**后续步骤全部建立在失败的前置状态上**——例如 2FA setup 被限流打断，
后面「启用 2FA」自然报 `NO_SETUP`。真正的原因（429）只在一行里一闪而过。

**做法**：
1. 测试对 429 做**按上游提示等待后重试**（读 `retry in N minute`），**不要**把限流调松——
   那是把安全机制关掉来让测试变绿，属于最糟的修法。
2. 看失败时**先找第一个错误**，不要逐个看后面的连锁报错。
3. 单独跑一遍确认是环境/顺序问题还是真实缺陷。

**推广**：任何带限流/配额的外部依赖，测试都要有退避重试；否则「一起跑就挂、单跑就过」
会浪费大量排查时间。

## 十九、共享单例 + 「字段级恢复」= 静默毒化后续所有调用

**症状**：2FA 的 `/api/auth/2fa/setup` 返回 **500 INTERNAL**，
日志里是 `Error: Expecting options.window to be an number or [number, number]`
（来自 `@otplib/core` 的 `totpOptionsValidator`）。
诡异之处：**新启动的进程一切正常**，只有「已经校验过一次动态码」的进程才会复现。

**根因**：otplib 的 `authenticator` 是**共享单例**。原代码只恢复了一个字段：

```ts
const prevWindow = authenticator.options.window;   // 首次调用是 undefined
try {
  authenticator.options = { ...authenticator.options, window: 1 };
  return authenticator.verify({ token, secret });
} finally {
  authenticator.options = { ...authenticator.options, window: prevWindow };  // ← 写回 undefined
}
```

`finally` 把 `options.window` 永久写成 `undefined`，而校验器要求它是 number，
于是**此后所有 `generateSecret()` 都抛异常**。

**做法**：**整份快照存取，不做字段级恢复**：

```ts
const snapshot = { ...authenticator.options };
try {
  authenticator.options = { ...snapshot, window: 1 };
  ...
} finally {
  authenticator.options = snapshot;   // 恢复完整快照
}
```

**验证**：`server/src/auth/secrets.test.ts` 里有专门的回归用例
（先校验一次动态码，再生成密钥），并用旧写法反证过确实能复现。

**推广**：凡是对**共享可变单例**做「临时改一下再改回来」，
一律用快照整体替换，别只恢复你改过的那一个字段——
`undefined` 会被当成合法值写回去，制造出「看起来无关的后续调用报错」。

## 二十、macOS 系统代理让「本机请求」间歇性 401

**症状**：同一个 headscale API Key，在**同一个 shell 里**：
- `curl -H "Authorization: Bearer $K" http://127.0.0.1:18080/api/v1/node` → **200**
- `python3` 里 `urllib.request.urlopen(...)` → **401 Unauthorized**

而且**时好时坏**。整个联调脚本集因此出现「上一轮全绿、这一轮一堆 401」的假故障，
被反复误判为「Key 失效」「面板鉴权坏了」「headscale 重启了」。

**根因**：macOS 上 `urllib.request` 会通过 `getproxies_macosx_sysconf()`
**读取系统代理设置**。本机存在代理（实测 `127.0.0.1:7897`）时，
发往 `127.0.0.1:8080` / `:18080` 的请求被**送去代理**，是否成功取决于代理当时的状态。
`curl` 不走系统代理设置，所以两者行为不一致。

一行确认：
```python
python3 -c "import urllib.request; print(urllib.request.getproxies())"
# {'http': 'http://127.0.0.1:7897', ...}  ← 就是它
```

**做法**：联调脚本里**强制本地直连**（`lab/_local_net.py`），
装一个无代理的全局 opener，并设上 `no_proxy`：
```python
urllib.request.install_opener(urllib.request.build_opener(urllib.request.ProxyHandler({})))
os.environ["no_proxy"] = "127.0.0.1,localhost,::1"
```
**不要**去改用户的系统代理设置——那是用户的全局环境，测试脚本没资格动。

**推广**：排查「同一凭证时好时坏」时，**先确认两条请求路径是否真的等价**
（代理、DNS、协议、TLS），别急着怀疑凭证或权限。

## 二十一、间歇性 401 的真凶：命令行里的密钥被脱敏层篡改（+1 字符）

**症状**：联调脚本的直连调用**时好时坏**报 401，而同一时刻 `curl` 用同一个 Key 返回 200。
一度误判为「macOS 系统代理」「Key 失效」「headscale 有 bug」，排查了很久。

**决定性证据来自 headscale 自己的日志**（不是猜测）：

```
INF failed to validate token
    error="failed to parse ApiKey: *** length mismatch, expected 64 chars, got 65"
    method=PUT path=/api/v1/policy status=401
```

**它说得很清楚**：收到的 Key 比正确值**多了 1 个字符**（期望 64，实得 65）。
`hskey-api-` + 13 位前缀 + `_` + 64 位密钥 = **87**；失败时是 **88**。

**根因**：把密钥**字面写进命令字符串**（`export HS_API_KEY=hskey-api-…`）再执行时，
工具链的**密钥脱敏层会间歇性地多插入一个字符**。以这个项目的工具调用为例：

```
我写的：echo "=== 确认 shell 里没有 HS_API_KEY ==="
实际回显：=== 确认 shell 里没有 HS_API_KEY=***        ← 标题被就地脱敏替换，这就是篡改的直接证据
```

而 `server/.env` 里的同一份 Key **始终是 87 位**——所以**面板永远正常**，
只有「密钥经过命令行的脚本」才间歇失败。这个不对称是定位的关键线索。

**做法**：**测试脚本一律从文件读密钥，不走命令行**：

```python
from _local_net import bypass_proxy_for_local, load_hs_key
bypass_proxy_for_local()
KEY = load_hs_key()        # 优先 server/.env，并强制校验前缀格式与长度 87
```

`load_hs_key()` 会**断言长度与前缀**，Key 不对时**响亮报错并指出疑似原因**，
而不是让一串 401 把真实原因埋掉。

**排除干扰项的证据链**（每一步都可复现）：
| 检查 | 结果 |
|------|------|
| `curl` 同 Key 直连 | 200 → 排除 Key 失效 |
| `urllib.getproxies()` | 有系统代理 `127.0.0.1:7897`（**另一个真实问题**，已一并修） |
| 同一代码路径内联运行 | 200 → 排除代码缺陷 |
| 连续 60 次调用 | 0 失败 → 排除稳定缺陷 |
| **headscale 日志** | **`got 65` —— 找到真凶** |
| `.env` 中 Key 长度 | 恒为 87 → 说明篡改只发生在命令行传参路径 |

**推广**：排查「同一凭证时好时坏」时，去**服务端日志**找答案——它记录的是
**实际收到的东西**，比在客户端猜一万次都有效。另外，**不要把密钥写在命令行里**：
既会被篡改，也违反最小暴露原则。
