#!/usr/bin/env bash
# 停止容器化联调环境。
#
# 默认**保留数据卷**（container/state/），下次 up.sh 直接复用：
# 保留 headscale 里的用户/设备/策略与面板的账号，避免每次重建都重新造数据。
# 需要彻底清空时加 --purge。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTR_DIR="${ROOT}/container"
STATE_DIR="${CTR_DIR}/state"

HS_CTR="${HS_CONTAINER:-hs-lab}"
PANEL_CTR="${PANEL_CONTAINER:-hs-panel}"
INFLUX_CTR="${INFLUX_CONTAINER:-hs-influx}"
NET="${HS_NET:-hs-lab-net}"

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m✓\033[0m %s\n' "$*"; }

PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

# 先停转发，避免端口占着又被新容器抢
PID_FILE="${STATE_DIR}/hostport.pid"
if [ -f "${PID_FILE}" ]; then
  PID="$(cat "${PID_FILE}")"
  if kill -0 "${PID}" 2>/dev/null; then
    log "停止对外转发（pid ${PID}）"
    kill "${PID}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}"
fi

for c in "${PANEL_CTR}" "${INFLUX_CTR}" "${HS_CTR}"; do
  if container list --all 2>/dev/null | awk '{print $1}' | grep -qx "${c}"; then
    log "停止并删除容器 ${c}"
    container stop "${c}" >/dev/null 2>&1 || true
    container delete "${c}" >/dev/null 2>&1 || true
  fi
done

if container network list 2>/dev/null | awk '{print $1}' | grep -qx "${NET}"; then
  log "删除网络 ${NET}"
  container network delete "${NET}" >/dev/null 2>&1 || true
fi

rm -f "${CTR_DIR}/endpoints.env"

if [ "${PURGE}" = "1" ]; then
  log "--purge：清空数据卷与密钥"
  rm -rf "${STATE_DIR}" "${CTR_DIR}/lab.env"
  ok "已彻底清空（下次 up.sh 会重新初始化 headscale 与面板账号）"
else
  ok "已停止（数据保留在 container/state/；彻底清空请用 --purge）"
fi
