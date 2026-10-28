/**
 * 内置 OIDC Provider 核心：签名密钥管理 + ID Token 签发
 *
 * 目的：让 headscale 把本面板当作认证源（headscale `oidc.issuer` 指向面板），
 * 这样「一套账号管所有服务」——面板账户登录一次，headscale 侧网络身份也认。
 *
 * ## 设计取舍
 *
 * 1. **RS256 非对称，不用 HS256**
 *    HS256 的密钥必须给每个验签方，等于把签发权散出去。RS256 只公开公钥
 *    （JWKS），headscale 侧无需持有秘密。这也是 OIDC 事实上的默认算法。
 *
 * 2. **私钥 AES-256-GCM 加密落库**（复用 SecretBox）
 *    `oidc_keys.private_jwk` 落明文意味着拿到 sqlite 文件就能伪造任意身份。
 *    加密后即使库文件泄露，没有 master key 也签不出 token。
 *
 * 3. **支持多密钥共存 + 轮换**
 *    `active=1` 可能有多个：新 key 用于签发，旧 key 仍公开在 JWKS 里继续验签。
 *    这样轮换时已签发的 token 不会立刻失效（否则所有在线会话瞬间掉线）。
 *    `retired_at` 非空的 key 不再进 JWKS。
 *
 * 4. **首次使用时惰性生成**
 *    不在启动时强制建 key——没配 OIDC 的部署不该多出无用的密钥文件。
 *    但第一次访问 `/oidc/jwks` 或签发时必然生成，之后稳定复用。
 */

import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT } from 'jose';
import type { JWK } from 'jose';
/**
 * jose v6 不再导出 `KeyLike`；`importJWK` 的返回类型是
 * `CryptoKey | Uint8Array` 的联合。直接用它的推导类型，避免手写断言。
 */
type SigningKey = Awaited<ReturnType<typeof importJWK>>;

import { all, get, run } from '../db/index.ts';
import { secretBox } from '../crypto/box.ts';
import { nowIso } from '../util/time.ts';

const ALG = 'RS256';

interface KeyRow {
  kid: string;
  alg: string;
  public_jwk: string;
  private_jwk: string;
  active: number;
  created_at: string;
  retired_at: string | null;
}

/** 进程内缓存：解密私钥有成本，每请求解一次没必要 */
const keyCache = new Map<string, { privateKey: SigningKey; publicKey: SigningKey; jwk: JWK }>();

/** 同步取用已缓存的密钥；若尚未就绪则等待一次 */
async function keysFor(row: KeyRow): Promise<{ privateKey: SigningKey; publicKey: SigningKey; jwk: JWK } | null> {
  const hit = keyCache.get(row.kid);
  if (hit && hit.privateKey) return hit;
  const plain = secretBox().tryDecrypt(row.private_jwk);
  if (!plain) return null;
  try {
    const privateJwk = JSON.parse(plain) as JWK;
    const publicJwk = JSON.parse(row.public_jwk) as JWK;
    const privateKey = await importJWK(privateJwk, ALG);
    const publicKey = await importJWK(publicJwk, ALG);
    const value = { privateKey, publicKey, jwk: publicJwk };
    keyCache.set(row.kid, value);
    return value;
  } catch {
    return null;
  }
}

/** 生成一对新密钥并落库（加密私钥） */
async function createKey(): Promise<KeyRow> {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  // kid 用公钥指纹前 16 位，稳定且不泄露私钥信息
  const kid = `oidc-${nowIso().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  publicJwk.kid = kid;
  publicJwk.alg = ALG;
  publicJwk.use = 'sig';
  privateJwk.kid = kid;
  privateJwk.alg = ALG;

  run(
    `INSERT INTO oidc_keys (kid, alg, public_jwk, private_jwk, active, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    kid,
    ALG,
    JSON.stringify(publicJwk),
    secretBox().encrypt(JSON.stringify(privateJwk)),
    nowIso(),
  );

  const row = get<KeyRow>('SELECT * FROM oidc_keys WHERE kid = ?', kid);
  if (!row) throw new Error('密钥写入后读不回来');
  return row;
}

/** 当前用于签发的密钥（取最新 active 的；没有则惰性生成） */
export async function signingKey(): Promise<{ kid: string; key: SigningKey }> {
  const rows = all<KeyRow>(
    'SELECT * FROM oidc_keys WHERE active = 1 AND retired_at IS NULL ORDER BY created_at DESC',
  );
  for (const row of rows) {
    const k = await keysFor(row);
    if (k) return { kid: row.kid, key: k.privateKey };
  }
  // 没有任何可用密钥 → 生成第一把
  const fresh = await createKey();
  const k = await keysFor(fresh);
  if (!k) throw new Error('新生成的密钥无法导入');
  return { kid: fresh.kid, key: k.privateKey };
}

/**
 * JWKS：所有未退役的公钥。
 * 必须包含历史密钥——否则轮换后已签发的 token 全部验签失败。
 */
