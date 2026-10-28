/**
 * 时序层单元测试（纯函数，不依赖 InfluxDB 实例）
 *
 * 覆盖的都是**实际踩过坑**的地方：
 *  1. 3.x 的 time **不带 Z** → new Date() 按本地时区解析，整体偏 8 小时
 *  2. 3.x 的 json 响应是纯对象数组（不是 2.x 的 results/series 结构）
 *  3. 查询失败返回纯文本，不能被当成数据
 *  4. line protocol 转义：设备名带空格/逗号/等号会让整批写失败
 *  5. NaN/Infinity 写进 InfluxDB 会 400，必须替换
 *  6. 空 field 的行必须丢弃（InfluxDB 会拒整批）
 *
 * 运行：cd server && npx tsx src/timeseries/influx.test.ts
 */

import { toLine, parseSqlJson, normalizeTime } from './influx.ts';
import type { Point } from './influx.ts';

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

// ============================================================
console.log('\n=== 1. SQL JSON 解析：3.x 返回的是纯对象数组 ===');
{
  // 实测响应（InfluxDB 3.12.1）：
  //   [{"nodes_offline":2.0,"nodes_online":3.0,"time":"2026-10-28T18:00:53"}]
  // 注意整数 field 也返回 float（5 → 5.0），JSON 解析后是 number 5
  const body = '[{"nodes_offline":2.0,"nodes_online":3.0,"nodes_total":5.0,"online_ratio":0.6,"time":"2026-10-28T18:00:53"}]';
  const { rows, error } = parseSqlJson(body);
  eq('无错误', error, undefined);
  eq('解析出 1 行', rows.length, 1);
  eq('数值是 number 而非字符串', typeof rows[0]?.nodes_total, 'number');
  eq('online_ratio 保留小数', rows[0]?.online_ratio, 0.6);
}

console.log('\n=== 2. ⚠️ time 缺时区必须补 Z（3.x 最易踩的坑）===');
{
  // 3.x 返回 "2026-10-28T18:00:53" —— 是 UTC 但没有 Z。
  // new Date() 对无时区标识的 ISO 串按**本地时区**解析，
  // 在 UTC+8 机器上会整体偏 8 小时，且不报任何错。
  const naive = new Date('2026-10-28T18:00:53Z').getTime();
  const { rows } = parseSqlJson('[{"time":"2026-10-28T18:00:53","v":1}]');
  const got = new Date(String(rows[0]?.time)).getTime();
  eq('补 Z 后时刻正确', got, naive);
  eq('补出来的串带 Z', rows[0]?.time, '2026-10-28T18:00:53Z');

  // 幂等：已带 Z / 带偏移的不应被二次修改
  eq('已带 Z 不变', normalizeTime('2026-10-28T18:00:53Z'), '2026-10-28T18:00:53Z');
  eq('带偏移不变', normalizeTime('2026-10-28T18:00:53+08:00'), '2026-10-28T18:00:53+08:00');
  eq('带毫秒也能补', normalizeTime('2026-10-28T18:00:53.123'), '2026-10-28T18:00:53.123Z');
}

console.log('\n=== 3. SQL JSON 解析：空与异常输入 ===');
{
  eq('空字符串 → 0 行', parseSqlJson('').rows.length, 0);
  eq('纯空白 → 0 行', parseSqlJson('   ').rows.length, 0);
  eq('空数组 → 0 行', parseSqlJson('[]').rows.length, 0);

  // 3.x 查询失败时返回纯文本，不该被当成数据
  const bad = parseSqlJson('Error during planning: table \'public.iox.x\' not found');
  eq('纯文本不当成数据', bad.rows.length, 0);
  eq('纯文本给出 error', typeof bad.error, 'string');

  const notArr = parseSqlJson('{"results":[]}');
  eq('对象不是数组 → error', typeof notArr.error, 'string');
}

console.log('\n=== 4. line protocol：基本格式 ===');
{
  const p: Point = {
    measurement: 'node_status',
    tags: { node_id: '1', name: 'lab-alpha' },
    fields: { online: 1, streak: 30 },
    ts: 1700000000,
  };
  eq('基本输出', toLine(p), 'node_status,node_id=1,name=lab-alpha online=1,streak=30 1700000000');
}

console.log('\n=== 5. line protocol：转义（设备名带空格/逗号/等号）===');
{
  const p: Point = {
    measurement: 'node_status',
    tags: { name: 'lab alpha,beta=gamma' },
    fields: { online: 1 },
    ts: 1,
  };
  const line = toLine(p);
  ok('空格被转义', line.includes('\\ '), line);
  ok('逗号被转义', line.includes('\\,'), line);
  ok('等号被转义', line.includes('\\='), line);
  // tag 值不应被引号包裹（引号只用于 field 的 string 值）
  ok('tag 值未被引号包裹', !line.includes('"'), line);
}

console.log('\n=== 6. line protocol：field 值类型 ===');
{
  eq(
    'boolean true',
    toLine({ measurement: 'm', fields: { b: true }, ts: 1 }),
    'm b=true 1',
  );
  eq(
    'boolean false',
    toLine({ measurement: 'm', fields: { b: false }, ts: 1 }),
    'm b=false 1',
  );
  eq(
    'NaN 被替换为 0（InfluxDB 会 400）',
    toLine({ measurement: 'm', fields: { v: Number.NaN }, ts: 1 }),
    'm v=0 1',
  );
  eq(
    'Infinity 被替换为 0',
    toLine({ measurement: 'm', fields: { v: Number.POSITIVE_INFINITY }, ts: 1 }),
    'm v=0 1',
  );
  eq(
    '字符串加引号并转义内部引号',
    toLine({ measurement: 'm', fields: { s: 'a"b' }, ts: 1 }),
    'm s="a\\"b" 1',
  );
}

console.log('\n=== 7. line protocol：空 field 必须丢弃整行 ===');
{
  // InfluxDB 遇到 "measurement 1"（无 field）会整批 400，必须提前返回空串
  eq('空 fields 返回空串', toLine({ measurement: 'm', fields: {}, ts: 1 }), '');
  eq(
    '全 null fields 返回空串',
    toLine({ measurement: 'm', fields: { a: null as unknown as number }, ts: 1 }),
    '',
  );
  eq(
    '部分 null 只保留有值的',
    toLine({ measurement: 'm', fields: { a: null as unknown as number, b: 2 }, ts: 1 }),
    'm b=2 1',
  );
}

console.log('\n=== 8. line protocol：tag 值为空时跳过 ===');
{
  eq(
    '空字符串 tag 被跳过',
    toLine({ measurement: 'm', tags: { a: '', b: 'x' }, fields: { v: 1 }, ts: 1 }),
    'm,b=x v=1 1',
  );
}

console.log('\n=== 9. line protocol：时间戳缺省 ===');
{
  const before = Math.floor(Date.now() / 1000);
  const line = toLine({ measurement: 'm', fields: { v: 1 } });
  const ts = Number(line.split(' ').pop());
  const after = Math.floor(Date.now() / 1000);
  ok('缺省时间戳接近当前时刻', ts >= before && ts <= after + 1, String(ts));
}

console.log(`\n${'='.repeat(60)}`);
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
