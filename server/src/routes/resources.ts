/**
 * 资源中心路由（P5）
 *
 * 把「IP + 端口」形式的内部资源管起来，并同步为 ACL 策略里的 `hosts` 条目。
 *
 * ## 为什么 hosts 只能存 IP，端口必须留在规则里
 * Tailscale/headscale 的 ACL `hosts` 是 **名字 → IP/CIDR** 的映射，
 * 语法上不承载端口。端口只能出现在规则的 `dst` 里，写成 `资源名:端口`。
 * 所以资源中心的模型是「name + ip(+ports)」：
 *   · `name`/`ip` → 进 hosts
 *   · `ports`/`protocol` → 只用于**生成参考规则**，不进 hosts
 * 这一点如果搞错（把 `1.2.3.4:22` 塞进 hosts），上游会直接拒绝解析。
 *
 * ## 同步绝不动 acls
 * 只合并 `hosts`，不碰 `acls`/`grants`。原因见 docs/acl-semantics.md：
 *   `{}`（无 acls 键）→ 全通；`{"acls":[]}` → 全禁
 * 同步逻辑若顺手「补一个空 acls 数组」，会把全网从全通静默翻成全禁。
 * 这类错误代价极大，所以宁可不做。
 *
 * ## 权限控制不自动改连通性
 * `owner_group` 是**面板组**，与 headscale 的网络身份不是同一个概念。
 * 面板账户通过 `panel_user_hs_users` 绑定网络身份，所以「组内成员对应哪些
 * 网络用户」是可推导的。但**推导结果只作为「参考规则」返回给用户看**，
 * 不自动写进策略——自动给一批人开权限是高风险动作，必须由人确认。
 *
 * ## 冲突策略
 * 已存在的 hosts 条目若与资源定义不一致，默认**拒绝同步**并列出冲突，
 * 需要显式 `overwrite: true` 才覆盖。宁可让用户多确认一次，
 * 也不要悄悄改掉别人手工维护的主机别名。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { authOr401, requirePermission, csrfOk } from '../auth/guard.ts';
import { all, get, run } from '../db/index.ts';
import { audit } from '../services/audit.ts';
import { readCurrentPolicy, applyPolicy } from '../services/acl-versions.ts';
import { interpretPolicy, parsePolicy, stringifyPolicy, type AclPolicy } from '../acl/model.ts';
import { nowIso } from '../util/time.ts';

// ---------------------------------------------------------------- 校验
/**
 * ACL hosts 的键名限制。
 * 必须排除 ACL 的身份语法（`user@`、`tag:x`、`group:x`、`autogroup:x`）——
 * 用这些名字当 hosts 键会和身份别名冲突，上游解析结果不可预期。
 */
const RESOURCE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

const RESERVED_PREFIXES = ['tag:', 'group:', 'autogroup:'];

function validateName(name: string): string | null {
  if (!RESOURCE_NAME_RE.test(name)) {
    return '资源名只能包含字母、数字、下划线和短横线，且以字母或数字开头（最长 63）';
  }
  const lower = name.toLowerCase();
  if (RESERVED_PREFIXES.some((p) => lower.startsWith(p))) {
    return `资源名不能以 ${RESERVED_PREFIXES.join(' / ')} 开头——这些是 ACL 身份语法`;
  }
  if (lower === 'autogroup' || lower.includes('@')) {
    return '资源名不能包含 @ 或与 autogroup 同名——会与 ACL 身份别名冲突';
  }
  return null;
}

