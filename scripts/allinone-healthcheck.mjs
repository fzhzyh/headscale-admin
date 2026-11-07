#!/usr/bin/env node
/**
 * 一体化容器健康检查：两个进程都要活着才算健康。
 *
 * - 面板：打 `/api/system/health`（它还会校验 DB 可达，不只是进程存在）
 * - headscale：只做 TCP 探测，刻意不依赖某个 HTTP 路由。
 *   v0.29 的 `headscale health` 走的是 gRPC（50443）而非 HTTP，
 *   且需要证书/客户端配置，放进 healthcheck 反而会误报不健康。
 *
 * 官方镜像是 distroless（无 sh/curl/wget），所以健康检查必须用 node 直接跑。
 */
import { connect } from 'node:net';

const PANEL_PORT = Number(process.env.PANEL_PORT || 3000);
const HS_PORT = Number(process.env.HEADSCALE_HTTP_PORT || 8080);

function tcpReady(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const [panelOk, headscaleOk] = await Promise.all([
  fetch(`http://127.0.0.1:${PANEL_PORT}/api/system/health`, {
    signal: AbortSignal.timeout(3000),
  })
    .then((r) => r.ok)
    .catch(() => false),
  tcpReady(HS_PORT),
]);

if (panelOk && headscaleOk) {
  console.log('healthy: panel + headscale');
  process.exit(0);
}
console.error(`unhealthy: panel=${panelOk} headscale=${headscaleOk}`);
process.exit(1);
