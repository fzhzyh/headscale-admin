#!/usr/bin/env bash
# 拉起容器化的开发/测试环境（Apple container）。
#
# 架构：
#   容器 hs-lab   headscale v0.29.6   :8080 HTTP / :9090 metrics / :50443 gRPC
#   容器 hs-panel 面板 (Fastify+SPA)   :3000
#   两者同网络 hs-lab-net，面板按容器名 `hs-lab` 访问 headscale
#   宿主 lab/hostport.py 把 100.64.0.3:{8080,18080,19090,50443} 转发进容器
#
# ⚠️ 为什么要用宿主转发而不是 `container -p`：
#   实测 Apple container 1.5.0 的端口发布在本机**不可用**——宿主侧确实 LISTEN、
#   TCP 也能建连，但请求一律 `Connection reset by peer`（默认网络 / 自定义网络 /
#   绑定指定 IP / 绑定全接口，四种组合全部复现）。而「宿主 → 容器 IP 直连」完全正常。
#   因此本脚本用一层极简 TCP 转发绕开，对外地址仍是约定的 100.64.0.3。
#   若哪天 `-p` 修好了，删掉 start_proxy 即可，**测试侧地址不变**。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CTR_DIR="${ROOT}/container"
STATE_DIR="${CTR_DIR}/state"
ENV_FILE="${CTR_DIR}/lab.env"

NET="${HS_NET:-hs-lab-net}"
NET_SUBNET="${HS_NET_SUBNET:-192.168.80.0/24}"
HS_CTR="${HS_CONTAINER:-hs-lab}"
PANEL_CTR="${PANEL_CONTAINER:-hs-panel}"
INFLUX_CTR="${INFLUX_CONTAINER:-hs-influx}"
HS_IMAGE_DEFAULT="${HS_IMAGE:-ghcr.io/juanfont/headscale:v0.29.6}"
PANEL_IMAGE="${PANEL_IMAGE:-headscale-admin-panel:dev}"
INFLUX_IMAGE="${INFLUX_IMAGE:-docker.m.daocloud.io/library/influxdb:3.12.1-core}"
PUB_IP="${PUBLIC_IP:-100.64.0.3}"

# InfluxDB 组织/桶（时序数据落这里）
# 3.x 已无 org 概念；保留变量只为兼容旧 .env，不再注入容器
INFLUX_ORG="${INFLUX_ORG_NAME:-headscale}"
INFLUX_BUCKET="${INFLUX_BUCKET_NAME:-headscale_admin}"

HS_PUB_PORT=18080
METRICS_PUB_PORT=19090
GRPC_PUB_PORT=50443
PANEL_PUB_PORT=8080
INFLUX_PUB_PORT=18086

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "${STATE_DIR}"

# ---------------------------------------------------------------- 前置检查
log "检查 Apple container 可用性"
command -v container >/dev/null || die "未找到 container CLI（Apple container 未安装）"
container system status 2>&1 | grep -q "running" || {
  warn "container 系统服务未运行，尝试启动"
  container system start
}
ok "container $(container --version 2>&1 | head -1)"

# 取本机 Tailscale IP，确认对外地址真的是本机
if command -v tailscale >/dev/null; then
  TS_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  if [ -n "${TS_IP}" ] && [ "${TS_IP}" != "${PUB_IP}" ]; then
    warn "参数 PRIVATE_IP=${PUB_IP} 与本机 Tailscale IP(${TS_IP}) 不一致，请确认"
  fi
fi

# ---------------------------------------------------------------- 网络
if ! container network list 2>/dev/null | awk '{print $1}' | grep -qx "${NET}"; then
  log "创建网络 ${NET}（${NET_SUBNET}）"
  container network create "${NET}" --subnet "${NET_SUBNET}" >/dev/null
else
  log "复用已有网络 ${NET}"
fi

# ---------------------------------------------------------------- 清理旧容器
for c in "${HS_CTR}" "${PANEL_CTR}" "${INFLUX_CTR}"; do
  if container list --all 2>/dev/null | awk '{print $1}' | grep -qx "${c}"; then
    log "移除同名旧容器 ${c}"
    container stop "${c}" >/dev/null 2>&1 || true
    container delete "${c}" >/dev/null 2>&1 || true
  fi
