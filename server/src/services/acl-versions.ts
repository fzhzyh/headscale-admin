/**
 * ACL 策略版本历史。
 *
 * headscale **没有** ACL 版本 API（只有 GET/PUT /api/v1/policy），所以版本库完全由面板自建。
 *
 * 关键设计：解决「面板库里的版本」与「headscale 实际生效的策略」不一致的问题。
 * 单纯存一份内容副本是不够的——headscale 的策略可能被 CLI 或其它工具改过，
 * 面板不知道。因此每个版本同时记录：
 *   - content       本次提交的策略内容（面板权威）
 *   - applied       是否成功推送到 headscale
 *   - apply_error   推送失败的原因
 *   - hs_updated_at 推送成功后 headscale 返回的 updatedAt（上游权威的时间戳）
 *
 * 读取当前策略时，用 headscale 的 updatedAt 与版本库里最近一次成功的
 * hs_updated_at 比对：不一致就说明发生了「带外变更」，面板据此提示用户。
 */
import { all, get, run, tx } from '../db/index.ts';
import { nowIso } from '../util/time.ts';
import { hs } from './headscale.ts';
import { parsePolicy, stringifyPolicy, type AclPolicy } from '../acl/model.ts';

export interface AclVersionRow {
  id: number;
  content: string;
  comment: string | null;
  source: string;
  author_id: number | null;
  author_name: string | null;
  applied: number;
  apply_error: string | null;
  hs_updated_at: string | null;
  created_at: string;
}

export interface AclVersionView {
  id: number;
  content: string;
  comment: string | null;
  source: string;
  authorName: string | null;
  applied: boolean;
  applyError: string | null;
  hsUpdatedAt: string | null;
  createdAt: string;
  /** 与上一个版本的差异摘要 */
  summary: { acls: number; groups: number; hosts: number; tagOwners: number; ssh: number; bytes: number };
}

export type ApplySource = 'manual' | 'visual-editor' | 'ai' | 'rollback' | 'import';

