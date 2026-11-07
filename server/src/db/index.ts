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
  _stmts.clear();
  _db?.close();
  _db = null;
}

/** 执行 DDL / 多语句脚本 */
export function exec(sql: string): void {
  db().exec(sql);
}

/**
 * 预编译语句缓存。
 *
 * 为什么必须有：`prepare()` 每次都要做 SQL 解析 + 编译 + 生成执行计划，
 * 而面板的读路径极热——每个请求至少 2 次（会话 + 权限），
 * 采样器每 15s 一轮。实测在鉴权钩子里每请求都编译一次是纯浪费：
 * 同一条 SQL 编译一次就够，语句对象本身无状态（参数每次传入）。
 *
 * 上限用简单的 FIFO 淘汰：`audit` 查询会拼出不同的 WHERE 组合，
 * 没有上限时 SQL 字符串会成为事实上的内存泄漏点。
 */
const STMT_CACHE_MAX = 256;
const _stmts = new Map<string, StatementSync>();

function prep(sql: string): StatementSync {
  const hit = _stmts.get(sql);
  if (hit) return hit;
  const stmt = db().prepare(sql);
  if (_stmts.size >= STMT_CACHE_MAX) {
    // Map 的迭代顺序即插入顺序，删最老的一条
    const oldest = _stmts.keys().next();
    if (!oldest.done) _stmts.delete(oldest.value);
  }
  _stmts.set(sql, stmt);
  return stmt;
}

/** 查询多行 */
export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return prep(sql).all(...normalizeAll(params)) as T[];
}

/** 查询单行 */
export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return prep(sql).get(...normalizeAll(params)) as T | undefined;
}

/** 写入，返回自增主键 */
export function run(sql: string, ...params: unknown[]): number {
  const res = prep(sql).run(...normalizeAll(params));
  return Number(res.lastInsertRowid ?? 0);
}

/** 写入，返回受影响行数 */
export function changes(sql: string, ...params: unknown[]): number {
  const res = prep(sql).run(...normalizeAll(params));
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