done

# ---------------------------------------------------------------- headscale 镜像
# 目标平台：本机是 arm64；显式指定可避免解包多架构镜像的全部平台。
# 实测不指定时单个镜像可解出 65G（见 container/README.md 第 9 条）。
CTR_ARCH="$(uname -m)"
case "${CTR_ARCH}" in
  arm64|aarch64) CTR_PLATFORM="linux/arm64" ;;
  x86_64|amd64)  CTR_PLATFORM="linux/amd64" ;;
  *)             CTR_PLATFORM="linux/${CTR_ARCH}" ;;
esac

resolve_hs_image() {
  local cand found
  # 1) 本机已有就直接用（优先 juanfont 官方名，两个名字是同一 digest，仅为日志清晰）
  found="$(container image list 2>/dev/null | awk '/juanfont\/headscale/ {print $1":"$2; exit}')"
  if [ -z "${found}" ]; then
    found="$(container image list 2>/dev/null | awk '/headscale\/headscale/ {print $1":"$2; exit}')"
  fi
  if [ -n "${found}" ]; then echo "${found}"; return; fi

  # 2) 依次尝试。ghcr.io 直连可用但慢；docker.io 的官方名是**同一个 digest**
  #    （均 cabe84f06999），ghcr 拉不到时可等价替换。
  for cand in \
    "${HS_IMAGE_DEFAULT}" \
    "docker.io/headscale/headscale:v0.29.6" \
    "docker.m.daocloud.io/juanfont/headscale:v0.29.6"
  do
    log "尝试拉取 ${cand}（--platform ${CTR_PLATFORM}，可能较慢）" >&2
    if container image pull --platform "${CTR_PLATFORM}" "${cand}" >/dev/null 2>&1; then
      echo "${cand}"; return
    fi
    log "  ✗ ${cand} 失败，换下一个" >&2
  done

  # 3) 全部失败 → 容器内源码构建（不触碰宿主机 Go 环境）
  log "所有镜像源均失败，回落到「容器内源码构建」" >&2
  container build --platform "${CTR_PLATFORM}" \
    -f "${CTR_DIR}/Dockerfile.headscale" -t headscale:local "${CTR_DIR}" >&2
  echo "headscale:local"
}
HS_IMAGE="$(resolve_hs_image)"
ok "headscale 镜像：${HS_IMAGE}"

# ---------------------------------------------------------------- 启动 headscale
# ---------------------------------------------------------------- DNS extra-records 目录
# headscale 用 fsnotify 监听 extra_records_path，写文件即热生效。
# 该目录同时挂进面板容器（面板负责写入），headscale 负责读取。
DNS_DIR="${STATE_DIR}/dns"
DNS_FILE="${DNS_DIR}/extra-records.json"
mkdir -p "${DNS_DIR}"
# 首次创建空数组；刻意不用 `{}` 或空文件——headscale 会按非法 JSON 报错
if [ ! -f "${DNS_FILE}" ]; then
  printf '[]\n' > "${DNS_FILE}"
  log "初始化 DNS extra-records 文件（空数组）"
fi

# ⚠️ 自愈：非法 JSON 会让 headscale **启动 fatal**
#    （实测 `setting up extrarecord manager: unmarshalling records ... invalid character`，
#     容器起来又立刻退出）。面板侧若写坏过一次文件，整个联调环境就再也起不来。
#    这里在启动前校验，坏文件备份后重置为空数组——宁可丢几条记录，也不能把环境搞死。
if ! python3 -c "import json,sys;json.load(open(sys.argv[1]))" "${DNS_FILE}" 2>/dev/null; then
  BAD="${DNS_FILE}.invalid.$(date +%s)"
  cp "${DNS_FILE}" "${BAD}" 2>/dev/null || true
  printf '[]\n' > "${DNS_FILE}"
  warn "DNS extra-records 文件不是合法 JSON，已备份到 $(basename "${BAD}") 并重置为空数组"
fi
chmod 644 "${DNS_FILE}"

