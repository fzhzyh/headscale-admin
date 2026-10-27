/**
 * 时序层单元测试（纯函数，不依赖 InfluxDB 实例）
 *
 * 覆盖的都是**实际踩过坑**的地方：
 *  1. pivot 后没有 _value 列 → 旧的过滤条件会把整张表滤空
 *  2. line protocol 转义：设备名带空格/逗号/等号会让整批写失败
 *  3. NaN/Infinity 写进 InfluxDB 会 400，必须替换
 *  4. 空 field 的行必须丢弃（InfluxDB 会拒整批）
 *
 * 运行：cd server && npx tsx src/timeseries/influx.test.ts
 */

import { toLine, parseAnnotatedCsv } from './influx.ts';
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
console.log('\n=== 1. annotated CSV 解析：普通查询（有 _value）===');
{
  const csv = [
    '#datatype,string,long,dateTime:RFC3339,double,string',
    '#group,false,false,false,false,true',
    '#default,_result,,,,',
    ',result,table,_time,_value,_field',
    ',_result,0,2026-10-27T18:40:00Z,1,online',
    ',_result,0,2026-10-27T18:40:15Z,0,online',
    '',
  ].join('\n');
  const rows = parseAnnotatedCsv(csv);
  eq('解析出 2 行', rows.length, 2);
  eq('第一行 _value', rows[0]?._value, '1');
  eq('第二行 _time', rows[1]?._time, '2026-10-27T18:40:15Z');
}

console.log('\n=== 2. annotated CSV 解析：pivot 后无 _value 列（回归用例）===');
{
  // pivot 会把每个 field 拆成独立列，此时不存在 _value。
  // 旧实现「只保留有 _value 的行」会把整张表滤空 → 接口 0 点，
  // 而 InfluxDB 里实际有数据（实测 count()=9，API 返回 0 点）。
  const csv = [
    '#datatype,string,long,dateTime:RFC3339,long,long,double,string,string',
    '#group,false,false,false,false,false,false,true,true',
    '#default,_result,,,,,,,',
    ',result,table,_time,nodes_online,nodes_total,online_ratio,_measurement,scope',
    ',_result,0,2026-10-27T18:40:00Z,0,4,0,cluster,global',
    ',_result,0,2026-10-27T18:40:15Z,1,4,0.25,cluster,global',
    '',
  ].join('\n');
  const rows = parseAnnotatedCsv(csv);
  eq('pivot 行不被滤空', rows.length, 2);
  eq('取到 nodes_total 列', rows[0]?.nodes_total, '4');
  eq('取到 nodes_online 列', rows[1]?.nodes_online, '1');
  eq('取到 online_ratio 列', rows[1]?.online_ratio, '0.25');
}

console.log('\n=== 3. annotated CSV 解析：空表 ===');
{
  const csv = [
    '#datatype,string,long,dateTime:RFC3339,double',
    '#group,false,false,false,false',
    '#default,_result,,,',
    ',result,table,_time,_value',
    '',
  ].join('\n');
  eq('空表返回 0 行', parseAnnotatedCsv(csv).length, 0);
  eq('空字符串返回 0 行', parseAnnotatedCsv('').length, 0);
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