/** 严格校验 IPv4 / IPv6 / CIDR（不追求覆盖所有 IPv6 写法，但要挡住明显错的） */
function validateIp(value: string): string | null {
  const v = value.trim();
  if (!v) return 'IP 不能为空';

  const isV4 = (s: string): boolean => {
    const parts = s.split('.');
    if (parts.length !== 4) return false;
    return parts.every((p) => {
      if (!/^\d{1,3}$/.test(p)) return false;
      const n = Number(p);
      return n >= 0 && n <= 255;
    });
  };

  const [addr, prefix, ...rest] = v.split('/');
  if (rest.length > 0) return `不是合法的 IP 或 CIDR：${value}`;
  if (prefix !== undefined) {
    const p = Number(prefix);
    if (!/^\d{1,3}$/.test(prefix) || !Number.isInteger(p) || p < 0) {
      return `CIDR 前缀不合法：${value}`;
    }
    if (addr && isV4(addr) && p > 32) return `IPv4 前缀不能超过 32：${value}`;
    if (addr && addr.includes(':') && p > 128) return `IPv6 前缀不能超过 128：${value}`;
  }
  if (!addr) return `不是合法的 IP 或 CIDR：${value}`;
  if (isV4(addr)) return null;
  // IPv6 宽松校验：必须含冒号，且只由十六进制与冒号组成（含 ::）
  if (addr.includes(':') && /^[0-9a-fA-F:]+$/.test(addr)) return null;
  return `不是合法的 IP 或 CIDR：${value}`;
}

/** 端口数组：整数 1..65535，或 "start-end" 且 start<=end */
function validatePorts(ports: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (ports === undefined || ports === null || ports === '') return { ok: true, value: [] };
  let arr: unknown[];
  if (Array.isArray(ports)) arr = ports;
  else if (typeof ports === 'string') {
    // 允许 "22,443,8000-8100" 这种粘贴形式
    arr = ports.split(',').map((s) => s.trim()).filter(Boolean);
  } else return { ok: false, error: 'ports 必须是数组或逗号分隔字符串' };

  const out: string[] = [];
  for (const raw of arr) {
    const s = String(raw).trim();
    if (!s) continue;
    const range = s.match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b > 65535 || a > b) return { ok: false, error: `端口区间不合法：${s}（需 1-65535 且起≤止）` };
      out.push(`${a}-${b}`);
      continue;
    }
    if (!/^\d{1,5}$/.test(s)) return { ok: false, error: `端口不合法：${s}` };
    const n = Number(s);
    if (n < 1 || n > 65535) return { ok: false, error: `端口超出范围 1-65535：${s}` };
    out.push(String(n));
  }
  // 去重并保持顺序，避免同一资源生成重复 dst
  return { ok: true, value: [...new Set(out)] };
}

function parsePortsJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 行形状
interface ResourceRow {
  id: number;
  name: string;
  ip: string;
  ports: string | null;
  protocol: string;
  description: string | null;
  owner_group: string | null;
  enabled: number;
  synced_at: string | null;
  created_at: string;
  updated_at: string;
}

function shape(r: ResourceRow) {
  const ports = parsePortsJson(r.ports);
  return {
    id: r.id,
    name: r.name,
    ip: r.ip,
    ports,
    protocol: r.protocol,
    description: r.description ?? '',
    ownerGroup: r.owner_group,
    enabled: r.enabled === 1,
    syncedAt: r.synced_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    /** 生成 ACL 规则时用的 dst 片段：name 或 name:port */
    dstForms: ports.length > 0 ? ports.map((p) => `${r.name}:${p}`) : [`${r.name}:*`],
  };
}

/** 组内成员绑定的 headscale 网络身份（用于推导参考规则） */
function groupHsUsers(groupName: string): string[] {
  const rows = all<{ hs_user_name: string }>(
    `SELECT DISTINCT h.hs_user_name AS hs_user_name
       FROM panel_groups g
       JOIN panel_user_groups ug ON ug.group_id = g.id
       JOIN panel_user_hs_users h ON h.user_id = ug.user_id
      WHERE g.name = ?`,
    groupName,
  );
  return rows.map((r) => r.hs_user_name);
}