log "启动 headscale 容器 ${HS_CTR}"
mkdir -p "${STATE_DIR}/hs"
# ⚠️ 必须显式传 `serve`：官方镜像的 ENTRYPOINT 是 `headscale`，但没有默认 CMD，
# 不带子命令时它会打印帮助并以 0 退出——容器"成功"启动又立刻停止，
# 日志里只有一屏 help，极易误判成"启动失败但没报错"。
container run -d --name "${HS_CTR}" --network "${NET}" \
  -v "${DNS_DIR}:/dns" \
  -v "${CTR_DIR}/hs-config.yaml:/etc/headscale/config.yaml:ro" \
  -v "${STATE_DIR}/hs:/var/lib/headscale" \
  "${HS_IMAGE}" serve >/dev/null

log "等待 headscale 就绪"
# 健康检查从**宿主**用 curl 打容器 IP，而不是 `container exec` 进容器用 wget：
# 官方镜像里没有 wget/curl（实测 `wget: not found`），容器内探活会永远失败，
# 而实际服务早就起来了——这种"假失败"最浪费时间。
ctr_ip() { container list --all 2>/dev/null | awk -v n="$1" '$1==n {print $6}' | cut -d/ -f1; }
# wait_http <容器名> <端口> <路径> [次数] [期望状态码|any]
#
# accept=any 表示「只要 TCP 通了、拿到了任意 HTTP 响应就算就绪」。
# 这是给 InfluxDB 3.x 用的：它的 /health **需要认证**，无 token 时返回 401，
# 若仍按 200 判就绪会永远等不到。
wait_http() {
  local name="$1" port="$2" path="$3" limit="${4:-60}" accept="${5:-200}"
  local ip="" code=""
  for _ in $(seq 1 "$limit"); do
    ip="$(ctr_ip "$name")"
    if [ -n "$ip" ]; then
      code="$(curl -sS --noproxy '*' -m 2 -o /dev/null -w '%{http_code}' "http://${ip}:${port}${path}" 2>/dev/null || echo 000)"
      if [ "$accept" = "any" ]; then
        [ "$code" != "000" ] && { echo "$ip"; return 0; }
      else
        [ "$code" = "$accept" ] && { echo "$ip"; return 0; }
      fi
    fi
    sleep 2
  done
  return 1
}
HS_IP="$(wait_http "${HS_CTR}" 8080 /health 60)" || {
  echo "---- headscale 日志 ----" >&2
  container logs "${HS_CTR}" 2>&1 | tail -30 >&2
  die "headscale 未在 120s 内就绪"
}
ok "headscale 已就绪（${HS_IP}:8080）"

# ---------------------------------------------------------------- 生成/读取密钥
if [ ! -f "${ENV_FILE}" ]; then
  log "首次运行，生成面板密钥到 container/lab.env（已 gitignore）"
  cat > "${ENV_FILE}" <<EOF
# 容器化联调环境密钥 —— 由 container/up.sh 生成，不要提交
PANEL_MASTER_KEY=$(openssl rand -hex 32)
PANEL_SESSION_SECRET=$(openssl rand -hex 32)
PANEL_ADMIN_SECRET=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
EOF
  chmod 600 "${ENV_FILE}"
fi
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a

# ---------------------------------------------------------------- 创建 API Key
# 面板需要一个 headscale API Key 才能读写。每次重建 headscale 都要新建一把，
# 所以这里**存在 state 里复用**（key 与 headscale 数据库同生命周期）。
KEY_FILE="${STATE_DIR}/hs-api-key"
if [ ! -s "${KEY_FILE}" ]; then
  log "在 headscale 中创建 API Key（有效期 999 天）"
  container exec "${HS_CTR}" headscale -c /etc/headscale/config.yaml apikeys create --expiration 999d \
    > "${KEY_FILE}" 2>/dev/null || die "创建 API Key 失败（headscale 未初始化？）"
  chmod 600 "${KEY_FILE}"
fi
HS_API_KEY="$(tr -d '[:space:]' < "${KEY_FILE}")"
[ -n "${HS_API_KEY}" ] || die "API Key 为空：${KEY_FILE}"
ok "API Key 就绪（长度 ${#HS_API_KEY}）"

