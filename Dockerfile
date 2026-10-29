# syntax=docker/dockerfile:1
#
# headscale-admin —— 生产镜像
#
# ## 与 container/Dockerfile.panel（联调用）的区别
#
# | | 本文件（生产） | Dockerfile.panel（联调） |
# |---|---|---|
# | 基础镜像 | `node:22-alpine`（可用 build-arg 换源） | 写死 daocloud 加速器 |
# | 用户 | **非 root**（node uid 1000） | root |
# | 依赖安装 | `npm ci --omit=dev` 分两阶段，只带运行期依赖 | 全量 |
# | 构建期校验 | 版本一致性 + 类型检查 + 健康探针 | 无 |
# | 标签 | OCI labels（version/revision/source） | 无 |
# | 体积优化 | 剔除 sourcemap、清理缓存 | 无 |
#
# ## 为什么一体化镜像（API + 静态资源同进程）
# 面板本身是单进程 Fastify 应用，前端已构建为静态文件由它托管。
# 拆成 nginx + api 两个容器只会增加联调复杂度与故障面，收益为零。
#
# ## 为什么用非 root
# 容器逃逸的主要放大器就是 root。面板需要写 /data（SQLite + 加密密钥），
# 把 /data 的属主给 node 用户即可，无需 root 权限。
#
# ## 构建参数
#
#   NODE_IMAGE     基础镜像。默认 node:22-alpine
#                  ⚠️ **必须带 tag**：不带 tag 会拿到 latest（Debian 版），
#                     本文件已不依赖包管理器所以能跑，但镜像会大很多。
#   NPM_REGISTRY   npm 源。默认官方；国内换 https://registry.npmmirror.com
#   PANEL_VERSION  版本号。**留空 = 沿用 package.json 的版本**（推荐）。
#                  只有 CI 需要按 git tag 强制对齐时才填。
#   VCS_REF        git commit，写进 OCI label，便于追查镜像来源
#   BUILD_DATE     构建时间，同上
#
# ## 常用命令
#
#   # 基本构建（版本自动取 package.json）
#   docker build -t headscale-admin:1.1.0 .
#
#   # 国内网络（基础镜像与 npm 源都换）
#   docker build \
#     --build-arg NODE_IMAGE=docker.m.daocloud.io/library/node:22-alpine \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     -t headscale-admin:1.1.0 .
#
#   # 多架构（amd64 + arm64），构建机需启用 buildx
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t registry.example.com/headscale-admin:1.1.0 --push .
#
#   # 带来源信息（CI 里用）
#   docker build \
#     --build-arg VCS_REF=$(git rev-parse --short HEAD) \
#     --build-arg BUILD_DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) \
#     -t headscale-admin:1.1.0 .
#
# ## 构建缓存
#
# npm 依赖层与编译产物都尽量走 BuildKit 缓存：改源码不重装依赖，
# 重复构建通常 10~30 秒完成。需要全新构建时加 --no-cache。
# ⚠️ 换 NODE_IMAGE 或 NPM_REGISTRY 会让依赖层缓存失效，属预期。

ARG NODE_IMAGE=node:22-alpine

# ============================================================
# 阶段 1：构建（含 devDependencies，需要 tsc / vite）
# ============================================================
FROM ${NODE_IMAGE} AS build

ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app

# 只在需要换源时写 .npmrc，避免默认情况下多一层缓存失效
RUN if [ "${NPM_REGISTRY}" != "https://registry.npmjs.org" ]; then \
      printf 'registry=%s\nfund=false\naudit=false\n' "${NPM_REGISTRY}" > /root/.npmrc; \
    fi

# 先只拷依赖清单 → 依赖层可缓存（改源码不重装依赖）
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

# 用 ci 而非 install：严格按 lockfile，构建可复现。
# --mount=type=cache：把 npm 缓存放到 BuildKit 缓存里而不是镜像层，
# 重复构建能跳过下载，且不会把缓存留在最终镜像中（省几十 MB）。
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# 再拷源码
COPY tsconfig.base.json ./
COPY server/ server/
COPY web/ web/
COPY scripts/ scripts/