export async function registerResourceRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------- 列表
  app.get('/api/resources', { preHandler: requirePermission('resource:read') }, async (_req, reply) => {
    const rows = all<ResourceRow>('SELECT * FROM resources ORDER BY name');
    return reply.send({
      resources: rows.map(shape),
      stats: {
        total: rows.length,
        enabled: rows.filter((r) => r.enabled === 1).length,
        synced: rows.filter((r) => r.synced_at !== null).length,
        unsynced: rows.filter((r) => r.enabled === 1 && r.synced_at === null).length,
      },
    });
  });

  // ---------------------------------------------------------------- 新建
  app.post('/api/resources', { preHandler: requirePermission('resource:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z
      .object({
        name: z.string().min(1).max(63),
        ip: z.string().min(1).max(128),
        ports: z.union([z.array(z.union([z.string(), z.number()])), z.string()]).optional(),
        protocol: z.enum(['tcp', 'udp']).default('tcp'),
        description: z.string().max(500).optional(),
        ownerGroup: z.string().max(64).nullable().optional(),
        enabled: z.boolean().default(true),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    const nameErr = validateName(parsed.data.name);
    if (nameErr) return reply.code(400).send({ error: 'BAD_NAME', message: nameErr });
    const ipErr = validateIp(parsed.data.ip);
    if (ipErr) return reply.code(400).send({ error: 'BAD_IP', message: ipErr });
    const portsRes = validatePorts(parsed.data.ports);
    if (!portsRes.ok) return reply.code(400).send({ error: 'BAD_PORTS', message: portsRes.error });

    if (get<{ id: number }>('SELECT id FROM resources WHERE name = ?', parsed.data.name)) {
      return reply.code(409).send({ error: 'NAME_TAKEN', message: `资源名「${parsed.data.name}」已存在` });
    }
    if (parsed.data.ownerGroup) {
      if (!get<{ id: number }>('SELECT id FROM panel_groups WHERE name = ?', parsed.data.ownerGroup)) {
        return reply.code(400).send({ error: 'NO_SUCH_GROUP', message: `面板组「${parsed.data.ownerGroup}」不存在` });
      }
    }

    const now = nowIso();
    run(
      `INSERT INTO resources (name, ip, ports, protocol, description, owner_group, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      parsed.data.name,
      parsed.data.ip.trim(),
      JSON.stringify(portsRes.value),
      parsed.data.protocol,
      parsed.data.description ?? null,
      parsed.data.ownerGroup ?? null,
      parsed.data.enabled ? 1 : 0,
      now,
      now,
    );

    const row = get<ResourceRow>('SELECT * FROM resources WHERE name = ?', parsed.data.name);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'resource.create',
      targetType: 'resource',
      targetId: parsed.data.name,
      result: 'ok',
      detail: { ip: parsed.data.ip, ports: portsRes.value, ownerGroup: parsed.data.ownerGroup ?? null },
    });
    return reply.code(201).send({ resource: row ? shape(row) : null });
  });

  // ---------------------------------------------------------------- 更新
  app.put('/api/resources/:id', { preHandler: requirePermission('resource:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id <= 0) {
      return reply.code(400).send({ error: 'BAD_ID', message: '资源 ID 非法' });
    }
    const existing = get<ResourceRow>('SELECT * FROM resources WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });

    const parsed = z
      .object({
        name: z.string().min(1).max(63).optional(),
        ip: z.string().min(1).max(128).optional(),
        ports: z.union([z.array(z.union([z.string(), z.number()])), z.string()]).optional(),
        protocol: z.enum(['tcp', 'udp']).optional(),
        description: z.string().max(500).nullable().optional(),
        ownerGroup: z.string().max(64).nullable().optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    const d = parsed.data;
    if (d.name !== undefined) {
      const nameErr = validateName(d.name);
      if (nameErr) return reply.code(400).send({ error: 'BAD_NAME', message: nameErr });
      const dup = get<{ id: number }>('SELECT id FROM resources WHERE name = ? AND id <> ?', d.name, id);
      if (dup) return reply.code(409).send({ error: 'NAME_TAKEN', message: `资源名「${d.name}」已被占用` });
    }
    if (d.ip !== undefined) {
      const ipErr = validateIp(d.ip);
      if (ipErr) return reply.code(400).send({ error: 'BAD_IP', message: ipErr });
    }
    let portsJson: string | undefined;
    if (d.ports !== undefined) {
      const portsRes = validatePorts(d.ports);
      if (!portsRes.ok) return reply.code(400).send({ error: 'BAD_PORTS', message: portsRes.error });
      portsJson = JSON.stringify(portsRes.value);
    }
    if (d.ownerGroup) {
      if (!get<{ id: number }>('SELECT id FROM panel_groups WHERE name = ?', d.ownerGroup)) {
        return reply.code(400).send({ error: 'NO_SUCH_GROUP', message: `面板组「${d.ownerGroup}」不存在` });
      }
    }

    // 名字或 IP 变了就意味着 hosts 里的旧条目要跟着改，清掉 synced_at 提示需重新同步
    const hostChanged = (d.name !== undefined && d.name !== existing.name) || (d.ip !== undefined && d.ip !== existing.ip);

    run(
      `UPDATE resources SET
         name = COALESCE(?, name),
         ip = COALESCE(?, ip),
         ports = COALESCE(?, ports),
         protocol = COALESCE(?, protocol),
         description = COALESCE(?, description),
         owner_group = COALESCE(?, owner_group),
         enabled = COALESCE(?, enabled),
         synced_at = CASE WHEN ? = 1 THEN NULL ELSE synced_at END,
         updated_at = ?
       WHERE id = ?`,
      d.name ?? null,
      d.ip !== undefined ? d.ip.trim() : null,
      portsJson ?? null,
      d.protocol ?? null,
      d.description === undefined ? null : d.description,
      d.ownerGroup === undefined ? null : d.ownerGroup,
      d.enabled === undefined ? null : d.enabled ? 1 : 0,
      hostChanged ? 1 : 0,
      nowIso(),
      id,
    );

    const row = get<ResourceRow>('SELECT * FROM resources WHERE id = ?', id);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'resource.update',
      targetType: 'resource',
      targetId: existing.name,
      result: 'ok',
      detail: { changed: Object.keys(d), hostChanged },
    });
    return reply.send({
      resource: row ? shape(row) : null,
      /** 名字/IP 变了要重新同步，否则 hosts 里还是旧值 */
      needResync: hostChanged,
    });
  });

  // ---------------------------------------------------------------- 删除
  app.delete('/api/resources/:id', { preHandler: requirePermission('resource:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const id = Number((req.params as { id: string }).id);
    const existing = get<ResourceRow>('SELECT * FROM resources WHERE id = ?', id);
    if (!existing) return reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' });

    const q = req.query as Record<string, string | undefined>;
    const removeFromHosts = q.removeFromHosts === '1' || q.removeFromHosts === 'true';
    let hostRemoved = false;

    if (removeFromHosts) {
      // 只删 hosts 里对应这一条，**不动 acls**
      const cur = await readCurrentPolicy();
      if (cur.parsed?.hosts && existing.name in cur.parsed.hosts) {
        // 显式标注类型：`{...policy, hosts: {...}}` 会把 hosts 收窄成必填，
        // 之后再 delete 会触发 TS2790，这里保持 AclPolicy（hosts 可选）
        const next: AclPolicy = { ...cur.parsed, hosts: { ...cur.parsed.hosts } };
        if (next.hosts) delete next.hosts[existing.name];
        // hosts 被删空时移除该键，避免留下 `"hosts":{}` 这种噪音
        if (next.hosts && Object.keys(next.hosts).length === 0) delete next.hosts;
        await applyPolicy({
          content: stringifyPolicy(next),
          comment: `资源中心：删除资源 ${existing.name} 并移除 hosts 条目`,
          source: 'manual',
          authorId: ctx.user.id,
          authorName: ctx.user.username,
        });
        hostRemoved = true;
      }
    }

    run('DELETE FROM resources WHERE id = ?', id);
    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'resource.delete',
      targetType: 'resource',
      targetId: existing.name,
      result: 'ok',
      detail: { hostRemoved },
    });
    return reply.send({ ok: true, hostRemoved });
  });

  // ---------------------------------------------------------------- 同步预览（dry-run）
  /**
   * 不写任何东西，只返回「如果现在同步会发生什么」：
   *   · 会新增哪些 hosts
   *   · 会更新哪些（值与现状不同）
   *   · 哪些与手写 hosts 冲突（默认不覆盖）
   *   · 哪些是面板资源已删除但 hosts 里还留着的孤儿
   *   · 参考 ACL 规则（按 ownerGroup 推导，**仅供参考，不会自动应用**）
   */
  app.get('/api/resources/sync/preview', { preHandler: requirePermission('resource:read') }, async (_req, reply) => {
    const rows = all<ResourceRow>('SELECT * FROM resources ORDER BY name');
    const cur = await readCurrentPolicy();
    const policy = cur.parsed;
    const existingHosts = { ...(policy?.hosts ?? {}) };
    const interp = interpretPolicy(policy);

    const adds: { name: string; ip: string }[] = [];
    const updates: { name: string; from: string; to: string }[] = [];
    const conflicts: { name: string; existing: string; wanted: string; resourceId: number }[] = [];

    const wanted = new Map<string, { ip: string; id: number }>();
    for (const r of rows) {
      if (r.enabled !== 1) continue;
      wanted.set(r.name, { ip: r.ip, id: r.id });
    }

    for (const [name, w] of wanted) {
      if (!(name in existingHosts)) {
        adds.push({ name, ip: w.ip });
      } else if (existingHosts[name] !== w.ip) {
        // 已存在且值不同：区分「是我们之前同步的」与「别人手写的」
        const row = rows.find((r) => r.name === name);
        if (row?.synced_at) {
          updates.push({ name, from: existingHosts[name] ?? '', to: w.ip });
        } else {
          conflicts.push({ name, existing: existingHosts[name] ?? '', wanted: w.ip, resourceId: w.id });
        }
      }
    }

    // 孤儿：hosts 里有、但没有任何资源定义，且看起来是面板同步过的名字
    const orphans: string[] = [];
    for (const name of Object.keys(existingHosts)) {
      if (wanted.has(name)) continue;
      const row = rows.find((r) => r.name === name);
      if (row) continue; // 资源存在但被禁用：不算孤儿，属于「待移除」
      // 无法判断是否面板创建；只有当它不在策略规则里被引用时才提醒
      orphans.push(name);
    }

    // 参考规则：按 ownerGroup 推导组内成员绑定的网络身份
    const referenceRules = rows
      .filter((r) => r.enabled === 1 && r.owner_group)
      .map((r) => {
        const hsUsers = groupHsUsers(r.owner_group as string);
        const ports = parsePortsJson(r.ports);
        return {
          resource: r.name,
          ownerGroup: r.owner_group,
          src: hsUsers.map((u) => `${u}@`),
          dst: ports.length > 0 ? ports.map((p) => `${r.name}:${p}`) : [`${r.name}:*`],
          protocol: r.protocol,
          /** 组内没有成员绑定网络身份时无法生成规则 */
          executable: hsUsers.length > 0,
          note:
            hsUsers.length > 0
              ? '组内成员已绑定网络身份，可据此生成 ACL 规则'
              : '组内没有成员绑定 Headscale 网络身份，生成不了 src，需先在「面板账户」里绑定',
        };
      });

    return reply.send({
      hostDiff: { adds, updates, conflicts, orphans },
      referenceRules,
      policy: {
        mode: interp.mode,
        explanation: interp.explanation,
        /**
         * 全通/全禁时 hosts 不起作用——它们只在规则模式下被引用。
         * 这里提前告知，避免用户以为"同步了 hosts 就生效了"。
         */
        hostsEffective: interp.mode === 'rules',
        warning:
          interp.mode === 'rules'
            ? null
            : `当前策略处于${interp.mode === 'allow-all' ? '全通' : '全禁'}模式，hosts 条目不会被任何规则引用，同步后不会改变连通性。`,
      },
      stats: {
        resources: rows.length,
        enabled: rows.filter((r) => r.enabled === 1).length,
        toAdd: adds.length,
        toUpdate: updates.length,
        conflicts: conflicts.length,
        orphans: orphans.length,
      },
    });
  });

  // ---------------------------------------------------------------- 执行同步
  app.post('/api/resources/sync', { preHandler: requirePermission('resource:write') }, async (req, reply) => {
    const ctx = authOr401(req, reply);
    if (!ctx || !csrfOk(req, reply)) return;

    const parsed = z
      .object({
        /** 是否覆盖与手写 hosts 冲突的条目 */
        overwrite: z.boolean().default(false),
        /** 是否顺带清理孤儿 hosts（面板记账之外的名字，默认不动） */
        pruneOrphans: z.boolean().default(false),
        orphanNames: z.array(z.string()).max(200).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'BAD_INPUT', message: parsed.error.issues[0]?.message ?? '参数非法' });
    }

    const rows = all<ResourceRow>('SELECT * FROM resources ORDER BY name');
    const cur = await readCurrentPolicy();
    const policy = cur.parsed;
    if (!policy) {
      return reply.code(409).send({
        error: 'NO_POLICY',
        message:
          'Headscale 当前没有任何 ACL 策略。此时策略等价于「全通」，hosts 不会被引用。' +
          '请先在 ACL 管理中建立至少一条规则，再同步资源。',
      });
    }

    const existingHosts = { ...(policy.hosts ?? {}) };
    const nextHosts: Record<string, string> = { ...existingHosts };
    const applied = { added: 0, updated: 0, skippedConflicts: [] as string[], pruned: 0 };

    for (const r of rows) {
      if (r.enabled !== 1) continue;
      const curVal = nextHosts[r.name];
      if (curVal === undefined) {
        nextHosts[r.name] = r.ip;
        applied.added += 1;
        continue;
      }
      if (curVal === r.ip) continue;
      // 冲突：只有显式 overwrite 或该条目本来就是面板同步过的才改
      if (r.synced_at || parsed.data.overwrite) {
        nextHosts[r.name] = r.ip;
        applied.updated += 1;
      } else {
        applied.skippedConflicts.push(r.name);
      }
    }

    if (applied.skippedConflicts.length > 0 && !parsed.data.overwrite) {
      return reply.code(409).send({
        error: 'HOSTS_CONFLICT',
        message: `有 ${applied.skippedConflicts.length} 个主机名在策略里已存在且值与资源不一致，已中止同步`,
        conflicts: applied.skippedConflicts,
        hint: '确认可以覆盖后，带 overwrite: true 重试。手写维护的别名可能被资源定义覆盖。',
      });
    }

    if (parsed.data.pruneOrphans && parsed.data.orphanNames?.length) {
      const resourceNames = new Set(rows.map((r) => r.name));
      for (const name of parsed.data.orphanNames) {
        if (resourceNames.has(name)) continue; // 有资源定义的不当孤儿
        if (name in nextHosts) {
          delete nextHosts[name];
          applied.pruned += 1;
        }
      }
    }

    // ⚠️ 只写 hosts。绝不动 acls/grants —— 见文件头注释。
    const next: AclPolicy = { ...policy };
    if (Object.keys(nextHosts).length === 0) delete next.hosts;
    else next.hosts = nextHosts;

    const raw = stringifyPolicy(next);
    const reparse = parsePolicy(raw);
    if (!reparse.ok) {
      return reply.code(500).send({
        error: 'SERIALIZE_FAILED',
        message: `生成的策略无法被解析，已中止（未写入）：${reparse.error}`,
      });
    }

    const result = await applyPolicy({
      content: raw,
      comment: `资源中心同步：新增 ${applied.added} / 更新 ${applied.updated} / 清理 ${applied.pruned}`,
      source: 'manual',
      authorId: ctx.user.id,
      authorName: ctx.user.username,
    });

    const now = nowIso();
    for (const r of rows) {
      if (r.enabled !== 1) continue;
      if (nextHosts[r.name] === r.ip) {
        run('UPDATE resources SET synced_at = ?, updated_at = ? WHERE id = ?', now, now, r.id);
      }
    }

    audit({
      userId: ctx.user.id,
      username: ctx.user.username,
      ip: req.ip,
      action: 'resource.sync',
      targetType: 'acl_version',
      targetId: result.versionId,
      result: result.ok ? 'ok' : 'error',
      detail: { ...applied, aclsUntouched: true },
    });

    return reply.send({
      ok: true,
      applied,
      versionId: result.versionId,
      hsUpdatedAt: result.hsUpdatedAt,
      /** 同步只影响 hosts；连通性由 acls 决定，这部分没被改动 */
      aclsUntouched: true,
    });
  });
}
