#!/usr/bin/env node
/**
 * 一体化容器的 PID 1 监督器：headscale + headscale-admin 单容器双进程。
 *
 * ## 为什么需要它
 * 官方 `headscale/headscale:v0.29.7` 是 ko 构建的 distroless 镜像：
 * 没有 /bin/sh、没有包管理器、ENTRYPOINT 直接指向 headscale 二进制。
 * 因此既不能用 `sh -c "headscale serve & node ..."`，
 * 也不能装 s6-overlay / supervisord。用 Node（本来就要带）做监督器是最小解。
 *
 * ## 必须自己管生命周期
 * 一个容器两个进程，最危险的失败形态是「headscale 挂了、面板还活着」：
 * 容器看起来 healthy，实际所有管理操作都 401/超时。所以这里任一子进程退出
 * 都会终止另一个并以非零码退出，交给 `restart: unless-stopped` 拉起整个容器。
 * 同样，SIGTERM/SIGINT 要转发给两个进程，让面板有机会 flush 时序缓冲、关 DB，
 * headscale 有机会把 SQLite WAL 落盘。
 *
 * ## API Key 引导（可选）
 * 全新部署时 headscale 还没有 API Key，而面板需要它才能工作 —— 典型鸡生蛋问题。
 * 把 `HS_API_KEY` 设为 `auto`，监督器会在 headscale 就绪后调用其 CLI 创建一把，
 * 持久化到 `$PANEL_DATA_DIR/headscale-api-key`（仅容器内部可读，不进镜像），
 * 之后每次启动复用同一把；重启时会先用它探一次上游，失效（例如只恢复了其中
 * 一个数据卷）就删掉重建。面板侧用 `HS_API_KEY_MANAGED=1` 声明 env 为真源，
 * 避免库里残留的旧 key 让轮换后的面板继续 401。
 */
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const HEADSCALE_BIN = process.env.HEADSCALE_BIN || '/ko-app/headscale';
const HEADSCALE_CONFIG = process.env.HEADSCALE_CONFIG || '/etc/headscale/config.yaml';
const PANEL_CWD = process.env.PANEL_CWD || '/app';
const PANEL_ENTRY = process.env.PANEL_ENTRY || `${PANEL_CWD}/server/dist/index.js`;
const PANEL_DATA_DIR = process.env.PANEL_DATA_DIR || '/data';
// 刻意不叫 HS_PORT：compose 里 HS_PORT 常被用作「宿主发布端口」，
// 而这里指的是容器内 headscale 的监听端口，两者不能混用。
const HS_PORT = Number(process.env.HEADSCALE_HTTP_PORT || 8080);
const STARTUP_WAIT_MS = Number(process.env.ALLINONE_STARTUP_WAIT_MS || 30_000);
const SHUTDOWN_GRACE_MS = Number(process.env.ALLINONE_SHUTDOWN_GRACE_MS || 12_000);
const KEY_FILE = process.env.HS_API_KEY_FILE || `${PANEL_DATA_DIR}/headscale-api-key`;

// 容器内默认值：单独跑面板时这些值由 compose 注入，这里只兜底。
const DEFAULTS = {
  NODE_ENV: 'production',
  PANEL_HOST: '0.0.0.0',
  PANEL_PORT: '3000',
  PANEL_DATA_DIR,
  HS_URL: `http://127.0.0.1:${HS_PORT}`,
  TZ: 'Asia/Shanghai',
};
for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

const children = new Map();
let stopping = false;
let finalCode = 0;

/** 给两个进程的日志加前缀，避免 stdout 混在一起无法定位来源 */
function pipeWithTag(stream, tag, out) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    let nl;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      out.write(`[${tag}] ${line}\n`);
    }
  });
  stream.on('end', () => {
    if (pending) out.write(`[${tag}] ${pending}\n`);
  });
}

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.set(name, child);
  pipeWithTag(child.stdout, name, process.stdout);
  pipeWithTag(child.stderr, name, process.stderr);

  child.on('error', (err) => {
    process.stderr.write(`[supervisor] ${name} 无法启动：${err.message}\n`);
    if (!stopping) {
      finalCode = 1;
      void shutdown();
    }
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    const why = signal ? `signal ${signal}` : `exit ${code ?? 'unknown'}`;
    process.stderr.write(`[supervisor] ${name} 已退出（${why}），终止其余进程并让容器重启\n`);
    // 任一进程退出都视为容器级故障：正常退出也要非零码，才能触发 restart 策略
    finalCode = typeof code === 'number' && code !== 0 ? code : 1;
    void shutdown();
  });
  return child;
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children.values()) {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    }
  }
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (children.size > 0 && Date.now() < deadline) {
    await sleep(100);
  }
  for (const child of children.values()) {
    try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  process.exit(finalCode);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    process.stdout.write(`[supervisor] 收到 ${sig}，正在优雅关闭两个进程\n`);
    finalCode = 0;
    void shutdown();
  });
}
process.on('uncaughtException', (err) => {
  process.stderr.write(`[supervisor] 未捕获异常：${err.stack || err.message}\n`);
  finalCode = 1;
  void shutdown();
});

