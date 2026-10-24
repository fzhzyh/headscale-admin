/**
 * 敏感字段对称加密（AES-256-GCM）。
 *
 * 用途：落库的 Headscale API Key、TOTP 密钥、OIDC 私钥、OAuth2 client secret。
 * 原则：密文带 key 版本号，便于将来轮换主密钥。
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  timingSafeEqual,
} from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
/** 密文前缀，标识密钥版本，便于将来迁移 */
const PREFIX = 'v1';

export class SecretBox {
  private readonly key: Buffer;

  /** @param masterKey 任意长度字符串，内部做 SHA-256 派生出 32 字节密钥 */
  constructor(masterKey: string) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error('主密钥长度不足（至少 16 字符）');
    }
    this.key = createHash('sha256').update(masterKey, 'utf8').digest();
  }

  /** 加密为 `v1:base64(iv|tag|ciphertext)` */
  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
  }

  /** 解密；密文格式非法或校验失败抛错 */
  decrypt(sealed: string): string {
    const [version, payload] = splitOnce(sealed, ':');
    if (version !== PREFIX || !payload) {
      throw new Error('密文格式不可识别');
    }
    const raw = Buffer.from(payload, 'base64');
    if (raw.length < IV_LEN + TAG_LEN) throw new Error('密文长度非法');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }

  /** 容错解密：密文损坏时返回 null 而不是让整个请求 500 */
  tryDecrypt(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    try {
      return this.decrypt(sealed);
    } catch {
      return null;
    }
  }
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, undefined];
  return [s.slice(0, i), s.slice(i + sep.length)];
}

/** 恒定时比较，避免时序侧信道 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 生成 url-safe 随机串 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 只显示前若干位 + 掩码，用于密钥类字段回显 */
export function maskSecret(plain: string, keep = 6): string {
  if (plain.length <= keep) return '•'.repeat(8);
  return `${plain.slice(0, keep)}${'•'.repeat(8)}`;
}
