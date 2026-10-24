/**
 * 引导数据初始化。
 *
 * 只在首次启动（面板用户表为空）时执行：
 *   1. 写入内置角色模板
 *   2. 创建超级管理员（口令来自 PANEL_ADMIN_SECRET，未设置则随机生成并打印）
 * 幂等：重复执行不会覆盖已有数据。
 */
import { get, run, tx, all } from './index.ts';
import { BUILTIN_ROLES } from '../auth/rbac.ts';
import { hashPassword, checkPasswordStrength, generateStrongPassword } from '../auth/secrets.ts';
import { loadConfig } from '../config.ts';
import { nowIso } from '../util/time.ts';

export async function seedBootstrap(): Promise<boolean> {
  let changed = false;

  // ---------- 1. 内置角色 ----------
  for (const role of BUILTIN_ROLES) {
    const existing = get<{ id: number }>('SELECT id FROM panel_groups WHERE name = ?', role.name);
    if (existing) continue;
    tx(() => {
      const gid = run(
        'INSERT INTO panel_groups (name, description, is_builtin, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
        role.name,
        role.description,
        nowIso(),
        nowIso(),
      );
      for (const p of role.permissions) {
        run('INSERT OR IGNORE INTO panel_group_permissions (group_id, permission) VALUES (?, ?)', gid, p);
      }
    });
    changed = true;
  }

  // ---------- 2. 首个管理员 ----------
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM panel_users')?.n ?? 0;
  if (count === 0) {
    const cfg = loadConfig();
    let secret = cfg.bootstrapAdminSecret;
    let generated = false;
    if (!secret) {
      secret = generateStrongPassword(20);
      generated = true;
    } else {
      const strength = checkPasswordStrength(secret);
      if (!strength.ok) {
        throw new Error(`PANEL_ADMIN_SECRET 强度不足：${strength.reason}`);
      }
    }

    const uid = tx(() => {
      const id = run(
        `INSERT INTO panel_users
           (username, display_name, pwd_hash, is_superuser, is_active, must_change_pwd, auth_source, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, 'local', ?, ?)`,
        cfg.bootstrapAdminUser,
        '超级管理员',
        hashPassword(secret),
        generated ? 1 : 0,
        nowIso(),
        nowIso(),
      );
      const superGroup = get<{ id: number }>('SELECT id FROM panel_groups WHERE name = ?', '超级管理员');
      if (superGroup) {
        run('INSERT OR IGNORE INTO panel_user_groups (user_id, group_id) VALUES (?, ?)', id, superGroup.id);
      }
      return id;
    });

    // 口令只在此处打印一次，之后无法找回
    if (generated) {
      console.log('');
      console.log('╔════════════════════════════════════════════════════════════╗');
      console.log('║  已创建初始管理员账号，口令仅本次显示，请立即保存并修改    ║');
      console.log('╚════════════════════════════════════════════════════════════╝');
      console.log(`  用户名：${cfg.bootstrapAdminUser}`);
      console.log(`  口  令：${secret}`);
      console.log('  （首次登录后会被要求修改口令）');
      console.log('');
    } else {
      console.log(`已创建初始管理员账号：${cfg.bootstrapAdminUser}（口令来自 PANEL_ADMIN_SECRET）`);
    }
    changed = true;
  }

  return changed;
}

/** 统计当前面板数据概览，供健康检查与首屏使用 */
export function panelStats(): {
  users: number;
  groups: number;
  resources: number;
  dnsRecords: number;
  aclVersions: number;
  oauthClients: number;
} {
  const one = (sql: string): number => get<{ n: number }>(sql)?.n ?? 0;
  return {
    users: one('SELECT COUNT(*) AS n FROM panel_users'),
    groups: one('SELECT COUNT(*) AS n FROM panel_groups'),
    resources: one('SELECT COUNT(*) AS n FROM resources'),
    dnsRecords: one('SELECT COUNT(*) AS n FROM dns_records'),
    aclVersions: one('SELECT COUNT(*) AS n FROM acl_versions'),
    oauthClients: one('SELECT COUNT(*) AS n FROM oauth_clients'),
  };
}

export { all };