# ---- 版本号 ----
#
# PANEL_VERSION **默认为空**，表示「沿用 package.json 里的版本」。
#
# ⚠️ 之前默认值是 `0.0.0-dev`，导致一个隐蔽缺陷：不传 --build-arg 时
#    （README 里推荐的 `docker build -t headscale-admin:latest .` 就是这种）
#    set-version.mjs 会把 package.json 从真实版本**改写成 0.0.0-dev**，
#    于是镜像里显示 0.0.0-dev —— 与「版本号单一真源（git tag → package.json）」
#    的设计直接冲突：真源本来是 package.json，默认构建反而把它冲掉。
#
# 现在的语义：
#   · 不传           → 用 package.json 里的版本（发版后构建到的就是真版本）
#   · 传了           → 覆盖并校验三个 package.json 一致（CI 用它对齐 tag）
ARG PANEL_VERSION=
RUN if [ -n "${PANEL_VERSION}" ]; then \
      echo "使用构建参数指定的版本：${PANEL_VERSION}" && \
      node scripts/set-version.mjs "${PANEL_VERSION}" && \
      node scripts/set-version.mjs --check "${PANEL_VERSION}"; \
    else \
      V="$(node -p "require('./package.json').version")" && \
      echo "未指定 PANEL_VERSION，沿用 package.json 版本：${V}" && \
      node scripts/set-version.mjs --check "${V}"; \
    fi

# 类型检查 + 构建（web 先，server 的静态资源托管依赖 web/dist）
RUN npm run typecheck && npm run build

# 剔除 sourcemap：运行期不需要，且会显著增大镜像并暴露源码结构
RUN find server/dist web/dist -name '*.map' -delete || true

# ============================================================
# 阶段 2：只装生产依赖（不含 devDependencies）
# ============================================================
FROM ${NODE_IMAGE} AS prod-deps

ARG NPM_REGISTRY=https://registry.npmjs.org

WORKDIR /app
RUN if [ "${NPM_REGISTRY}" != "https://registry.npmjs.org" ]; then \
      printf 'registry=%s\nfund=false\naudit=false\n' "${NPM_REGISTRY}" > /root/.npmrc; \
    fi

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

# --omit=dev 是关键：tsc / vite / playwright 这些都不进运行镜像。
# 同样走 cache mount：这一层的依赖与 build 阶段有大量重叠，缓存命中率高。
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ============================================================
# 阶段 3：运行
# ============================================================
FROM ${NODE_IMAGE} AS runtime

ARG PANEL_VERSION=
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

# OCI 标准标签：便于镜像仓库/编排系统识别来源与版本
LABEL org.opencontainers.image.title="headscale-admin" \
      org.opencontainers.image.description="Headscale v0.29.x Web 管理面板（设备/用户/ACL/路由/DNS/资源/监控/内置 OIDC Provider）" \
      org.opencontainers.image.version="${PANEL_VERSION:-see-package-json}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

ENV NODE_ENV=production \
    PANEL_HOST=0.0.0.0 \
    PANEL_PORT=3000 \
    PANEL_DATA_DIR=/data \
    PANEL_VERSION=${PANEL_VERSION} \
    TZ=Asia/Shanghai

# 只带运行期需要的东西
#
# ⚠️ 不要 COPY server/node_modules：npm workspaces 把依赖全部提升到根
# node_modules，子包目录下通常根本没有 node_modules，COPY 会报
# "failed to compute cache key: /app/server/node_modules: not found"。
# Node 的模块解析会从 /app/server/dist 逐级向上找到 /app/node_modules。
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./server/dist
COPY --from=build --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --from=build --chown=node:node /app/package.json ./package.json

# 数据卷：面板 SQLite、加密主密钥、会话密钥都落在这里，必须持久化。
# 丢了 /data 等于丢了所有账号与会话（master.key 丢了连加密设置都解不开）。
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# 非 root 运行
USER node

EXPOSE 3000

# 健康检查用面板自己的健康端点（它同时校验 DB 可达，不只是进程活着）。
# 注意：用 node 自带 fetch 而不是 curl/wget —— alpine 未必装，装了也增大体积。
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PANEL_PORT||3000)+'/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 不用 tini / dumb-init：
#
# 那类 init 进程主要解决「PID 1 不转发信号」与「回收僵尸进程」。
# 本面板**自己在 server/src/index.ts 里注册了 SIGINT/SIGTERM handler**
# （第 59-60 行），收到信号会走优雅关闭：停采样器、flush 时序缓冲、关 DB。
# 面板也不 fork 子进程，没有僵尸可回收。
#
# 更重要的是：装 init 需要包管理器（apk / apt），而基础镜像可能是
# Alpine 也可能是 Debian —— 实测踩过：`NODE_IMAGE` 传不带 tag 的镜像
# 默认拿 latest（Debian 版），硬编码的 `apk add tini` 直接
# `apk: not found` 构建失败。不依赖包管理器就能让同一份 Dockerfile
# 同时适配 alpine / debian / slim 各种 node 镜像。
CMD ["node", "server/dist/index.js"]
