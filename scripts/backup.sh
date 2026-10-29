#!/usr/bin/env bash
#
# 热备份 headscale-admin（一体化场景下连带 headscale）
#
# ## 为什么不能直接 cp panel.sqlite
#
# 面板用 WAL 模式。直接拷贝主库文件会**漏掉还在 WAL 里、但已提交的事务**，
# 恢复后表现为「最近一段时间的操作全丢了」—— 而且备份过程不报任何错，
# 让人以为备份成功了。cp 到一半有写入时还会拿到撕裂的快照。
#
# 正确做法是用 SQLite 自己的一致性快照接口。这里用 node:sqlite 的
# backup()（Node 22 内置，面板本身就跑在它上面，不引入新依赖）。
#
# ## 用法
#
#   ./scripts/backup.sh                      # 备份到 ./backups
#   BACKUP_DIR=/var/backups/hsa ./scripts/backup.sh
#   ./scripts/backup.sh --keep 90            # 保留 90 天（默认 30）
#
# ## 定时任务
#
#   0 3 * * * cd /opt/headscale-admin && ./scripts/backup.sh >> /var/log/hsa-backup.log 2>&1
#
# ## 恢复
#
#   ./scripts/restore.sh --help
#
# ## 退出码
#   0 成功
#   1 备份失败
#   2 环境不满足（找不到 compose / 容器没跑）
#   3 备份产物校验失败 —— 最危险的一种：以为成功其实不能用

set -euo pipefail

KEEP_DAYS=30
while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP_DAYS="${2:?--keep 需要天数值}"; shift 2 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="${BACKUP_DIR:-./backups}"
# ⚠️ docker compose exec / cp 要的是**服务名**（compose 文件里的 key），
#    不是 container_name。实测踩过：传 container_name 会报
#      service "headscale-admin" is not running
#    即使容器明明在跑。container_name 只用于 docker ps 检查。
PANEL_SVC="panel"
HS_SVC="headscale"
PANEL_CTR="${PANEL_CONTAINER_NAME:-headscale-admin}"
HS_CTR="${HS_CONTAINER_NAME:-headscale}"

log() { printf '  %s\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }
panel_node() { docker compose exec -T "$PANEL_SVC" node --no-warnings -e "$1"; }

# ---------------------------------------------------------------- 前置检查
command -v docker >/dev/null 2>&1 || die "找不到 docker" 2
# 明确区分「docker 没装」和「当前用户没权限」——两者的处理完全不同。
# 未加入 docker 组的用户需要 sudo，或把用户加入 docker 组后重新登录。
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then
    die "当前用户无权访问 docker.sock，请用 sudo 运行本脚本：sudo $0 $*" 2
  fi
  die "无法连接 docker 守护进程（未启动，或当前用户不在 docker 组且 sudo 需要密码）" 2
fi
docker compose version >/dev/null 2>&1 || die "找不到 docker compose v2" 2
running "$PANEL_CTR" || die "面板容器 $PANEL_CTR 没在运行（先 docker compose up -d）" 2

mkdir -p "$DEST"
echo "备份目标：$(cd "$DEST" && pwd)"

# ---------------------------------------------------------------- 面板库
log "面板数据库：容器内生成一致性快照"
panel_node '
const { DatabaseSync, backup } = require("node:sqlite");
const db = new DatabaseSync("/data/panel.sqlite");
backup(db, "/data/.backup-tmp.sqlite")
  .then(() => db.close())
  .catch((e) => { console.error(e.message); process.exit(1); });
' >/dev/null || die "容器内 backup() 失败"

# 校验：文件能打开、关键表在、账户表能读。
# 不做这一步的话，「备份文件存在」和「备份可用」是两件事。
log "校验快照可用性"
VERIFY="$(panel_node '
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync("/data/.backup-tmp.sqlite");
  // 参数化查询：避免在 shell 里嵌套 SQL 引号
  const tables = db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = ?").get("table").c;
  // 关键表逐一确认存在 —— 只看「表总数」会漏掉「表在但业务表缺了」的情况。
  // 注意：不要用 schema_migrations 判断迁移进度，那张表实际是空的，
  // 真正记录版本的是 schema_versions（实测确认）。
  const KEY = ["panel_users", "sessions", "settings", "acl_versions", "schema_versions"];
  const missing = KEY.filter((t) =>
    db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = ? AND name = ?").get("table", t).c === 0
  );
  const users = db.prepare("SELECT count(*) AS c FROM panel_users").get().c;
  db.close();
  console.log(JSON.stringify({ tables, users, missing }));
} catch (e) {
  console.log(JSON.stringify({ error: e.message }));
}
' 2>&1)" || true

if ! echo "$VERIFY" | grep -q '"tables"'; then
  panel_node 'require("node:fs").unlinkSync("/data/.backup-tmp.sqlite")' >/dev/null 2>&1 || true
  die "快照无法打开：$VERIFY" 3
fi

TABLES="$(echo "$VERIFY" | sed -n 's/.*"tables":\([0-9]*\).*/\1/p')"
USERS="$(echo "$VERIFY"  | sed -n 's/.*"users":\([0-9]*\).*/\1/p')"
[ "${TABLES:-0}" -ge 10 ] || die "快照只有 ${TABLES} 张表，明显不完整" 3
echo "$VERIFY" | grep -q '"missing":\[\]' \
  || die "快照缺少关键业务表：$VERIFY" 3