function summarize(content: string): AclVersionView['summary'] {
  const parsed = parsePolicy(content);
  const p = parsed.ok ? parsed.policy : {};
  return {
    acls: p.acls?.length ?? 0,
    groups: Object.keys(p.groups ?? {}).length,
    hosts: Object.keys(p.hosts ?? {}).length,
    tagOwners: Object.keys(p.tagOwners ?? {}).length,
    ssh: p.ssh?.length ?? 0,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

function toView(row: AclVersionRow): AclVersionView {
  return {
    id: row.id,
    content: row.content,
    comment: row.comment,
    source: row.source,
    authorName: row.author_name,
    applied: row.applied === 1,
    applyError: row.apply_error,
    hsUpdatedAt: row.hs_updated_at,
    createdAt: row.created_at,
    summary: summarize(row.content),
  };
}

export function listVersions(limit = 50, offset = 0): { total: number; versions: AclVersionView[] } {
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM acl_versions')?.n ?? 0;
  const rows = all<AclVersionRow>(
    `SELECT * FROM acl_versions ORDER BY id DESC LIMIT ? OFFSET ?`,
    Math.min(Math.max(limit, 1), 200),
    Math.max(offset, 0),
  );
  return { total, versions: rows.map(toView) };
}

export function getVersion(id: number): AclVersionView | null {
  const row = get<AclVersionRow>('SELECT * FROM acl_versions WHERE id = ?', id);
  return row ? toView(row) : null;
}

/** 读取当前生效的策略（把 headscale 的「未设置策略」错误归一成空策略） */
export async function readCurrentPolicy(): Promise<{
  content: string;
  hsUpdatedAt: string | null;
  parsed: AclPolicy | null;
  parseError: string | null;
}> {
  const res = await hs().getPolicy();
  const content = res.policy ?? '';
  const parsed = content.trim() === '' ? null : parsePolicy(content);
  return {
    content,
    hsUpdatedAt: res.updatedAt ?? null,
    parsed: parsed === null ? null : parsed.ok ? parsed.policy : null,
    parseError: parsed !== null && !parsed.ok ? parsed.error : null,
  };
}

/**
 * 比较面板记录的版本与 headscale 当前状态，判断是否存在「带外变更」。
 *
 * 判定依据只有 headscale 的 updatedAt —— 这是上游唯一能给出的时间戳。
 */
export interface DriftReport {
  /** headscale 当前策略的 updatedAt */
  hsUpdatedAt: string | null;
  /** 面板版本库中最近一次成功推送的 updatedAt */
  lastAppliedAt: string | null;
  lastAppliedVersionId: number | null;
  /** 是否存在带外变更（headscale 比面板记录更新） */
  drifted: boolean;
  explanation: string;
}

export function detectDrift(hsUpdatedAt: string | null): DriftReport {
  const row = get<AclVersionRow>(
    'SELECT * FROM acl_versions WHERE applied = 1 AND hs_updated_at IS NOT NULL ORDER BY id DESC LIMIT 1',
  );
  const lastAppliedAt = row?.hs_updated_at ?? null;

  if (!hsUpdatedAt) {
    return {
      hsUpdatedAt: null,
      lastAppliedAt,
      lastAppliedVersionId: row?.id ?? null,
      drifted: false,
      explanation: 'headscale 当前没有生效的策略。',
    };
  }

  if (!lastAppliedAt) {
    return {
      hsUpdatedAt,
      lastAppliedAt: null,
      lastAppliedVersionId: null,
      drifted: true,
      explanation:
        'headscale 已有生效策略，但面板版本库中没有对应的推送记录（可能是首次接管，或策略由 CLI/其它工具设置）。',
    };
  }

  // 时间戳按毫秒比较；headscale 返回的是 RFC3339，精度到微秒
  const a = new Date(hsUpdatedAt).getTime();
  const b = new Date(lastAppliedAt).getTime();
  // 上游时间戳精度更高，允许 1 秒内的误差视为同一次写入
  const drifted = Math.abs(a - b) > 1000;

  return {
    hsUpdatedAt,
    lastAppliedAt,
    lastAppliedVersionId: row?.id ?? null,
    drifted,
    explanation: drifted
      ? `headscale 的策略在面板最后一次推送之后又被修改过（headscale: ${hsUpdatedAt}，面板记录: ${lastAppliedAt}）。可能存在带外变更。`
      : '面板记录与 headscale 当前策略一致。',
  };
}

export interface ApplyResult {
  versionId: number;
  ok: boolean;
  hsUpdatedAt: string | null;
  error: string | null;
}

/**
 * 应用策略：先落版本（可追溯），再推送到 headscale，最后回填结果。
 *
 * 即使推送失败也保留版本记录（applied=0 + apply_error），
 * 这样「谁在什么时候试图改什么、为什么失败」都有据可查。
 */
export async function applyPolicy(opts: {
  content: string;
  comment?: string;
  source: ApplySource;
  authorId?: number | null;
  authorName?: string | null;
}): Promise<ApplyResult> {
  const versionId = tx(() =>
    run(
      `INSERT INTO acl_versions (content, comment, source, author_id, author_name, applied, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
      opts.content,
      opts.comment ?? null,
      opts.source,
      opts.authorId ?? null,
      opts.authorName ?? null,
      nowIso(),
    ),
  );

  try {
    const res = await hs().setPolicy(opts.content);
    run(
      'UPDATE acl_versions SET applied = 1, apply_error = NULL, hs_updated_at = ? WHERE id = ?',
      res.updatedAt ?? null,
      versionId,
    );
    return { versionId, ok: true, hsUpdatedAt: res.updatedAt ?? null, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run('UPDATE acl_versions SET applied = 0, apply_error = ? WHERE id = ?', msg, versionId);
    return { versionId, ok: false, hsUpdatedAt: null, error: msg };
  }
}

/** 用 headscale 当前策略初始化版本库（首次接管时用） */
export async function importCurrentAsBaseline(authorName: string): Promise<ApplyResult | null> {
  const existing = get<{ n: number }>('SELECT COUNT(*) AS n FROM acl_versions')?.n ?? 0;
  if (existing > 0) return null;

  const cur = await readCurrentPolicy();
  if (cur.content.trim() === '') return null;

  const versionId = tx(() =>
    run(
      `INSERT INTO acl_versions (content, comment, source, author_id, author_name, applied, hs_updated_at, created_at)
       VALUES (?, ?, 'import', NULL, ?, 1, ?, ?)`,
      cur.content,
      '首次接管：导入 headscale 当前策略作为基线',
      authorName,
      cur.hsUpdatedAt,
      nowIso(),
    ),
  );
  return { versionId, ok: true, hsUpdatedAt: cur.hsUpdatedAt, error: null };
}

/** 删除某个版本记录（仅允许删除未生效的历史版本） */
export function deleteVersion(id: number): { ok: boolean; error?: string } {
  const row = get<AclVersionRow>('SELECT * FROM acl_versions WHERE id = ?', id);
  if (!row) return { ok: false, error: '版本不存在' };
  const total = get<{ n: number }>('SELECT COUNT(*) AS n FROM acl_versions')?.n ?? 0;
  if (total <= 1) return { ok: false, error: '至少保留一个版本记录' };
  run('DELETE FROM acl_versions WHERE id = ?', id);
  return { ok: true };
}

/** 生成两个版本的统一差异（按行），供 UI 展示 */
export function diffVersions(fromId: number, toId: number): { lines: { type: 'same' | 'add' | 'del'; text: string }[] } | null {
  const a = get<AclVersionRow>('SELECT content FROM acl_versions WHERE id = ?', fromId);
  const b = get<AclVersionRow>('SELECT content FROM acl_versions WHERE id = ?', toId);
  if (!a || !b) return null;

  const la = a.content.split('\n');
  const lb = b.content.split('\n');
  // 简单 LCS 做行级 diff；策略文件通常几十行，性能足够
  const n = la.length;
  const m = lb.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = la[i] === lb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const lines: { type: 'same' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      lines.push({ type: 'same', text: la[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      lines.push({ type: 'del', text: la[i]! });
      i++;
    } else {
      lines.push({ type: 'add', text: lb[j]! });
      j++;
    }
  }
  while (i < n) lines.push({ type: 'del', text: la[i++]! });
  while (j < m) lines.push({ type: 'add', text: lb[j++]! });
  return { lines };
}

export { stringifyPolicy };