export async function jwks(): Promise<{ keys: JWK[] }> {
  let rows = all<KeyRow>('SELECT * FROM oidc_keys WHERE retired_at IS NULL ORDER BY created_at DESC');
  if (rows.length === 0) {
    await createKey();
    rows = all<KeyRow>('SELECT * FROM oidc_keys WHERE retired_at IS NULL ORDER BY created_at DESC');
  }
  const keys: JWK[] = [];
  for (const row of rows) {
    try {
      const jwk = JSON.parse(row.public_jwk) as JWK;
      keys.push(jwk);
    } catch {
      /* 单条坏数据不影响整体 */
    }
  }
  return { keys };
}

/**
 * 轮换：生成新密钥用于签发，旧密钥保留在 JWKS 继续验签。
 *
 * @param retireOld true 时把旧密钥标记退役（立即从 JWKS 移除）——
 *   仅在确认没有未过期 token 时才该用，否则在线会话会集体失效。
 */
export async function rotateKey(retireOld = false): Promise<{ kid: string; retired: string[] }> {
  const oldRows = all<KeyRow>('SELECT * FROM oidc_keys WHERE active = 1 AND retired_at IS NULL');
  const fresh = await createKey();

  if (retireOld) {
    const ts = nowIso();
    for (const r of oldRows) {
      run('UPDATE oidc_keys SET retired_at = ? WHERE kid = ?', ts, r.kid);
      keyCache.delete(r.kid);
    }
  }
  return { kid: fresh.kid, retired: retireOld ? oldRows.map((r) => r.kid) : [] };
}

export interface KeyInfo {
  kid: string;
  alg: string;
  active: boolean;
  createdAt: string;
  retiredAt: string | null;
}

export function listKeys(): KeyInfo[] {
  const rows = all<KeyRow>('SELECT * FROM oidc_keys ORDER BY created_at DESC');
  return rows.map((r) => ({
    kid: r.kid,
    alg: r.alg,
    active: r.active === 1 && r.retired_at === null,
    createdAt: r.created_at,
    retiredAt: r.retired_at,
  }));
}

/** 清理：删除全部密钥（仅测试用；会让已签发 token 全部失效） */
export function purgeKeys(): void {
  run('DELETE FROM oidc_keys');
  keyCache.clear();
}

// ============================================================
// ID Token
// ============================================================

export interface IdTokenClaims {
  /** 主体：面板用户 ID 的字符串形式 */
  sub: string;
  /** 受众：OIDC client_id */
  aud: string;
  /** 签发方（面板对外地址） */
  iss: string;
  /** 用户名，headscale 用它建网络用户 */
  preferred_username: string;
  name?: string;
  email?: string | null;
  /** 面板组名，供下游做授权映射 */
  groups?: string[];
  /** 认证时刻（OIDC 要求，供下游判断是否需要重新认证） */
  auth_time: number;
  nonce?: string | null;
}

export async function signIdToken(claims: IdTokenClaims, ttlSec = 600): Promise<string> {
  const { kid, key } = await signingKey();
  const now = Math.floor(Date.now() / 1000);

  const payload: Record<string, unknown> = {
    iss: claims.iss,
    sub: claims.sub,
    aud: claims.aud,
    iat: now,
    auth_time: claims.auth_time,
    preferred_username: claims.preferred_username,
  };
  if (claims.name) payload.name = claims.name;
  if (claims.email) payload.email = claims.email;
  if (claims.groups && claims.groups.length > 0) payload.groups = claims.groups;
  if (claims.nonce) payload.nonce = claims.nonce;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALG, kid, typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(key);
}

/**
 * 自校验：签完立刻验一遍。
 *
 * 为什么值得多花一次验签：这套 token 的消费方是 headscale，
 * 一旦格式/claims 有问题，排查要跨两个系统。签发即自验能把问题
 * 挡在面板侧，错误信息也更直接（"我们签的 token 自己都验不过"）。
 */
export async function selfVerify(token: string, issuer: string, audience: string): Promise<boolean> {
  try {
    const { keys } = await jwks();
    if (keys.length === 0) return false;

    // ⚠️ 必须按 token 头里的 kid 选对应公钥，不能盲取第一把。
    //    轮换后 JWKS 里有多把 key，旧 token 的 kid 指向旧 key——
    //    盲取第一把（最新那把）会导致「刚轮换完，所有旧 token 验签失败」。
    //    实测踩到过：这条让「轮换前签发的 token 仍可验签」的断言失败。
    const header = JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8')) as {
      kid?: string;
      alg?: string;
    };
    if (header.alg !== ALG) return false;

    const candidates = header.kid ? keys.filter((k) => k.kid === header.kid) : keys;
    if (candidates.length === 0) return false;

    for (const k of candidates) {
      try {
        const publicKey = await importJWK(k, ALG);
        await jwtVerify(token, publicKey, { issuer, audience, algorithms: [ALG] });
        return true;
      } catch {
        /* 换下一把（kid 相同时理论上只有一把，这里容错） */
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** 测试用：清空密钥缓存 */
export function __resetKeyCache(): void {
  keyCache.clear();
}
