# Headscale v0.29.6 ACL 语义与陷阱

> 本文所有结论都来自 **v0.29.6 源码 + 真实实例实测**（commit `a2b1d786`）。
> 验证脚本：`lab/e2e_acl.py`（93 项）、`lab/probe_tag_user.py`、`lab/verify_acl_semantics.py`（与上游 `/debug/filter` 交叉验证）。

面板的 ACL 求值引擎（`server/src/acl/`）与本地校验器（`acl/validate.ts`）都以本文为准。

---

## 一、最危险的一条：`acls` 键「不存在」与「空数组」语义相反

源码依据 `hscontrol/policy/v2/policy.go:253`：

```go
if pm.pol == nil || (pm.pol.ACLs == nil && pm.pol.Grants == nil) {
    filter = tailcfg.FilterAllowAll
}
```

Go 里「键不存在」是 `nil`，「空数组」是**非 nil 的空切片**，两者走完全相反的分支：

| 策略内容 | `acls` 键 | 编译结果 | 实际效果 |
|---|---|---|---|
| `{}` | 不存在 | `FilterAllowAll` | **全通**：任意设备可达任意设备的任意端口 |
| `{"hosts":{...}}` | 不存在 | `FilterAllowAll` | **全通**（有 hosts 也照样全通！） |
| `{"acls":[]}` | 存在且为空 | `null` | **全禁**：所有设备之间完全不可达 |
| `{"acls":[{...}]}` | 存在且有内容 | 规则集 | 按规则放行，未命中即拒绝 |

**事故场景**：面板若在保存时把 `{}` 「规整」成 `{"acls":[]}`，会把整张网络**从全通静默翻成全禁**——业务瞬间中断，而日志里只看得到一次普通的策略保存。

**因此本项目的硬性约定**：
- `AclPolicy` 类型中 `acls?: AclRule[]`，**必须保留 `undefined` 与 `[]` 的区别**，任何地方都不得归一化。
- 校验器遇到这两种状态都产生 `highImpact` 警告，UI 显式提示。
- 推送前若模式的「全通/全禁」属性发生变化，后端返回 `409 NEED_ACK`，要求前端显式确认。

---

## 二、打标签是**不可逆**操作（tags-as-identity）

源码依据 `hscontrol/grpcv1.go:326-343`（注释为原文）：

```go
// User XOR Tags: nodes are either tagged or user-owned, never both.
// Setting tags on a user-owned node converts it to a tagged node.
// Once tagged, a node cannot be converted back to user-owned.
if len(request.GetTags()) == 0 {
    return status.Error(codes.InvalidArgument,
        "cannot remove all tags from a node - tagged nodes must have at least one tag")
}
```

三条硬事实（全部实测确认）：

1. **用户身份 ↔ 标签身份 二选一**。给一台用户所有的设备打上标签，它就**永久**脱离原用户。
2. **无法清空标签**。`SetTags(nodeId, [])` 直接返回 `InvalidArgument`（清空会让节点失去归属被孤立）。
   → 面板必须本地拦截并给出可读说明，而不是把上游英文错误透传出去。
3. **无法回退**。API 层没有任何路径把标签设备还原为用户所有。唯一的恢复方式是
   **删除该设备后重新注册**（设备会拿到新 IP，需要重建访问规则）。

**面板的义务**：首次给设备打标签时返回 `irreversible: true` 与警告文案，UI 必须弹窗确认。

### 连带影响：`user@` 规则不再命中标签设备

打标签后，headscale 在 API 表现层把该节点的 `user` 重写为虚拟用户：

```
TaggedDevicesUserID = 2147455555   // hscontrol/types/users.go:37
name                 = "tagged-devices"
```

源码注释（`hscontrol/grpcv1.go:557`）：*"Tags-as-identity: tagged nodes show as TaggedDevices user in API responses"*。

所以 ACL 规则里写的 `labadmin@` **永远不会**命中已打标签的设备，必须改用 `tag:xxx` 或 `autogroup:tagged`。

这是使用者最容易困惑的点（"我给设备打了标签，为什么原来的规则失效了"）。引擎会在求值轨迹里显式提示这一点。

### 附带发现：`user` 字段在两个接口上不一致

实测（`lab/probe_tag_user.py`）：

| 接口 | 已打标签设备的 `user` |
|---|---|
| `GET /api/v1/node`（列表） | `{id: 2147455555, name: "tagged-devices", displayName: "Tagged Devices"}` |
| `GET /api/v1/node/{id}`（单节点） | `null` |

**面板的处理**：`shapeNode()` 不依赖接口返回，只要 `tags.length > 0` 就认定归属为 `tagged-devices`，
并额外输出 `taggedIdentity: true` 供 UI 展示。若只按单节点接口判断，会把「已打标签」误判成「无归属」。

---

## 三、`action` 只支持 `"accept"`，没有 `deny`

源码依据 `hscontrol/policy/v2/types.go:1685`（`Action.UnmarshalJSON` 的 default 分支）：

```
action="deny" is not supported: invalid ACL action
```

「拒绝」完全靠**默认策略**实现：未命中任何 accept 规则即拒绝。因此：

- 规则里的 `action` 恒为 `"accept"`，写别的直接报错。
- 想让某段流量不通，不是「加一条 deny」，而是「**不要**写让它通的规则」。
- 注意 SSH 规则**支持** `accept` / `check` / `deny` 三种（与 ACL 规则不同），别混淆。

---

## 四、`proto` 不接受通配符 `*`

