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
