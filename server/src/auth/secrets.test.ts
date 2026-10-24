/**
 * 认证原语单元测试。
 *
 * 重点防守一个**极难复现的真实缺陷**：otplib 的 `authenticator` 是共享单例，
 * `verifyTotp` 若做「字段级恢复」会给 `options.window` 写入 undefined，
 * 导致此后所有 `generateSecret()` 抛异常（2FA setup 永久 500）。
 * 该缺陷只在「同一进程内先校验过一次动态码」后才会出现，靠黑盒 e2e 很难稳定命中。
 *
 * 运行：cd server && npx tsx src/auth/secrets.test.ts
 */
import { authenticator } from 'otplib';

import {
  generateTotpSecret,
  totpKeyUri,
  verifyTotp,
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  generateRecoveryCodes,
  consumeRecoveryCode,
  generateStrongPassword,
} from './secrets.ts';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}${detail ? `   → ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? `   → ${detail}` : ''}`);
  }
}

/** 生成一个当前有效的 6 位动态码（独立实现，用于交叉验证） */
function currentCode(secret: string): string {
  return authenticator.generate(secret);
}

// ============================================================
// 1. 口令
// ============================================================
console.log('1. 口令哈希与强度');

const h = hashPassword('Str0ngPassw0rd');
check('哈希后不含明文', !h.includes('Str0ngPassw0rd'));
check('bcrypt 前缀正确', h.startsWith('$2'), h.slice(0, 7));
check('正确口令校验通过', verifyPassword('Str0ngPassw0rd', h));
check('错误口令校验失败', !verifyPassword('Str0ngPassw0rdX', h));
check('空哈希不抛异常且返回 false', verifyPassword('x', '') === false);

check('口令过短被拒', !checkPasswordStrength('Ab1').ok);
check('纯字母被拒', !checkPasswordStrength('abcdefghijk').ok);
check('纯数字被拒', !checkPasswordStrength('12345678901').ok);
check('字母+数字且≥10位通过', checkPasswordStrength('Abcdef1234').ok);

// ============================================================
// 2. TOTP 基础
// ============================================================
console.log('\n2. TOTP 基础');

const secret = generateTotpSecret();
check('生成的密钥非空', secret.length > 0, `${secret.length} 位`);
check('密钥为 base32 字符集', /^[A-Z2-7]+$/.test(secret), secret);
check('两次生成不重复', generateTotpSecret() !== secret);

const uri = totpKeyUri('headscale-admin', 'admin', secret);
check('otpauth URI 前缀正确', uri.startsWith('otpauth://totp/'), uri.slice(0, 40));
check('URI 含 issuer', uri.includes('issuer=headscale-admin'));
check('URI 含账号', uri.includes('admin'));
check('URI 含密钥', uri.includes(secret));

check('当前动态码校验通过', verifyTotp(secret, currentCode(secret)));
check('错误动态码被拒', !verifyTotp(secret, '000000') || currentCode(secret) === '000000');
check('非数字动态码被拒', !verifyTotp(secret, 'abcdef'));
check('位数不足被拒', !verifyTotp(secret, '123'));
check('空密钥被拒', !verifyTotp('', currentCode(secret)));
check('空动态码被拒', !verifyTotp(secret, ''));

// ============================================================
// 3. 关键回归：verifyTotp 不得污染共享单例
// ============================================================
console.log('\n3. 共享单例污染回归（历史缺陷）');

// 先制造一次校验（含失败路径，exit 会走 finally）
verifyTotp(secret, '000000');
verifyTotp(secret, currentCode(secret));

const afterWindow = authenticator.options.window;
check(
  'verifyTotp 后 options.window 未被写成 undefined',
  afterWindow !== undefined,
  `window=${JSON.stringify(afterWindow)}`,
);

let secretAfter: string | null = null;
let genErr = '';
try {
  secretAfter = generateTotpSecret();
} catch (e) {
  genErr = e instanceof Error ? e.message : String(e);
}
check(
  '校验过动态码之后仍能生成新密钥（2FA setup 不再 500）',
  secretAfter !== null && secretAfter.length > 0,
  genErr || secretAfter?.slice(0, 8),
);

let uriAfter = '';
let uriErr = '';
try {
  uriAfter = totpKeyUri('headscale-admin', 'admin', secretAfter ?? secret);
} catch (e) {
  uriErr = e instanceof Error ? e.message : String(e);
}
check('校验过动态码之后仍能生成 otpauth URI', uriAfter.startsWith('otpauth://'), uriErr || '');

// 反复交替调用，确认不会累积污染
let alternationOk = true;
for (let i = 0; i < 5; i++) {
  verifyTotp(secret, '000000');
  try {
    generateTotpSecret();
  } catch {
    alternationOk = false;
    break;
  }
}
check('交替调用 5 轮无异常', alternationOk);

// ============================================================
// 4. 恢复码
// ============================================================
console.log('\n4. 恢复码');

const rc = generateRecoveryCodes(8);
check('生成 8 个恢复码', rc.plain.length === 8, `${rc.plain.length} 个`);
check('哈希数量与明文一致', rc.hashed.length === 8);
check('恢复码互不重复', new Set(rc.plain).size === 8);
check('恢复码长度足够', rc.plain.every((c) => c.length >= 8), `样例 ${rc.plain[0]}`);
check('库中存的是哈希而非明文', rc.hashed.every((x) => !rc.plain.includes(x)));
// 一次性消费语义：命中即从列表移除，不可重放
const first = rc.plain[0]!;
const consumed = consumeRecoveryCode(rc.hashed, first);
check('有效恢复码可消费', consumed.ok);
check('消费后从列表移除（一次性）', consumed.remaining.length === 7, `${consumed.remaining.length} 个`);
check('同一码不可重复使用', !consumeRecoveryCode(consumed.remaining, first).ok);
check('大小写不敏感', consumeRecoveryCode(rc.hashed, first.toLowerCase()).ok);
check('无效恢复码被拒', !consumeRecoveryCode(rc.hashed, 'DEAD-BEEF').ok);

// ============================================================
// 5. 引导口令生成
// ============================================================
console.log('\n5. 引导口令生成');

const p1 = generateStrongPassword(20);
const p2 = generateStrongPassword(20);
check('长度符合要求', p1.length === 20, `${p1.length} 位`);
check('两次生成不重复', p1 !== p2);
check('满足强度校验（含字母与数字）', checkPasswordStrength(p1).ok, p1.slice(0, 4) + '…');

console.log('\n' + '='.repeat(88));
console.log(`结果：${passed} 通过 / ${failed} 失败`);
console.log('='.repeat(88));
process.exit(failed > 0 ? 1 : 0);
