/**
 * DNS extra-records 路由（P5）
 *
 * 把「额外 DNS 记录」管在面板库里，并投影成 headscale 的 extra_records 文件。
 * headscale 用 fsnotify 监听该文件，写入即热加载，**不需要重启**。
 *
 * ## 三个实测确认过的硬约束
 * 1. **只支持 A / AAAA**。写其他类型上游会拒绝解析。
 * 2. **非法 JSON 会让 headscale 启动 fatal**：
 *      `setting up extrarecord manager: unmarshalling records ... invalid character`
 *    也就是说面板一旦写出坏内容，下次重启就再也起不来。所以：
 *      · 写入前先做「序列化 → 反序列化」往返校验
 *      · 原子写（同目录临时文件 + rename），避免读到半截内容
 *      · 写失败/校验失败一律不落盘
 * 3. **运行时重载是静默的**：写入后 headscale 不打印任何日志，也不暴露查询接口。
 *    所以「同步成功」只能保证「文件已按合法格式写好、headscale 会按约定热加载」，
 *    **不能**证明 DNS 已经能解析——那需要真实客户端。接口里如实标注这一点，
 *    不给用户一个假的「已验证生效」。
 *
 * ## 文件路径不能放在 /var/lib/headscale 下
 * 该目录本身是容器挂载点，其下再挂子目录会被父挂载遮蔽 →
 * fsnotify 监听一个不存在的路径，写文件毫无反应且无任何日志（最难排查的一类）。
 * 现在统一用独立的 `/dns` 挂载点（见 container/up.sh 与 hs-config.yaml）。
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { all, get, run } from '../db/index.ts';
import { audit } from '../services/audit.ts';
import { loadConfig } from '../config.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { nowIso } from '../util/time.ts';

/** extra_records 文件在面板容器内的路径（由 up.sh 通过 DNS_EXTRA_RECORDS_PATH 注入） */
function recordsPath(): string {
  const fromEnv = process.env.DNS_EXTRA_RECORDS_PATH;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  // 兜底：与 headscale 侧配置一致（容器内 /dns/extra-records.json）
  return loadConfig().extraRecordsPath || '/dns/extra-records.json';
}

interface DnsRow {
  id: number;
  name: string;
  type: string;
  value: string;
  comment: string | null;
  created_at: string;
  updated_at: string;
}

interface FileRecord {
  name: string;
  type: string;
  value: string;
}

