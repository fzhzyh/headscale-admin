#!/usr/bin/env bash
#
# 恢复 headscale-admin 备份
#
# ## 用法
#
#   ./scripts/restore.sh --list                      # 看有哪些备份
#   ./scripts/restore.sh --panel backups/panel-20261029-030000.sqlite \
#                        --key   backups/master-20261029-030000.key
#   ./scripts/restore.sh --panel ... --key ... --yes  # 跳过交互确认
#
# ## 为什么必须成对恢复
#
# panel.sqlite 里的敏感字段（headscale API Key、TOTP 密钥、OIDC 私钥）是用
# master.key 加密的。只恢复库不恢复对应的 key，结果是：
#   · 数据库能打开，健康端点报 db:true
#   · 管理员能用旧口令登录
#   · 但 headscale 连接全部 401、2FA 全部失效、OIDC 签名失败
#
# 这种「看起来恢复了」的状态比彻底失败更难排查，所以本脚本**强制要求**
# 同时提供 --key（除非该备份确实没有 key 文件）。
#
# ## 恢复前的安全动作
#
# 自动把当前的 /data/panel.sqlite 与 master.key 备份到 .restore-backup-<戳>/，
# 万一恢复错了还能回去。

set -euo pipefail

# docker compose exec / cp 要服务名（见 backup.sh 同处注释）
PANEL_SVC="panel"
PANEL_CTR="${PANEL_CONTAINER_NAME:-headscale-admin}"
PANEL_SQLITE=""
KEY_FILE=""
ASSUME_YES=0
DO_LIST=0

log() { printf '  %s\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit "${2:-1}"; }

usage() { sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --list)  DO_LIST=1; shift ;;
    --panel) PANEL_SQLITE="${2:?--panel 需要文件路径}"; shift 2 ;;
    --key)   KEY_FILE="${2:?--key 需要文件路径}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage >&2; exit 2 ;;
  esac
done

running() { docker ps --format '{{.Names}}' | grep -qx "$1"; }
# 容器运行时用 exec；容器停着时必须用 run --rm（exec 要求容器在跑）
panel_node() { docker compose exec -T "$PANEL_SVC" node --no-warnings -e "$1"; }
# 一次性容器执行：继承服务的卷/环境，但不影响原容器，也不需要它处于运行状态。
# --no-deps 避免把 headscale 一起拉起来；--entrypoint node 绕过服务默认 CMD。
panel_run_node() {
  docker compose run --rm -T --no-deps --entrypoint node "$PANEL_SVC" --no-warnings -e "$1"
}

if [ "$DO_LIST" = "1" ]; then
  DEST="${BACKUP_DIR:-./backups}"
  echo "备份目录：$DEST"
  if [ -d "$DEST" ]; then
    ls -lh "$DEST" 2>/dev/null | awk 'NR>1{printf "  %-52s %s\n", $9, $5}' || log "（空）"
  else
    log "目录不存在"
  fi
  exit 0
fi

[ -n "$PANEL_SQLITE" ] || { echo "必须用 --panel 指定数据库备份（--help 看用法）" >&2; exit 2; }
[ -f "$PANEL_SQLITE" ] || die "数据库备份不存在：$PANEL_SQLITE" 2

if [ -n "$KEY_FILE" ] && [ ! -f "$KEY_FILE" ]; then
  die "密钥文件不存在：$KEY_FILE" 2
fi

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

echo
echo "即将恢复："
log "数据库：$PANEL_SQLITE（$(du -h "$PANEL_SQLITE" | cut -f1)）"
if [ -n "$KEY_FILE" ]; then
  log "主密钥：$KEY_FILE"
else
  warn "主密钥：**未提供** —— 若备份时的 key 与当前容器里的不一致，加密字段会全部失效"
fi

if [ "$ASSUME_YES" != "1" ]; then
  echo
  printf "确认覆盖当前面板数据？输入 yes 继续："
  read -r REPLY
  [ "$REPLY" = "yes" ] || { echo "已取消"; exit 0; }