# ---------------------------------------------------------------- InfluxDB（时序库）
# 用途：设备在线状态 / 在线时长的历史曲线（P4）。
#
# ⚠️ 为什么只存「在线状态」不存「流量」：
# headscale 是**控制面**，只协调握手与下发 ACL/路由，端到端的数据流量是
# WireGuard 在设备之间直连的，不经过 headscale。因此 headscale 的 /metrics
# 里没有任何 bytes/traffic 指标（v0.29.6 实测只有 nodestore 内部计数），
# REST 节点对象也没有流量字段。要拿真实流量必须在每台设备上跑 agent 读
# tailscaled，本实验环境是 debug/node 合成的节点，没有 tailscaled。
# ⇒ 宁可不画，不造假数据。
INFLUX_TOKEN_FILE="${STATE_DIR}/influx-token"
if [ ! -s "${INFLUX_TOKEN_FILE}" ]; then
  openssl rand -hex 32 > "${INFLUX_TOKEN_FILE}"
  chmod 600 "${INFLUX_TOKEN_FILE}"
fi
INFLUX_TOKEN="$(tr -d '[:space:]' < "${INFLUX_TOKEN_FILE}")"

if ! container image list 2>/dev/null | grep -q "influxdb"; then
  log "本机无 InfluxDB 镜像，尝试拉取（--platform ${CTR_PLATFORM}）"
  container image pull --platform "${CTR_PLATFORM}" "${INFLUX_IMAGE}" >/dev/null 2>&1 \
    || die "InfluxDB 镜像拉取失败：${INFLUX_IMAGE}
  ⇒ 手工预拉后重试：
     container image pull --platform ${CTR_PLATFORM} ${INFLUX_IMAGE}"
fi

log "启动 InfluxDB 3.x 容器 ${INFLUX_CTR}"
mkdir -p "${STATE_DIR}/influx"
# ⚠️ 3.x 的数据目录是 /var/lib/influxdb3（2.x 是 /var/lib/influxdb2），
#    且镜像**已经以非 root（uid 1500 influxdb3）运行**，不能再加 --user 覆盖。
#
# ⚠️ bind mount 的属主放开到 777：宿主目录属主是当前用户（501），容器内是
#    uid 1500，不放开会：
#      Serve command failed: failed to initialize catalog: object store error:
#      UnableToCreateDir { code: 13, PermissionDenied,
#      path: "/var/lib/influxdb3/data/node1/catalog/v3" }
#    Apple container 不能用 Docker 那种「命名卷继承镜像属主」的办法，所以这里
#    退而用宽松权限 —— 仅本机联调环境，生产 compose 走命名卷不需要这一步。
chmod 777 "${STATE_DIR}/influx" 2>/dev/null || true
container run -d --name "${INFLUX_CTR}" --network "${NET}" \
  -v "${STATE_DIR}/influx:/var/lib/influxdb3" \
  -e INFLUXDB3_NODE_ID=labnode \
  -e INFLUXDB3_OBJECT_STORE=file \
  -e INFLUXDB3_DATA_DIR=/var/lib/influxdb3/data \
  "${INFLUX_IMAGE}" >/dev/null

log "等待 InfluxDB 就绪"
# accept=any：3.x 的 /health 需要认证，无 token 返回 401，不能按 200 判
INFLUX_IP="$(wait_http "${INFLUX_CTR}" 8181 /health 60 any)" || {
  echo "---- InfluxDB 日志 ----" >&2
  container logs "${INFLUX_CTR}" 2>&1 | tail -30 >&2
  die "InfluxDB 未在 120s 内就绪"
}

