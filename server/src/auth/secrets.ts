/**
 * 口令哈希与 TOTP。
 *
 * 选型说明：
 *   - bcryptjs（纯 JS，无原生编译）：Node 内置 crypto.scrypt 也是好选择，
 *     但 bcrypt 在运维圈更通用，且 bcryptjs 无 node-gyp 依赖，部署最省事。
 *   - TOTP 用 otplib，标准 RFC 6238，兼容 Google Authenticator / 1Password。
 */
import * as bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import { randomBytes, createHash } from 'node:crypto';

const BCRYPT_ROUNDS = 10;

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, bcrypt.genSaltSync(BCRYPT_ROUNDS));
}

export function verifyPassword(plain: string, hash: string): boolean {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

/** 校验口令强度：至少 10 位，含字母与数字 */
export function checkPasswordStrength(plain: string): { ok: boolean; reason?: string } {
  if (plain.length < 10) return { ok: false, reason: '口令至少 10 位' };
  if (!/[A-Za-z]/.test(plain)) return { ok: false, reason: '口令需包含字母' };
  if (!/\d/.test(plain)) return { ok: false, reason: '口令需包含数字' };
  return { ok: true };
}

// ---------------- TOTP ----------------

/** 生成 TOTP 密钥（base32，兼容各认证器） */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/** 生成 otpauth:// 协议串，前端据此渲染二维码 */
export function totpKeyUri(issuer: string, account: string, secret: string): string {
  return authenticator.keyuri(account, issuer, secret);
}

/**
 * 校验 6 位动态码；窗口放宽 1 个步长以容忍时钟漂移。
 *
 * ⚠️ 踩过的坑：`authenticator` 是**共享单例**，早期写法只恢复 `window` 一个字段：
 *     const prev = authenticator.options.window;   // 首次调用是 undefined
 *     finally { authenticator.options = { ...authenticator.options, window: prev } }
 * 结果把 `window` 永久写成 `undefined`，而 otplib 的校验器要求它是 number，
 * 于是**此后所有 `generateSecret()` 都抛异常**（表现为 2FA setup 永久 500，
 * 且只有「先校验过一次动态码」的进程才会复现，极难定位）。
 * 正确做法：整份快照存取，不做字段级恢复。
 */
export function verifyTotp(secret: string, token: string): boolean {
  if (!secret || !token) return false;
  const clean = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const snapshot = { ...authenticator.options };
  try {
    authenticator.options = { ...snapshot, window: 1 };
    return authenticator.verify({ token: clean, secret });
  } catch {
    return false;
  } finally {
    authenticator.options = snapshot;
  }
}

// ---------------- 恢复码 ----------------

/** 生成 N 个一次性恢复码（明文返回给用户，库中只存哈希） */
export function generateRecoveryCodes(count = 8): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    // 形如 4F2A-9C1B，便于手抄
    const raw = randomBytes(4).toString('hex').toUpperCase();
    const code = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plain.push(code);
    hashed.push(createHash('sha256').update(code).digest('hex'));
  }
  return { plain, hashed };
}

/** 用恢复码换一次登录机会；命中则从列表里移除该码 */
export function consumeRecoveryCode(hashedList: string[], input: string): { ok: boolean; remaining: string[] } {
  const h = createHash('sha256').update(input.trim().toUpperCase()).digest('hex');
  const idx = hashedList.indexOf(h);
  if (idx < 0) return { ok: false, remaining: hashedList };
  const remaining = [...hashedList];
  remaining.splice(idx, 1);
  return { ok: true, remaining };
}

/** 生成人类可读的强随机口令（引导管理员用） */
export function generateStrongPassword(len = 20): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const digits = '23456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  // 强制含数字，满足强度校验
  return out.slice(0, len - 1) + digits[bytes[0]! % digits.length];
}