function shape(r: DnsRow) {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    value: r.value,
    comment: r.comment ?? '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------- 校验
/**
 * DNS 名字校验：允许 `a.b.c` 形式，支持末尾点（绝对名）。
 * 不校验「是否属于 base_domain」——extra_records 本就用来指向体系外的名字。
 */
const DNS_NAME_RE = /^(?=.{1,253}$)([A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)*[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.?$/;

function validateName(name: string): string | null {
  const n = name.trim().replace(/\.$/, '');
  if (!n) return '记录名不能为空';
  if (!DNS_NAME_RE.test(n)) return `不是合法的 DNS 名：${name}`;
  // 明确拒绝通配符：headscale 的 extra_records 不支持 * 记录
  if (n.includes('*')) return 'extra_records 不支持通配符（*）记录';
  return null;
}

function isV4(s: string): boolean {
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

/** A 记录必须是 IPv4，AAAA 必须是 IPv6 —— 类型与值必须匹配，否则上游解析会出诡异问题 */
function validateTypeValue(type: string, value: string): string | null {
  const v = value.trim();
  if (!v) return '记录值不能为空';
  if (type === 'A') {
    if (!isV4(v)) return `A 记录的值必须是 IPv4 地址，收到：${v}`;
    return null;
  }
  if (type === 'AAAA') {
    if (!v.includes(':') || !/^[0-9a-fA-F:]+$/.test(v)) {
      return `AAAA 记录的值必须是 IPv6 地址，收到：${v}`;
    }
    return null;
  }
  return `只支持 A / AAAA 记录，收到：${type}`;
}

// ---------------------------------------------------------------- 文件读写
function readFileRecords(path: string): { ok: boolean; records: FileRecord[]; error?: string; exists: boolean } {
  if (!existsSync(path)) return { ok: true, records: [], exists: false };
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, records: [], error: '文件内容不是 JSON 数组', exists: true };
    const records: FileRecord[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        records.push({
          name: String(o.name ?? o.Name ?? ''),
          type: String(o.type ?? o.Type ?? ''),
          value: String(o.value ?? o.Value ?? ''),
        });
      }
    }
    return { ok: true, records, exists: true };
  } catch (e) {
    return { ok: false, records: [], error: e instanceof Error ? e.message : String(e), exists: true };
  }
}

/**
 * 原子写入。
 *
 * 为什么不是直接 writeFileSync：
 * fsnotify 监听 Write 事件，若在「已截断、未写完」的瞬间触发重载，
 * headscale 会读到半个 JSON。虽然运行时重载失败不会退出，
 * 但会把状态搞脏、且日志里什么都看不到。同目录临时文件 + rename 可避免。
 */
function writeRecordsAtomic(path: string, records: FileRecord[]): void {
  const body = `${JSON.stringify(records, null, 2)}\n`;
  // 往返校验：写之前先确认产出物能被解析，避免把坏内容落盘
  // （headscale 启动时遇到非法 JSON 会 fatal，代价是整个环境起不来）
  JSON.parse(body);

  const dir = dirname(path);
  const tmp = join(dir, `.extra-records.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o644 });
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 清理失败不影响主错误 */
    }
    throw e;
  }
}

/**
 * 上次由面板写入文件的记录快照（settings 键）。
 *
 * 为什么需要它：判断「文件里有、库里没有」的条目是**谁造成的**——
 *   · 面板刚删掉一条记录，但还没 apply → 文件里还留着它
 *   · 有人手工往文件里加了一条
 * 两者在文件里长得一样。没有快照的话，前者会被误判成后者，
 * 于是「删一条记录」会导致下次 apply 被 FILE_DRIFT 拦住（实测踩到）。
 *
 * 有了快照就能精确区分：
 *   fileOnly ∩ lastApplied  → 我们自己写的陈旧条目，apply 时静默移除
 *   fileOnly ∖ lastApplied  → 真正的手改，apply 前必须确认
 */
const LAST_APPLIED_KEY = 'dns.lastApplied';

function readLastApplied(): FileRecord[] {
  try {
    const raw = getSetting(LAST_APPLIED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FileRecord[]) : [];
  } catch {
    return [];
  }
}

function writeLastApplied(records: FileRecord[]): void {
  setSetting(LAST_APPLIED_KEY, JSON.stringify(records));
}

function keyOf(r: { name: string; type: string }): string {
  return `${r.name}\u0000${r.type}`;
}

/** 文件里既不在库、也不在「上次写入快照」里的条目 = 真正的手改 */
function computeHandMade(fileRecords: FileRecord[]): FileRecord[] {
  const applied = new Set(readLastApplied().map(keyOf));
  return fileRecords.filter(
    (f) => !applied.has(keyOf(f)) && !get<{ id: number }>('SELECT id FROM dns_records WHERE name = ? AND type = ?', f.name, f.type),
  );
}

/** 文件里是面板写过的、但库中已删除 —— 属于我们自己的陈旧条目 */
function computeStaleManaged(fileRecords: FileRecord[]): FileRecord[] {
  const applied = new Set(readLastApplied().map(keyOf));
  return fileRecords.filter(
    (f) => applied.has(keyOf(f)) && !get<{ id: number }>('SELECT id FROM dns_records WHERE name = ? AND type = ?', f.name, f.type),
  );
}

export async function registerDnsRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- 状态
  app.get('/api/dns/status', { preHandler: requirePermission('dns:read') }, async (_req, reply) => {
    const path = recordsPath();
    const file = readFileRecords(path);
    const dbCount = get<{ n: number }>('SELECT COUNT(*) AS n FROM dns_records')?.n ?? 0;
    let mtime: string | null = null;
    try {
      mtime = existsSync(path) ? statSync(path).mtime.toISOString() : null;
    } catch {
      mtime = null;
    }

    return reply.send({
      path,
      exists: file.exists,
      valid: file.ok,
      error: file.error ?? null,
      fileCount: file.records.length,
      dbCount,
      /** 文件与库是否一致（不一致通常意味着有人手改过文件，或用 apply 之前） */
      drift: file.ok ? file.records.length !== dbCount : null,
      mtime,
      /** 文件里出现、库里也没有、且**不是面板上次写的** → 真正的手改痕迹 */
      fileOnly: file.ok ? computeHandMade(file.records).map((f) => `${f.name} ${f.type} ${f.value}`) : [],
      /** 文件里残留的、面板自己写过但已从库删除的条目（apply 会静默清掉） */
      staleManaged: file.ok ? computeStaleManaged(file.records).map((f) => `${f.name} ${f.type} ${f.value}`) : [],
      constraints: {
        onlyAandAAAA: true,
        hotReload: 'fsnotify 监听文件变更，写入即生效，无需重启',
        invalidJsonIsFatal:
          'headscale 启动时若读到非法 JSON 会直接退出。面板写入前做往返校验 + 原子写，up.sh 启动前也会自愈坏文件。',
        silentReload:
          '运行时重载不打印日志、也没有查询接口，所以「已写入」只代表文件已按合法格式落盘，' +
          '不能证明 DNS 已可解析——那需要真实 Tailscale 客户端接入。',
      },
    });
  });

  // ---------------------------------------------------------------- 列表
  app.get('/api/dns/records', { preHandler: requirePermission('dns:read') }, async (_req, reply) => {
    const rows = all<DnsRow>('SELECT * FROM dns_records ORDER BY name, type');
    return reply.send({
      records: rows.map(shape),
      path: recordsPath(),
      stats: {
        total: rows.length,
        a: rows.filter((r) => r.type === 'A').length,
        aaaa: rows.filter((r) => r.type === 'AAAA').length,
      },
    });
  });

  // ---------------------------------------------------------------- 新增
  app.post('/api/dns/records', { preHandler: requirePermission('dns:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z
      .object({
        name: z.string().min(1).max(253),
        type: z.enum(['A', 'AAAA']),
        value: z.string().min(1).max(64),
        comment: z.string().max(300).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    const nameErr = validateName(parsed.data.name);
    if (nameErr) return reply.code(400).send({ error: 'BAD_NAME', message: nameErr });
    const valErr = validateTypeValue(parsed.data.type, parsed.data.value);
    if (valErr) return reply.code(400).send({ error: 'BAD_VALUE', message: valErr });

    const name = parsed.data.name.trim().replace(/\.$/, '');
    if (get<{ id: number }>('SELECT id FROM dns_records WHERE name = ? AND type = ?', name, parsed.data.type)) {
      return reply.code(409).send({
        error: 'DUP_RECORD',
        message: `已存在同名同类型的记录：${name} ${parsed.data.type}`,
      });
    }

    const now = nowIso();
    run(
      `INSERT INTO dns_records (name, type, value, comment, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      name,
      parsed.data.type,
      parsed.data.value.trim(),
      parsed.data.comment ?? null,
      now,
      now,
    );
    const row = get<DnsRow>('SELECT * FROM dns_records WHERE name = ? AND type = ?', name, parsed.data.type);

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'dns.create',
      targetType: 'dns_record',
      targetId: `${name}/${parsed.data.type}`,
      result: 'ok',
      detail: { value: parsed.data.value },
    });

    return reply.code(201).send({ record: row ? shape(row) : null, needApply: true });
  });

  // ---------------------------------------------------------------- 更新
  app.put('/api/dns/records/:id', { preHandler: requirePermission('dns:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    const existing = get<DnsRow>('SELECT * FROM dns_records WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '记录不存在' });

    const parsed = z
      .object({
        name: z.string().min(1).max(253).optional(),
        type: z.enum(['A', 'AAAA']).optional(),
        value: z.string().min(1).max(64).optional(),
        comment: z.string().max(300).nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    const nextName = parsed.data.name !== undefined ? parsed.data.name.trim().replace(/\.$/, '') : existing.name;
    const nextType = parsed.data.type ?? existing.type;
    const nextValue = parsed.data.value !== undefined ? parsed.data.value.trim() : existing.value;

    if (parsed.data.name !== undefined) {
      const e = validateName(parsed.data.name);
      if (e) return reply.code(400).send({ error: 'BAD_NAME', message: e });
    }
    // 类型和值要一起校验：把 A 改成 AAAA 时必须同时给 IPv6 值
    const valErr = validateTypeValue(nextType, nextValue);
    if (valErr) return reply.code(400).send({ error: 'BAD_VALUE', message: valErr });

    const dup = get<{ id: number }>(
      'SELECT id FROM dns_records WHERE name = ? AND type = ? AND id <> ?',
      nextName,
      nextType,
      id,
    );
    if (dup) return reply.code(409).send({ error: 'DUP_RECORD', message: '另一个记录已占用同名同类型' });

    run(
      `UPDATE dns_records SET name = ?, type = ?, value = ?, comment = ?, updated_at = ? WHERE id = ?`,
      nextName,
      nextType,
      nextValue,
      parsed.data.comment === undefined ? existing.comment : parsed.data.comment,
      nowIso(),
      id,
    );

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'dns.update',
      targetType: 'dns_record',
      targetId: `${nextName}/${nextType}`,
      result: 'ok',
      detail: { value: nextValue },
    });

    const row = get<DnsRow>('SELECT * FROM dns_records WHERE id = ?', id);
    return reply.send({ record: row ? shape(row) : null, needApply: true });
  });

  // ---------------------------------------------------------------- 删除
  app.delete('/api/dns/records/:id', { preHandler: requirePermission('dns:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    const existing = get<DnsRow>('SELECT * FROM dns_records WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '记录不存在' });

    run('DELETE FROM dns_records WHERE id = ?', id);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'dns.delete',
      targetType: 'dns_record',
      targetId: `${existing.name}/${existing.type}`,
      result: 'ok',
      detail: {},
    });
    return reply.send({ ok: true, needApply: true });
  });

  // ---------------------------------------------------------------- 应用到文件
  /**
   * 把库里的记录**整体**写成文件。
   *
   * 为什么是全量覆盖而不是增量追加：
   * 面板是这批记录的权威来源，全量写能让「删除」也自然生效，
   * 不需要在文件里维护删除标记。代价是**手改文件的内容会被覆盖**，
   * 所以 /api/dns/status 会先报 drift 与 fileOnly，让用户知道有手改痕迹。
   */
  app.post('/api/dns/apply', { preHandler: requirePermission('dns:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z.object({ force: z.boolean().default(false) }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'BAD_INPUT', message: '参数非法' });

    const path = recordsPath();
    const before = readFileRecords(path);

    // 只有**真正手改**的条目才需要确认；面板自己删掉、文件里还留着的陈旧条目
    // 属于正常流程（删除后还没 apply），不该拦。（实测踩过：不区分会让人
    // 删完一条记录就 apply 不了，还看不懂为什么）
    if (!parsed.data.force && before.ok) {
      const fileOnly = computeHandMade(before.records);
      if (fileOnly.length > 0) {
        return reply.code(409).send({
          error: 'FILE_DRIFT',
          message: `文件里有 ${fileOnly.length} 条记录不在面板库中，全量写入会覆盖掉它们`,
          fileOnly: fileOnly.map((f) => `${f.name} ${f.type} ${f.value}`),
          hint: '先确认这些是否是手工维护的；确认可覆盖后带 force: true 重试。',
        });
      }
    }

    const rows = all<DnsRow>('SELECT * FROM dns_records ORDER BY name, type');
    const records: FileRecord[] = rows.map((r) => ({ name: r.name, type: r.type, value: r.value }));

    try {
      writeRecordsAtomic(path, records);
    } catch (e) {
      return reply.code(500).send({
        error: 'WRITE_FAILED',
        message: `写入 extra_records 文件失败：${e instanceof Error ? e.message : String(e)}`,
        path,
      });
    }

    // 记下这次写了什么，供下次判断「文件里的差异是谁造成的」
    writeLastApplied(records);

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'dns.apply',
      targetType: 'dns_file',
      targetId: path,
      result: 'ok',
      detail: { count: records.length, replaced: before.records.length },
    });

    return reply.send({
      ok: true,
      path,
      count: records.length,
      replaced: before.records.length,
      /** 如实说明：写文件成功 ≠ DNS 已可解析 */
      note:
        '文件已按合法格式原子写入，headscale 会通过 fsnotify 热加载。' +
        '运行时重载不打印日志也没有查询接口，所以此处无法证明 DNS 已可解析——' +
        '需真实 Tailscale 客户端接入后验证。',
    });
  });
}