# ---------------------------------------------------------------- admin token
#
# 3.x 没有 2.x 那套 DOCKER_INFLUXDB_INIT_ADMIN_TOKEN —— token 必须在容器起来
# 之后显式创建，且**只有首次（库里还没有任何 token 时）可以无认证创建**。
#
# 所以这里分三种情况：
#   a) 文件里有 token 且实测可用      → 直接用
#   b) 文件里有 token 但被拒（401/403）→ 数据卷被重建过，旧 token 失效 → 重建
#   c) 文件不存在                      → 首次创建
influx_probe() {
  local tk="$1"
  [ -n "$tk" ] || return 1
  [ "$(curl -sS --noproxy '*' -m 3 -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${tk}" "http://${INFLUX_IP}:8181/health" 2>/dev/null)" = "200" ]
}
create_admin_token() {
  curl -sS --noproxy '*' -m 8 -X POST "http://${INFLUX_IP}:8181/api/v3/configure/token/admin" 2>/dev/null \
    | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

INFLUX_TOKEN="$(tr -d '[:space:]' < "${INFLUX_TOKEN_FILE}" 2>/dev/null || true)"

if influx_probe "${INFLUX_TOKEN}"; then
  log "InfluxDB token 有效（沿用 ${INFLUX_TOKEN_FILE}）"
else
  [ -n "${INFLUX_TOKEN}" ] && log "旧 token 已失效（数据卷可能被重建），重新创建"
  NEW_TOKEN="$(create_admin_token)"
  if [ -z "${NEW_TOKEN}" ]; then
    echo "---- InfluxDB 日志 ----" >&2
    container logs "${INFLUX_CTR}" 2>&1 | tail -20 >&2
    die "创建 InfluxDB admin token 失败（接口无 token 返回，可能是容器内已有其他 token）"
  fi
  printf '%s' "${NEW_TOKEN}" > "${INFLUX_TOKEN_FILE}"
  chmod 600 "${INFLUX_TOKEN_FILE}"
  INFLUX_TOKEN="${NEW_TOKEN}"
  influx_probe "${INFLUX_TOKEN}" || die "新创建的 InfluxDB token 仍不可用，检查 /health 认证"
  ok "已创建 InfluxDB admin token"
fi

ok "InfluxDB 已就绪（${INFLUX_IP}:8181，database=${INFLUX_BUCKET}）"

# ---------------------------------------------------------------- 构建并启动面板
# 先把 Dockerfile 的 FROM 基础镜像拉到本地，再构建。
# 原因：`container build` 解析 FROM 时要访问 registry，网络一抖就整个构建失败，
# 只抛一句 `Error: unknown: "HTTPClientError.remoteConnectionClosed"`——
# 看不出是基础镜像没拉到。预拉一次，失败可重试、可换源、可给出人话提示。
ensure_base_image() {
  local img="$1" cand
  if container image list 2>/dev/null | grep -qE "^${img%:*} +${img##*:}"; then
    log "基础镜像已在本地：${img}"
    return 0
  fi
  # 原引用失败时，换 docker.io 原名（同一镜像）+ daocloud 加速器
  local base="${img#*/library/}"
  base="${base#docker.m.daocloud.io/}"
  for cand in "${img}" "docker.m.daocloud.io/library/${base}" "docker.io/library/${base}"; do
    log "拉取基础镜像 ${cand}（--platform ${CTR_PLATFORM}）"
    if container image pull --platform "${CTR_PLATFORM}" "${cand}" >/dev/null 2>&1; then
      # 若拉到的是同内容不同引用，打个 :dev 别名不便，直接放行——构建时按 FROM 名字找
      [ "${cand}" = "${img}" ] || container image tag "${cand}" "${img}" >/dev/null 2>&1 || true
      ok "基础镜像就绪：${img}"
      return 0
    fi
    log "  ✗ ${cand} 失败"
  done
  die "基础镜像拉不到：${img}
  ⇒ 网络恢复后重试，或手工预拉：
     container image pull --platform ${CTR_PLATFORM} docker.m.daocloud.io/library/node:22-alpine"
}

ensure_base_image "docker.m.daocloud.io/library/node:22-alpine"

log "构建面板镜像 ${PANEL_IMAGE}（首次较慢）"
if ! container build -f "${CTR_DIR}/Dockerfile.panel" -t "${PANEL_IMAGE}" "${ROOT}" >/dev/null; then
  # 构建失败时把真实错误捞出来（上面重定向到了 /dev/null，单看 exit code 无从判断）
  log "构建失败，重跑一次以显示完整错误" >&2
  container build -f "${CTR_DIR}/Dockerfile.panel" -t "${PANEL_IMAGE}" "${ROOT}" >&2 \
    || die "面板镜像构建失败（见上方构建日志）"
fi
ok "面板镜像构建完成"

log "启动面板容器 ${PANEL_CTR}"
mkdir -p "${STATE_DIR}/panel"
# ⚠️ HS_URL 用**容器 IP** 而不是容器名：实测容器名解析返回 IPv6(2001:2::19)
# 与合成地址(198.18.x.x)，Node 的 fetch 优先 IPv6 → 连接失败；
# 而直连容器 IP 完全正常。容器 IP 每次重建可能变，下面「同步连接设置」会兜底。
container run -d --name "${PANEL_CTR}" --network "${NET}" \
  -v "${STATE_DIR}/panel:/data" \
  -v "${DNS_DIR}:/dns" \
  -e DNS_EXTRA_RECORDS_PATH=/dns/extra-records.json \
  -e PANEL_HOST=0.0.0.0 \
  -e PANEL_PORT=3000 \
  -e PANEL_DATA_DIR=/data \
  -e PANEL_PUBLIC_URL="http://${PUB_IP}:${PANEL_PUB_PORT}" \
  -e PANEL_MASTER_KEY="${PANEL_MASTER_KEY}" \
  -e PANEL_SESSION_SECRET="${PANEL_SESSION_SECRET}" \
  -e PANEL_ADMIN_USER=admin \
  -e PANEL_ADMIN_SECRET="${PANEL_ADMIN_SECRET}" \
  -e HS_URL="http://${HS_IP}:8080" \
  -e HS_GRPC_ADDR="${HS_IP}:50443" \
  -e HS_API_KEY="${HS_API_KEY}" \
  -e HS_TRANSPORT=rest \
  -e LOGIN_RATE_MAX="${LOGIN_RATE_MAX_LAB:-300}" \
  -e LOGIN_RATE_WINDOW_SEC=300 \
  -e INFLUX_URL="http://${INFLUX_IP}:8181" \
  -e INFLUX_BUCKET="${INFLUX_BUCKET}" \
  -e INFLUX_TOKEN="${INFLUX_TOKEN}" \
  "${PANEL_IMAGE}" >/dev/null

log "等待面板就绪"
PANEL_IP="$(wait_http "${PANEL_CTR}" 3000 /api/system/health 40)" || {
  echo "---- 面板日志 ----" >&2
  container logs "${PANEL_CTR}" 2>&1 | tail -30 >&2
  die "面板未在 80s 内就绪"
}
ok "面板已就绪（${PANEL_IP}:3000）"

# ---------------------------------------------------------------- 同步连接设置
# 面板把 hs.url / hs.apiKey 存在自己的 SQLite 里，只在**首次**启动时从环境变量播种。
# 容器重建后 headscale 的 IP 可能变化，不同步就会一直连旧地址 → 全部请求超时。
# 这里每次启动都对齐一次，保证「重建即可用」。
log "同步面板的 Headscale 连接设置"
# 面板把 hs.url / hs.apiKey 存在自己的 SQLite 里，只在**首次**启动时从环境变量播种。
# 容器重建后 headscale 的 IP 会变，不同步就会一直连旧地址 → 所有业务接口超时。
#
# 用 cookie jar 而不是手工拼 Cookie 头：早先手工解析 Set-Cookie 的写法
# 在实际跑的时候取不到会话，PUT 静默失败，于是面板一直连着旧地址。
JAR="${STATE_DIR}/cookies.txt"
rm -f "${JAR}"
LOGIN_JSON="$(curl -sS --noproxy '*' -m 10 -c "${JAR}" -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"${PANEL_ADMIN_SECRET}\"}" \
  "http://${PANEL_IP}:3000/api/auth/login" 2>/dev/null || echo '{}')"
