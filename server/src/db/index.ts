/**
 * SQLite 访问层。
 *
 * 使用 Node 22 内置的 node:sqlite，零原生编译依赖（国内网络下 better-sqlite3
 * 的 prebuild 下载经常失败，这是刻意的取舍）。
 *
 * 注意 node:sqlite 的绑定值只接受 null / number / bigint / string / Uint8Array，
 * 传 boolean 会直接抛错——所以这里统一做归一化。
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, unknown>;

let _db: DatabaseSync | null = null;

/** node:sqlite 不认 boolean / undefined / Date，统一转换 */
function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  // 对象/数组一律 JSON 序列化，调用方负责解析
  return JSON.stringify(value);
}

function normalizeAll(params: unknown[]): SqlValue[] {
  return params.map(normalize);
}

/** 打开（或复用）数据库连接 */
export function openDb(file: string): DatabaseSync {
  if (_db) return _db;
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL 提升并发读性能；foreign_keys 保证级联删除生效
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  _db = db;
  return db;
}

export function db(): DatabaseSync {
  if (!_db) throw new Error('数据库未初始化，请先调用 openDb()');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/** 执行 DDL / 多语句脚本 */
export function exec(sql: string): void {
  db().exec(sql);
}

/** 查询多行 */
export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  const stmt: StatementSync = db().prepare(sql);
  return stmt.all(...normalizeAll(params)) as T[];
}

/** 查询单行 */
export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  const stmt: StatementSync = db().prepare(sql);
  return stmt.get(...normalizeAll(params)) as T | undefined;
}

/** 写入，返回自增主键 */
export function run(sql: string, ...params: unknown[]): number {
  const stmt: StatementSync = db().prepare(sql);
  const res = stmt.run(...normalizeAll(params));
  return Number(res.lastInsertRowid ?? 0);
}

/** 写入，返回受影响行数 */
export function changes(sql: string, ...params: unknown[]): number {
  const stmt: StatementSync = db().prepare(sql);
  const res = stmt.run(...normalizeAll(params));
  return Number(res.changes ?? 0);
}

/**
 * 事务包装。回调抛错时整体回滚。
 * SQLite 不支持嵌套事务，这里用 savepoint 兼容嵌套调用。
 */
let txDepth = 0;
export function tx<T>(fn: () => T): T {
  const nested = txDepth > 0;
  const name = `sp_${txDepth}`;
  if (nested) exec(`SAVEPOINT ${name}`);
  else exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    if (nested) exec(`RELEASE ${name}`);
    else exec('COMMIT');
    return out;
  } catch (err) {
    txDepth--;
    try {
      if (nested) exec(`ROLLBACK TO ${name}`);
      else exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始错误 */
    }
    throw err;
  }
}

/** JSON 列读取helper */
export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