必须写协议名（`tcp`/`udp`/`icmp`/`icmpv6`/`sctp`/`gre`/`esp`/`ah`）或 IANA 编号 `0-255`。
写 `*` 会被上游拒绝。这个细节很容易踩，因为 `src`/`dst` 是可以用 `*` 的，唯独 proto 不行。

---

## 五、`dst` 必须带端口

- `dst` 里每个元素都必须是 `别名:端口` 形式。
- 端口支持：单端口 `443`、区间 `8000-8100`、逗号列表 `80,443`、通配 `*`。
- 漏写端口的 `"dst": ["100.64.0.1"]` 会被上游拒绝。
- 对比：`src` **不带**端口（源是设备/用户/网段，端口只对目的有意义）。

---

## 六、`autogroup` 的可用位置不对称

| autogroup | 可作为 src | 可作为 dst | 说明 |
|---|---|---|---|
| `autogroup:member` | ✅ | ✅ | 所有**未打标签**的设备（即仍属某个用户的设备） |
| `autogroup:tagged` | ✅ | ✅ | 所有**已打标签**的设备 |
| `autogroup:self` | ❌ | ✅ | 仅当 src 与 dst 是**同一用户**的设备时匹配 |
| `autogroup:internet` | ❌ | ✅ | 经出口节点访问互联网 |
| `autogroup:danger-all` | ✅ | ❌ | 字面意思：包括网络外的一切，慎用 |
| `autogroup:nonroot` | ❌ | ❌ | 仅 SSH 规则的 `users` 字段可用 |

`autogroup:self` 还有额外约束：**含它的规则，源只能是 user / group / `*` / `autogroup:member`**，
写成 `tag:xxx` 会被上游拒绝。

---

## 七、`tagOwners` 是打标签的前置条件

标签必须先出现在策略的 `tagOwners` 中，headscale 才允许把该标签授予设备。

未定义时上游返回 400：`requested tags [tag:xxx] are invalid or not permitted`。
面板把它映射为 `TAG_NOT_OWNED` 并提示"请先在 ACL 管理中定义 tagOwners"。

**与 `acls` 不同的是**：移除 `tagOwners` 里的条目**不会**让已打标签的设备掉标签（实测确认），
标签一旦授予就留在设备上。

---

## 八、`canAccess` 的判定语义（求值引擎对齐此逻辑）

源码依据 `hscontrol/types/node.go:406`。判定的关键点：

- **src 侧**：设备自身的 IP ＋ 它**已批准的子网路由**（`approvedRoutes`）。
  未批准的路由（`availableRoutes` 里但没批准的）**不参与**判定。
- **dst 侧**：对端设备 IP ＋ 对端已批准的子网路由；若对端是出口节点，还允许 `autogroup:internet`。
- **出口节点是独立分支**：`dstIsExitNode && DestsIsTheInternet()`。

### 两个容易写错的坑（本引擎初版就踩了）

1. **出口节点的 `0.0.0.0/0` 不能当"覆盖一切"的 CIDR**。
   出口节点会发布 `0.0.0.0/0` 作为已批准路由，若把它当普通 CIDR 做集合求交，
   任何源都会「命中」——等于规则失效。必须识别为默认路由并跳过。
2. **`autogroup:internet` 不是 "everything"**。
   它只在**目的**是出口节点时成立，对普通设备不成立。

这两点都会导致「面板说允许、实际不通」或反之，属于最难排查的一类偏差。
`lab/verify_acl_semantics.py` 通过与上游 `/debug/filter` 的编译结果交叉验证来守住这一点。

---

## 九、API 调用层面的坑（与 ACL 相关）

| 端点 | 坑 | 做法 |
|---|---|---|
| `PUT /api/v1/policy` | 无策略时 `GET` 返回错误码 2 而非空值 | 把"没有策略"与"读取失败"分开处理，前者应视为 `{}`（全通） |
| `POST /api/v1/policy/check` | 成功返回空对象 `{}` | 判断成功看 HTTP 状态，不看响应体 |
| `POST /api/v1/node/{id}/tags` | 非法标签格式返回 **500**（上游缺陷） | 面板必须本地先做格式校验，不依赖上游报错 |
| `POST /api/v1/node/{id}/tags` | 传空数组返回 400 | 面板本地拦截为 `CANNOT_CLEAR_TAGS`，给可读说明 |
| `expiry = 0001-01-01T00:00:00Z` | Go 零值，表示**永不过期**，不是"已过期" | 与 `null` 一并按永不过期处理 |

---

## 十、面板 ACL 能力的设计边界

headscale **不提供**以下能力，由面板补足：

| 能力 | headscale | 面板实现 |
|---|---|---|
| 「A 能否访问 B」查询 | 无（`/policy/check` 只校验语法） | `server/src/acl/evaluator.ts` 自研求值引擎 |
| 策略版本历史 | 无 | `server/src/services/acl-versions.ts` 自建版本库 |
| 带外变更检测 | 无 | 比对上游 `updatedAt` 与面板记录的 `hs_updated_at` |
| 高危变更拦截 | 无 | 模式变化（全通↔全禁）时返回 `409 NEED_ACK` |

**版本库的两条设计取舍**：
1. **回滚不删历史**：回滚＝把旧内容作为**新版本**重新应用，保留完整轨迹。否则回滚后
   就丢失了"回滚前是什么"这个排障关键证据。
2. **失败也入库**：推送失败仍记录版本（`applied=false` + `apply_error`），
   因为"谁在何时试图改什么、为什么失败"是运维刚需。