CSRF="$(printf '%s' "${LOGIN_JSON}" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("csrfToken",""))
except Exception: print("")' 2>/dev/null)"

if [ -n "${CSRF}" ]; then
  SYNC="$(curl -sS --noproxy '*' -m 12 -b "${JAR}" -X PUT \
    -H "X-CSRF-Token: ${CSRF}" -H 'Content-Type: application/json' \
    -d "{\"items\":{\"hs.url\":\"http://${HS_IP}:8080\",\"hs.grpcAddr\":\"${HS_IP}:50443\",\"hs.apiKey\":\"${HS_API_KEY}\"}}" \
    "http://${PANEL_IP}:3000/api/settings" 2>/dev/null || echo '{}')"
  case "${SYNC}" in
    *'"ok":true'*) ok "连接设置已对齐（hs.url=http://${HS_IP}:8080）" ;;
    *) warn "设置同步返回异常：${SYNC}" ;;
  esac

  # 用**真正访问 headscale 的**接口验证连通性。
  # 注意别用 /api/system/overview —— 它只读本地面板库、不碰 headscale，
  # 用它会得到"连通已确认"的假阳性（这个坑踩过）。
  NODES="$(curl -sS --noproxy '*' -m 15 -b "${JAR}" \
    "http://${PANEL_IP}:3000/api/nodes" 2>/dev/null | head -c 200)"
  case "${NODES}" in
    *HEADSCALE_TIMEOUT*|*'"error"'*) warn "面板仍无法访问 headscale：${NODES}" ;;
    *'"nodes"'*) ok "面板 ↔ headscale 连通已确认（/api/nodes 正常）" ;;
    *) warn "连通性验证返回意外内容：${NODES}" ;;
  esac