fi

# ---------------------------------------------------------------- 自保备份
STAMP="$(date +%Y%m%d-%H%M%S)"
SAFE="./.restore-backup-$STAMP"
mkdir -p "$SAFE"
if running "$PANEL_CTR"; then
  log "先备份当前数据到 $SAFE"
  panel_node '
const { DatabaseSync, backup } = require("node:sqlite");
const db = new DatabaseSync("/data/panel.sqlite");
backup(db, "/data/.safe-tmp.sqlite")
  .then(() => db.close())
  .catch((e) => { console.error(e.message); process.exit(1); });
' >/dev/null 2>&1 && docker compose cp "$PANEL_SVC:/data/.safe-tmp.sqlite" "$SAFE/panel-before-restore.sqlite" >/dev/null 2>&1 \
    && ok "当前库已留存" || warn "当前库留存失败（继续恢复，但无法回退到恢复前状态）"
  docker compose exec -T "$PANEL_SVC" node --no-warnings -e \
    'require("node:fs").rmSync("/data/.safe-tmp.sqlite", { force: true })' >/dev/null 2>&1 || true
  docker compose cp "$PANEL_SVC:/data/master.key" "$SAFE/master-before-restore.key" >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- 停容器
log "停止面板容器"
# ⚠️ 必须真的停掉：SQLite 正在被面板进程使用，运行中覆盖文件会导致
#    后续读到损坏的页。停掉之后也不能用 exec（exec 要求容器在跑），
#    改用 run --rm 的一次性容器操作同一个卷。
docker compose stop "$PANEL_SVC" >/dev/null 2>&1 || true

# ---------------------------------------------------------------- 写入
#
# 用 stdin 喂给容器内的 node 写文件，而不是 docker cp：
# docker cp 会以 root 属主落盘，而容器内进程是 node(1000)，
# 恢复后可能读不了；容器又 cap_drop ALL 无法 chown。
log "写入数据库"
panel_run_node '
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.writeFileSync("/data/panel.sqlite", Buffer.concat(chunks));
  // 清掉残留的 WAL/SHM：旧 WAL 会被套用到新库上，导致数据错乱
  for (const f of ["/data/panel.sqlite-wal", "/data/panel.sqlite-shm"]) {
    fs.rmSync(f, { force: true });
  }
});
' < "$PANEL_SQLITE" || die "写入数据库失败"
ok "数据库已写入（并清理了残留 WAL/SHM）"

if [ -n "$KEY_FILE" ]; then
  log "写入主密钥"
  panel_run_node '
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  fs.writeFileSync("/data/master.key", Buffer.concat(chunks), { mode: 0o600 });
});
' < "$KEY_FILE" || die "写入主密钥失败"
  ok "主密钥已写入（权限 600）"
fi

# ---------------------------------------------------------------- 启动与验证
log "启动面板"
docker compose up -d "$PANEL_SVC" >/dev/null 2>&1 || die "启动失败"

log "等待健康检查"
for i in $(seq 1 30); do
  sleep 2
  if panel_node 'fetch("http://127.0.0.1:3000/api/system/health").then(r=>r.json()).then(j=>{console.log(JSON.stringify(j));process.exit(j.ok?0:1)}).catch(()=>process.exit(1))' 2>/dev/null; then
    break
  fi
  [ "$i" = "30" ] && die "60 秒内未通过健康检查，看 docker compose logs panel" 1
done

echo
echo "恢复完成。请手工确认以下三项（脚本无法代替）："
echo "  1. 能登录（用备份时的管理员口令）"
echo "  2. 系统设置页 → Headscale 连接显示正常"
echo "     ← 这一项才真正验证 master.key 与库匹配"
echo "  3. 2FA、OIDC 客户端等加密配置项回显正常（不是乱码）"
echo
echo "恢复前的数据已留存于：$SAFE"
echo "确认无误后可删除；若恢复有误，用它反向往回恢复。"
