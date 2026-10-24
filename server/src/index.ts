/**
 * 面板进程入口。
 *
 * 启动顺序：加载配置 → 建库/迁移 → 引导数据 → 起 HTTP 服务 → 注册优雅退出。
 * 任何一步失败都直接退出，不带病启动（管理面板带病运行比不启动更危险）。
 */
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { closeDb } from './db/index.ts';
import { purgeExpiredSessions } from './auth/session.ts';
import { PANEL_VERSION } from './routes/system.ts';
import { startPoller, stopPoller, pollOnce } from './realtime/hub.ts';

// node:sqlite 在 Node 22 仍会打 ExperimentalWarning，这里静音以免污染日志
const originalEmit = process.emit;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(process as any).emit = function (event: string, ...args: unknown[]): boolean {
  if (
    event === 'warning' &&
    typeof args[0] === 'object' &&
    args[0] !== null &&
    (args[0] as { name?: string }).name === 'ExperimentalWarning' &&
    /SQLite/i.test(String((args[0] as { message?: string }).message ?? ''))
  ) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (originalEmit as any).apply(process, [event, ...args]);
};

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = await buildApp();

  // 定期清理过期会话，避免表无限增长
  const cleanup = setInterval(() => {
    try {
      const n = purgeExpiredSessions();
      if (n > 0) app.log.info({ purged: n }, '已清理过期会话');
    } catch (err) {
      app.log.warn({ err }, '清理会话失败');
    }
  }, 3600_000);
  cleanup.unref();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, '收到退出信号，正在优雅关闭');
    try {
      stopPoller();
      await app.close();
      closeDb();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, '关闭过程出错');
      process.exit(1);
    }
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void shutdown(sig);
    });
  }

  await app.listen({ host: cfg.host, port: cfg.port });

  // 采样器要在 HTTP 起来之后启动（首轮采样需要能读 settings）
  startPoller(app.log);

  app.log.info(
    {
      面板版本: PANEL_VERSION,
      监听: `${cfg.host}:${cfg.port}`,
      对外地址: cfg.publicUrl,
      数据库: cfg.dbFile,
      时序库: cfg.influx.url ? 'InfluxDB' : 'SQLite 降级',
      采样: cfg.poll.enabled ? `${cfg.poll.intervalSec}s` : '已关闭',
    },
    'headscale-admin 已启动',
  );

  // 首屏对齐：先跑一次采样建立基线，避免前端首次连上时看到空状态
  try {
    const r = await pollOnce();
    app.log.info({ nodes: r.nodesTotal, online: r.nodesOnline }, '首轮采样完成');
  } catch (err) {
    app.log.warn({ err: err instanceof Error ? err.message : String(err) }, '首轮采样失败（不影响服务启动）');
  }
}

main().catch((err: unknown) => {
  console.error('启动失败：', err);
  process.exit(1);
});