log "取出文件"
docker compose cp "$PANEL_SVC:/data/.backup-tmp.sqlite" "$DEST/panel-$STAMP.sqlite" >/dev/null \
  || die "docker compose cp 失败"
panel_node 'require("node:fs").unlinkSync("/data/.backup-tmp.sqlite")' >/dev/null 2>&1 || true
ok "panel-$STAMP.sqlite（${TABLES} 张表 / ${USERS} 个账户 / 关键表齐全）"

# ---------------------------------------------------------------- 主密钥
#
# ⚠️ 只备份 sqlite 而不备份 master.key 等于没备份：
#    恢复后库能打开、账号能登录，但所有加密字段（headscale API Key、
#    TOTP 密钥、OIDC 私钥）全是废数据。这种「看起来恢复了」的状态
#    比彻底失败更难排查。
log "加密主密钥"
if panel_node 'process.exit(require("node:fs").existsSync("/data/master.key") ? 0 : 1)'; then
  docker compose cp "$PANEL_SVC:/data/master.key" "$DEST/master-$STAMP.key" >/dev/null
  chmod 600 "$DEST/master-$STAMP.key"
  ok "master-$STAMP.key"
else
  log "  （无 master.key 文件：密钥来自 PANEL_MASTER_KEY 环境变量，请自行保管 .env）"
fi

# ---------------------------------------------------------------- headscale
#
# 只有一体化场景才有。
#
# ⚠️ headscale **没有 dump 子命令**（实测 `headscale dump` 报
#    `unknown command "dump"`，子命令只有 apikeys/auth/configtest/debug/
#    generate/health/nodes/policy/preauthkeys/serve/users/version）。
#    而且官方镜像是 distroless —— 连 ls 都没有，无法在容器内压包。
#
# 所以只能拷数据目录。为保证一致性**短暂停容器**（通常 1~3 秒，
# 期间客户端会重连，对 tailnet 无实质影响）。目录里除了 db.sqlite
# 还有 noise_private.key 与 derp 私钥 —— 丢了客户端全部失联、需重新注册，
# 所以整个目录一起打包，不只拷库。
if running "$HS_CTR"; then
  log "headscale 数据目录（短暂停容器以保证一致）"
  HS_DIR="$DEST/headscale-$STAMP"
  if docker compose stop "$HS_SVC" >/dev/null 2>&1; then
    mkdir -p "$HS_DIR"
    if docker compose cp "$HS_SVC:/var/lib/headscale/." "$HS_DIR/" >/dev/null 2>&1; then
      tar czf "$DEST/headscale-$STAMP.tar.gz" -C "$DEST" "headscale-$STAMP" 2>/dev/null \
        && rm -rf "$HS_DIR" \
        && ok "headscale-$STAMP.tar.gz（数据目录全量，含 noise/derp 私钥）" \
        || log "  ⚠️ 打包失败，保留目录 $HS_DIR"
    else
      log "  ⚠️ 拷贝数据目录失败"
      rm -rf "$HS_DIR"
    fi
  else
    log "  ⚠️ 停止 headscale 失败，跳过其备份（面板备份不受影响）"
  fi
  # 无论上面成败都要把 headscale 拉起来
  docker compose start "$HS_SVC" >/dev/null 2>&1 || log "  ⚠️ headscale 重启失败，请手工 docker compose start headscale"
else
  log "（未发现 headscale 容器 —— 对接外部 headscale 的场景属正常，跳过）"
fi

# ---------------------------------------------------------------- 清理
find "$DEST" -type f \( -name 'panel-*.sqlite' -o -name 'master-*.key' \
     -o -name 'headscale-*.tar.gz' -o -name 'headscale-*.sqlite' \) \
     -mtime "+${KEEP_DAYS}" -delete 2>/dev/null || true

# ---------------------------------------------------------------- 属主修正
#
# docker compose cp 以 root 落盘，若本脚本是用 sudo 跑的，产物会变成 root 属主，
# 之后普通用户既不能读也不能删，日常管理（拷走、清理）都被迫用 sudo。
# 这里把归属还给调用者（$SUDO_USER）。
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  chown -R "$SUDO_USER":"$(id -gn "$SUDO_USER" 2>/dev/null || echo "$SUDO_USER")" "$DEST" 2>/dev/null \
    && log "产物属主已归还给 $SUDO_USER" \
    || log "  ⚠️ 属主修正失败，后续操作可能需要 sudo"
fi

echo
echo "备份完成（保留 ${KEEP_DAYS} 天）："
for f in "$DEST"/*-"$STAMP".*; do
  [ -e "$f" ] || continue
  printf '  %-46s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
done
echo
echo "⚠️  master-*.key 与 panel-*.sqlite 必须**成对**保管："
echo "    只有库没有 key → 所有加密字段解不开（headscale API Key / TOTP / OIDC 私钥）。"
echo "    建议把 key 另存到密码管理器或独立介质，不要和库长期放在同一个备份目录。"