/** TCP 探测：不依赖任何 HTTP 路由，headscale 监听起来即算就绪 */
function tcpReady(port, timeoutMs = 800) {
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

async function waitForHeadscale() {
  const deadline = Date.now() + STARTUP_WAIT_MS;
  let failedEarly = false;
  while (Date.now() < deadline) {
    if (await tcpReady(HS_PORT)) return;
    // headscale 起不来时别干等 30 秒，让退出回调尽快接管
    if (children.get('headscale')?.exitCode !== null && children.get('headscale')?.exitCode !== undefined) {
      failedEarly = true;
      break;
    }
    await sleep(250);
  }
  if (!failedEarly) {
    process.stderr.write(
      `[supervisor] headscale 在 ${STARTUP_WAIT_MS}ms 内未监听 ${HS_PORT}，仍继续启动面板（面板会自动重试上游）\n`,
    );
  }
}

/** 旧 key 是否仍被当前 headscale 承认（数据卷被重置/单独恢复时会失效） */
async function apiKeyWorks(key) {
  try {
    const r = await fetch(`http://127.0.0.1:${HS_PORT}/api/v1/node`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * `HS_API_KEY=auto`：首次启动自己造一把 API Key 并复用。
 * 放在面板数据卷里而不是 /var/lib/headscale，是为了和面板 DB 同生命周期备份。
 */
async function resolveAutoApiKey() {
  if (existsSync(KEY_FILE)) {
    const saved = readFileSync(KEY_FILE, 'utf8').trim();
    if (saved) {
      if (await apiKeyWorks(saved)) return { key: saved, created: false };
      // key 文件在 panel-data 卷、key 本身在 headscale-data 卷：只恢复其中一个
      // 就会留下「文件在但上游不认」的僵尸 key，面板表现为所有操作 401。
      // 与其让人手工排查，不如删掉重建一把。
      unlinkSync(KEY_FILE);
      process.stderr.write('[supervisor] 已存的 API Key 不被当前 headscale 承认，重新创建\n');
    }
  }
  let lastOutput = '';
  // gRPC 控制口（50443）可能比 HTTP 口（8080）晚就绪，重试几次而不是直接放弃
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let raw;
    try {
      raw = execFileSync(
        HEADSCALE_BIN,
        ['apikeys', 'create', '--expiration', '999d', '--output', 'json', '--config', HEADSCALE_CONFIG],
        { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (err) {
      raw = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`;
    }
    const match = /hskey-api-[A-Za-z0-9_-]+/.exec(raw);
    if (match) {
      writeFileSync(KEY_FILE, match[0], { mode: 0o600 });
      return { key: match[0], created: true };
    }
    lastOutput = String(raw).slice(0, 300);
    if (attempt < 5) await sleep(1000);
  }
  throw new Error(`自动创建 Headscale API Key 失败，CLI 输出无法解析：${lastOutput}`);
}

async function main() {
  const provided = (process.env.HS_API_KEY || '').trim();
  const autoKey = !provided || provided === 'auto';

  process.stdout.write('[supervisor] 一体化容器启动：headscale v0.29.7 + headscale-admin\n');
  start('headscale', HEADSCALE_BIN, ['serve', '--config', HEADSCALE_CONFIG]);
  await waitForHeadscale();

  let apiKey = provided;
  if (autoKey) {
    try {
      const resolved = await resolveAutoApiKey();
      apiKey = resolved.key;
      process.stdout.write(`[supervisor] 已${resolved.created ? '创建' : '载入'} Headscale API Key（存于 ${KEY_FILE}）\n`);
    } catch (err) {
      // 不阻断面板启动：用户仍可在「设置 → Headscale 连接」里手动填
      process.stderr.write(`[supervisor] ${err.message}\n`);
      apiKey = '';
    }
  }

  start('panel', process.execPath, [PANEL_ENTRY], {
    cwd: PANEL_CWD,
    // autoKey 场景必须显式覆盖：否则字面量 "auto" 会被面板当成真密钥落库。
    // MANAGED=1 让面板每次启动都以监督器给的 key 为准（key 轮换/单卷恢复后不会残留旧值）。
    env: autoKey ? { HS_API_KEY: apiKey, HS_API_KEY_MANAGED: '1' } : {},
  });
}

main().catch((err) => {
  process.stderr.write(`[supervisor] 启动失败：${err.stack || err.message}\n`);
  finalCode = 1;
  void shutdown();
});
