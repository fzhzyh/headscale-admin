/**
 * OIDC 密钥与 ID Token 单元测试
 *
 * 覆盖的都是「签错了下游就认不出」的地方：
 *  1. 私钥必须**加密落库**（库文件泄露不能直接伪造身份）
 *  2. JWKS 里**不能出现私钥字段**（d/p/q/qi 泄露等于签发权泄露）
 *  3. 轮换后旧 key 仍在 JWKS（否则已签发 token 全失效）
 *  4. 签发即自验（消费方是 headscale，跨系统排查成本高）
 *  5. claims 齐全：iss/aud/sub/preferred_username/auth_time/exp
 *
 * 运行：cd server && npx tsx src/oidc/keys.test.ts
 * 注意：需要已初始化的面板数据库（用 PANEL_DATA_DIR 指向临时目录）。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, closeDb, run, all } from '../db/index.ts';
import { migrate } from '../db/migrate.ts';

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? `  → ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, a === e ? '' : `实际 ${a} / 期望 ${e}`);
}

// 独立临时库，不污染真实数据
const dir = mkdtempSync(join(tmpdir(), 'oidc-test-'));
process.env.PANEL_DATA_DIR = dir;
process.env.PANEL_MASTER_KEY = 'test-master-key-for-oidc-unit-tests';

openDb(join(dir, 'panel.sqlite'));
migrate();

const { signingKey, jwks, signIdToken, selfVerify, rotateKey, listKeys, purgeKeys, __resetKeyCache } = await import('./keys.ts');

const ISS = 'http://100.64.0.3:8080';
const AUD = 'headscale';

// ============================================================
console.log('\n=== 1. 首次使用惰性生成密钥 ===');
purgeKeys();
__resetKeyCache();
eq('清空后无密钥', listKeys().length, 0);

const first = await signingKey();
ok('惰性生成了一把签名密钥', Boolean(first.kid), first.kid);
eq('库里有 1 条密钥记录', listKeys().length, 1);
ok('密钥标记为 active', listKeys()[0]?.active === true);
eq('算法为 RS256', listKeys()[0]?.alg, 'RS256');

// ============================================================
console.log('\n=== 2. 私钥必须加密落库 ===');
{
  const rows = all<{ private_jwk: string; public_jwk: string }>('SELECT * FROM oidc_keys');
  const row = rows[0];
  ok('私钥以 v1: 前缀的密文存储', row?.private_jwk.startsWith('v1:') === true, row?.private_jwk.slice(0, 12));
  ok('私钥明文不可见（不含 PEM/JWK 片段）',
    !String(row?.private_jwk).includes('PRIVATE') && !String(row?.private_jwk).includes('"d"'),
    '密文中无明文特征');
  ok('公钥是明文 JWK（本来就要公开）', String(row?.public_jwk).includes('"n"'));
}

// ============================================================
console.log('\n=== 3. JWKS 不能泄露私钥字段 ===');
{
  const set = await jwks();
  ok('JWKS 有密钥', set.keys.length >= 1, `${set.keys.length} 把`);
  const k = set.keys[0];
  ok('含 kid', Boolean(k?.kid), String(k?.kid));
  ok('含 alg=RS256', k?.alg === 'RS256', String(k?.alg));
  ok('含 use=sig', k?.use === 'sig', String(k?.use));
  ok('含 kty=RSA', k?.kty === 'RSA', String(k?.kty));
  // RSA 私钥的 CRT 参数绝不能出现
  for (const secretField of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
    ok(`不含私钥字段 ${secretField}`, (k as Record<string, unknown>)?.[secretField] === undefined);
  }
}

// ============================================================
console.log('\n=== 4. 签发 ID Token 并自验 ===');
let token = '';
{
  const authTime = Math.floor(Date.now() / 1000);
  token = await signIdToken({
    sub: '1',
    aud: AUD,
    iss: ISS,
    preferred_username: 'admin',
    name: '超级管理员',
    email: 'admin@lab.internal',
    groups: ['超级管理员'],
    auth_time: authTime,
    nonce: 'n-abc123',
  });
  ok('签出非空 token', token.length > 100, `${token.split('.').length} 段`);
  eq('JWT 是三段式', token.split('.').length, 3);

  const okVerify = await selfVerify(token, ISS, AUD);
  ok('★ 自验通过（iss/aud/签名都对）', okVerify);

  // 反向验证：换个 audience 必须验不过
  const wrongAud = await selfVerify(token, ISS, 'some-other-client');
  ok('★ 换 audience 验签失败（aud 生效）', wrongAud === false);

  const wrongIss = await selfVerify(token, 'http://evil.example', AUD);
  ok('★ 换 issuer 验签失败（iss 生效）', wrongIss === false);
}

// ============================================================
console.log('\n=== 5. claims 齐全（headscale 会用到的字段）===');
{
  const { jwtVerify, importJWK } = await import('jose');
  const set = await jwks();
  const firstKey = set.keys[0];
  if (!firstKey) throw new Error('JWKS 为空');
  const pub = await importJWK(firstKey, 'RS256');
  const { payload, protectedHeader } = await jwtVerify(token, pub, { issuer: ISS, audience: AUD });

  eq('sub 为面板用户 ID', payload.sub, '1');
  eq('aud 为 client_id', payload.aud, AUD);
  eq('iss 为面板地址', payload.iss, ISS);
  eq('preferred_username 存在（headscale 用它建网络用户）', payload.preferred_username, 'admin');
  eq('name 透传', payload.name, '超级管理员');
  eq('email 透传', payload.email, 'admin@lab.internal');
  eq('groups 透传', payload.groups, ['超级管理员']);
  eq('nonce 原样回传（防重放）', payload.nonce, 'n-abc123');
  ok('auth_time 存在', typeof payload.auth_time === 'number', String(payload.auth_time));
  ok('exp 存在且在将来', typeof payload.exp === 'number' && payload.exp > Math.floor(Date.now() / 1000));
  eq('JWT header 算法', protectedHeader.alg, 'RS256');
  ok('JWT header 带 kid（验签方据此选 key）', Boolean(protectedHeader.kid), String(protectedHeader.kid));
}

// ============================================================
console.log('\n=== 6. 密钥轮换：旧 key 保留在 JWKS ===');
{
  const before = await jwks();
  const beforeKids = before.keys.map((k) => k.kid);
  const oldToken = token;

  const r = await rotateKey(false);
  ok('新 key 已生成', Boolean(r.kid) && !beforeKids.includes(r.kid), r.kid);
  eq('未要求退役时不返回退役列表', r.retired.length, 0);

  const after = await jwks();
  ok('JWKS 现在有多把 key', after.keys.length > before.keys.length, `${before.keys.length} → ${after.keys.length}`);
  for (const kid of beforeKids) {
    ok(`旧 key ${String(kid).slice(-8)} 仍在 JWKS（否则旧 token 全失效）`,
      after.keys.some((k) => k.kid === kid));
  }
  ok('★ 轮换前签发的 token 仍可验签', await selfVerify(oldToken, ISS, AUD));
}

// ============================================================
console.log('\n=== 7. 强制退役：旧 key 从 JWKS 消失 ===');
{
  const before = await jwks();
  const beforeKids = before.keys.map((k) => k.kid);
  const oldToken = token;

  const r = await rotateKey(true);
  ok('返回了退役列表', r.retired.length > 0, `${r.retired.length} 把`);

  const after = await jwks();
  ok('JWKS 只剩新 key', after.keys.length === 1, `${after.keys.length} 把`);
  ok('新 key 在 JWKS 里', after.keys.some((k) => k.kid === r.kid));
  for (const kid of beforeKids) {
    if (kid && r.retired.includes(kid)) {
      ok(`已退役 key ${String(kid).slice(-8)} 不在 JWKS`, !after.keys.some((k) => k.kid === kid));
    }
  }
  // 这是「强制退役」的预期代价，不是 bug
  ok('★ 强制退役后旧 token 验签失败（预期代价，需权衡）',
    (await selfVerify(oldToken, ISS, AUD)) === false);
}

// ============================================================
console.log('\n=== 8. 新 token 用新 key 签发 ===');
{
  const fresh = await signIdToken({
    sub: '2', aud: AUD, iss: ISS, preferred_username: 'viewer', auth_time: Math.floor(Date.now() / 1000),
  });
  ok('新 token 可自验', await selfVerify(fresh, ISS, AUD));
  const { jwtVerify, importJWK } = await import('jose');
  const set = await jwks();
  const fk = set.keys[0];
  if (!fk) throw new Error('JWKS 为空');
  const pub = await importJWK(fk, 'RS256');
  const { protectedHeader } = await jwtVerify(fresh, pub, { issuer: ISS, audience: AUD });
  const keys = listKeys();
  ok('kid 指向当前 active 的 key', keys.some((k) => k.kid === protectedHeader.kid && k.active));
}

// ============================================================
console.log('\n=== 9. 不同用户的 sub 不冲突 ===');
{
  const t1 = await signIdToken({ sub: '10', aud: AUD, iss: ISS, preferred_username: 'u10', auth_time: 1 });
  const t2 = await signIdToken({ sub: '11', aud: AUD, iss: ISS, preferred_username: 'u11', auth_time: 1 });
  ok('两个 token 不同', t1 !== t2);
  const { jwtVerify, importJWK } = await import('jose');
  const set = await jwks();
  const k0 = set.keys[0];
  if (!k0) throw new Error('JWKS 为空');
  const pub = await importJWK(k0, 'RS256');
  const p1 = (await jwtVerify(t1, pub)).payload;
  const p2 = (await jwtVerify(t2, pub)).payload;
  eq('sub 分别为 10/11', [p1.sub, p2.sub], ['10', '11']);
}

closeDb();

console.log(`\n${'='.repeat(60)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