else
  warn "无法登录面板以同步设置（管理员口令可能已改），跳过"
fi

# ---------------------------------------------------------------- 对外发布
[ -n "${HS_IP}" ] && [ -n "${PANEL_IP}" ] || die "无法取得容器 IP"
ok "容器 IP：${HS_CTR}=${HS_IP}  ${PANEL_CTR}=${PANEL_IP}"

PID_FILE="${STATE_DIR}/hostport.pid"
if [ -f "${PID_FILE}" ] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  log "停止旧的转发进程 $(cat "${PID_FILE}")"
  kill "$(cat "${PID_FILE}")" 2>/dev/null || true
  sleep 1
fi

log "启动对外转发（${PUB_IP} → 容器）"
nohup python3 "${ROOT}/lab/hostport.py" \
  --bind "${PUB_IP}" \
  "${PANEL_PUB_PORT}=${PANEL_IP}:3000" \
  "${HS_PUB_PORT}=${HS_IP}:8080" \
  "${METRICS_PUB_PORT}=${HS_IP}:9090" \
  "${GRPC_PUB_PORT}=${HS_IP}:50443" \
  "${INFLUX_PUB_PORT}=${INFLUX_IP}:8181" \
  > "${STATE_DIR}/hostport.log" 2>&1 &
echo $! > "${PID_FILE}"
sleep 2
kill -0 "$(cat "${PID_FILE}")" 2>/dev/null || { cat "${STATE_DIR}/hostport.log"; die "转发进程启动失败"; }
ok "转发已启动（pid $(cat "${PID_FILE}")）"

# 回写到 lab/ 下的地址文件，测试脚本据此取地址
cat > "${CTR_DIR}/endpoints.env" <<EOF
# 由 container/up.sh 生成：测试统一从这里取对外地址
PANEL_URL=http://${PUB_IP}:${PANEL_PUB_PORT}
HS_URL=http://${PUB_IP}:${HS_PUB_PORT}
HS_DEBUG_URL=http://${PUB_IP}:${METRICS_PUB_PORT}
INFLUX_URL=http://${PUB_IP}:${INFLUX_PUB_PORT}
HS_CONTAINER=${HS_CTR}
PANEL_CONTAINER=${PANEL_CTR}
INFLUX_CONTAINER=${INFLUX_CTR}
HS_CONTAINER_IP=${HS_IP}
PANEL_CONTAINER_IP=${PANEL_IP}
INFLUX_CONTAINER_IP=${INFLUX_IP}
EOF

echo
echo "────────────────────────────────────────────────────────"
ok "容器化联调环境已就绪"
echo "  面板        http://${PUB_IP}:${PANEL_PUB_PORT}"
echo "  headscale   http://${PUB_IP}:${HS_PUB_PORT}"
echo "  指标        http://${PUB_IP}:${METRICS_PUB_PORT}"
echo "  InfluxDB    http://${PUB_IP}:${INFLUX_PUB_PORT}"
echo "  管理员      admin / ${PANEL_ADMIN_SECRET}"
echo "  （密钥见 container/lab.env，地址见 container/endpoints.env）"
echo "────────────────────────────────────────────────────────"
echo "  停止：container/down.sh"
