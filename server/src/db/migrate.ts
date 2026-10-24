/**
 * 数据库迁移。
 *
 * 用 schema_versions 表记录已应用版本；每个迁移只跑一次，可重复执行。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, exec, all, run, tx } from './index.ts';
import { loadConfig } from '../config.ts';
import { nowIso } from '../util/time.ts';
import { seedBootstrap } from './seed.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface Migration {
  version: number;
  name: string;
  up: () => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: () => {
      const sql = readFileSync(join(here, 'schema.sql'), 'utf8');
      exec(sql);
    },
  },
];

export function migrate(opts: { quiet?: boolean } = {}): { applied: number[]; alreadyAt: number } {
  exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const done = new Set(all<{ version: number }>('SELECT version FROM schema_versions').map((r) => r.version));
  const applied: number[] = [];

  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    tx(() => {
      m.up();
      run('INSERT INTO schema_versions (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, nowIso());
    });
    applied.push(m.version);
    if (!opts.quiet) console.log(`  ✓ migration ${m.version} ${m.name}`);
  }

  const maxVersion = Math.max(0, ...Array.from(done), ...applied);
  return { applied, alreadyAt: maxVersion };
}

export { nowIso };

/** CLI 入口：npm run migrate */
export async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`面板数据库：${cfg.dbFile}`);
  openDb(cfg.dbFile);
  const { applied } = migrate();
  console.log(applied.length ? `已应用 ${applied.length} 个迁移` : '结构已是最新，无需迁移');
  const seeded = await seedBootstrap();
  if (seeded) console.log('已初始化引导数据');
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err: unknown) => {
    console.error('迁移失败：', err);
    process.exit(1);
  });
}
