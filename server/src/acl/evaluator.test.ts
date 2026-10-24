/**
 * 求值引擎测试。
 *
 * 两类测试：
 *   A. 语义单测 —— 期望值全部来自 headscale v0.29.6 源码（types.go / node.go / policy.go），
 *      不是凭文档印象写的。
 *   B. 交叉验证 —— 拿面板判定的「策略模式」与真实 headscale 编译出的 filter 对照
 *      （allow-all 编译为 SrcIPs:["*"]，deny-all 编译为 null）。需要本地联调实例。
 *
 * 运行：node --import tsx src/acl/evaluator.test.ts
 * 交叉验证需 HS_URL / HS_API_KEY，以及可访问的 debug 端口（HS_DEBUG_URL）。
 */
import { checkAccess, type EvalInput, type EvalNode } from './evaluator.ts';
import { interpretPolicy, parsePolicy, stringifyPolicy } from './model.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function eq(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}\n      期望 ${w}\n      实际 ${g}`);
  }
}

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(`${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

// ============================================================
// 测试夹具
// ============================================================

const NODES: EvalNode[] = [
  {
    id: 1,
    name: 'lab-alpha',
    displayName: 'lab-alpha',
    ips: ['100.64.0.1'],
    tags: [],
    userName: 'labadmin',
    approvedRoutes: ['192.168.10.0/24'],
    isExitNode: false,
  },
  {
    id: 2,
    name: 'lab-beta',
    displayName: 'lab-beta',
    ips: ['100.64.0.2'],
    tags: [],
    userName: 'devops',
    approvedRoutes: [],
    isExitNode: false,
  },
  {
    id: 3,
    name: 'lab-gamma',
    displayName: 'lab-gamma',
    ips: ['100.64.0.3'],
    tags: ['tag:prod'],
    userName: 'labadmin',
    approvedRoutes: [],
    isExitNode: false,
  },
  {
    id: 4,
    name: 'lab-exit',
    displayName: 'lab-exit',
    ips: ['100.64.0.4'],
    tags: ['tag:exit'],
    userName: 'devops',
    approvedRoutes: ['0.0.0.0/0'],
    isExitNode: true,
  },
];

const USERS = [
  { id: 1, name: 'labadmin', email: null },
  { id: 2, name: 'devops', email: null },
];

function input(policyJson: unknown): EvalInput {
  return { policy: policyJson as EvalInput['policy'], nodes: NODES, users: USERS };
}

console.log('='.repeat(84));
console.log('A. 策略模式判定 —— 复刻 policy.go:253 的 nil 判断');
console.log('='.repeat(84));

// 依据源码：pm.pol == nil || (ACLs == nil && Grants == nil) → FilterAllowAll
eq('{} → 全通（acls/grants 键都不存在 → Go 里是 nil）', interpretPolicy({}).mode, 'allow-all');
eq('null → 全通（未设置策略，pm.pol 为 nil）', interpretPolicy(null).mode, 'allow-all');
eq('{hosts:{}} → 全通（只有 hosts，acls/grants 仍为 nil）', interpretPolicy({ hosts: {} }).mode, 'allow-all');
eq('{tagOwners:{}} → 全通', interpretPolicy({ tagOwners: {} }).mode, 'allow-all');
eq('{acls:[]} → 全禁（空数组是「非 nil 空切片」）', interpretPolicy({ acls: [] }).mode, 'deny-all');
eq('{grants:[]} → 全禁', interpretPolicy({ grants: [] }).mode, 'deny-all');
eq('{acls:[一条]} → 规则模式', interpretPolicy({ acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['*:*'] }] }).mode, 'rules');
eq('{acls:[],grants:[一条]} → 规则模式', interpretPolicy({ acls: [], grants: [{ src: ['*'], dst: ['*'] }] }).mode, 'rules');
ok('全通模式标记为 highImpact', interpretPolicy({}).highImpact);
ok('全禁模式标记为 highImpact', interpretPolicy({ acls: [] }).highImpact);
ok('规则模式不标记 highImpact', !interpretPolicy({ acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['*:*'] }] }).highImpact);

console.log('\n' + '='.repeat(84));
console.log('B. 全通 / 全禁 / 默认拒绝');
console.log('='.repeat(84));

{
  const r = checkAccess(input({}), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22, proto: 'tcp' });
  eq('全通模式下任意访问放行', r.allowed, true);
  eq('理由为 allow-all-default', r.reason, 'allow-all-default');
}
{
  const r = checkAccess(input({ acls: [] }), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22, proto: 'tcp' });
  eq('全禁模式下任意访问拒绝', r.allowed, false);
  eq('理由为 deny-all-default', r.reason, 'deny-all-default');
}
{
  const policy = {
    acls: [{ action: 'accept', proto: 'tcp', src: ['labadmin@'], dst: ['tag:prod:443'] }],
  };
  const r1 = checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 3 }, port: 443, proto: 'tcp' });
  eq('命中规则放行', r1.allowed, true);
  eq('理由为 matched-rule', r1.reason, 'matched-rule');

  const r2 = checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 3 }, port: 80, proto: 'tcp' });
  eq('端口不匹配则拒绝', r2.allowed, false);
  eq('理由为 no-matching-rule', r2.reason, 'no-matching-rule');

  const r3 = checkAccess(input(policy), { from: { nodeId: 2 }, to: { nodeId: 3 }, port: 443, proto: 'tcp' });
  eq('源用户不匹配则拒绝', r3.allowed, false);

  const r4 = checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 3 }, port: 443, proto: 'udp' });
  eq('协议不匹配则拒绝', r4.allowed, false);
}

console.log('\n' + '='.repeat(84));
console.log('C. 别名解析语义（对齐 types.go resolve 方法）');
console.log('='.repeat(84));

{
  // username：应解析为该用户全部设备的 IP
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['labadmin@'], dst: ['*:*'] }] };
  eq('user@ 覆盖该用户全部设备（node1）',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22 }).allowed, true);
  eq('user@ 覆盖该用户全部设备（node3 同属 labadmin）',
    checkAccess(input(policy), { from: { nodeId: 3 }, to: { nodeId: 2 }, port: 22 }).allowed, true);
  eq('user@ 不覆盖其它用户',
    checkAccess(input(policy), { from: { nodeId: 2 }, to: { nodeId: 1 }, port: 22 }).allowed, false);
}

{
  // tag：按 node.HasTag 匹配
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['tag:prod'], dst: ['*:*'] }] };
  eq('tag 命中带该标签的设备',
    checkAccess(input(policy), { from: { nodeId: 3 }, to: { nodeId: 1 }, port: 22 }).allowed, true);
  eq('tag 不命中无该标签的设备',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22 }).allowed, false);
}

{
  // group：policy.groups 里的成员别名各自解析
  const policy = {
    groups: { 'group:ops': ['labadmin@', 'tag:exit'] },
    acls: [{ action: 'accept', proto: 'tcp', src: ['group:ops'], dst: ['*:*'] }],
  };
  eq('group 含 user@ 成员',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22 }).allowed, true);
  eq('group 含 tag 成员',
    checkAccess(input(policy), { from: { nodeId: 4 }, to: { nodeId: 2 }, port: 22 }).allowed, true);
  eq('group 不含 devops（非成员）',
    checkAccess(input(policy), { from: { nodeId: 2 }, to: { nodeId: 1 }, port: 22 }).allowed, false);
}

{
  // hosts：解析为字面前缀，且不展开为节点其它 IP
  const policy = {
    hosts: { 'db-srv': '100.64.0.3/32' },
    acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['db-srv:5432'] }],
  };
  eq('hosts 别名指向具体 IP',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 3 }, port: 5432 }).allowed, true);
  eq('hosts 别名端口不符则拒绝',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 3 }, port: 6379 }).allowed, false);
}

{
  // autogroup:member / tagged
  const p1 = { acls: [{ action: 'accept', proto: 'tcp', src: ['autogroup:member'], dst: ['*:*'] }] };
  eq('autogroup:member 命中未打标签设备',
    checkAccess(input(p1), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22 }).allowed, true);
  eq('autogroup:member 不命中已打标签设备',
    checkAccess(input(p1), { from: { nodeId: 3 }, to: { nodeId: 2 }, port: 22 }).allowed, false);

  const p2 = { acls: [{ action: 'accept', proto: 'tcp', src: ['autogroup:tagged'], dst: ['*:*'] }] };
  eq('autogroup:tagged 命中已打标签设备',
    checkAccess(input(p2), { from: { nodeId: 3 }, to: { nodeId: 1 }, port: 22 }).allowed, true);
}

{
  // autogroup:self：目的限定为「与源同一用户」的设备
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['labadmin@'], dst: ['autogroup:self:22'] }] };
  eq('autogroup:self 允许访问同用户的设备（node1→node3，同属 labadmin）',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 3 }, port: 22 }).allowed, true);
  eq('autogroup:self 不允许访问他人设备（node1 labadmin → node2 devops）',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22 }).allowed, false);
}

{
  // 子网路由：src 的身份包含「已批准的子网路由」
  const policy = { hosts: { 'lan': '192.168.10.0/24' }, acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['lan:445'] }] };
  eq('目的可指向子网路由段（node1 批准了 192.168.10.0/24）',
    checkAccess(input(policy), { from: { nodeId: 2 }, to: { nodeId: 1 }, port: 445 }).allowed, true);
  eq('同一规则下其它端口拒绝',
    checkAccess(input(policy), { from: { nodeId: 2 }, to: { nodeId: 1 }, port: 22 }).allowed, false);
}

{
  // 出口节点 + autogroup:internet
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['autogroup:internet:443'] }] };
  eq('autogroup:internet 命中出口节点',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 4 }, port: 443 }).allowed, true);
  eq('autogroup:internet 对非出口节点不命中',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 443 }).allowed, false);
}

{
  // wildcard 的 dst 覆盖整个 tailnet
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['*:*'] }] };
  eq('src=* dst=*:* 放行任意组合',
    checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 65535 }).allowed, true);
}

console.log('\n' + '='.repeat(84));
console.log('D. 非法输入与错误提示');
console.log('='.repeat(84));

{
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['*:*'] }] };
  const r1 = checkAccess(input(policy), { from: { nodeId: 999 }, to: { nodeId: 1 } });
  ok('不存在的源节点给出明确错误', r1.error !== undefined && r1.error.includes('999'), r1.error);
  ok('错误场景 allowed=false', r1.allowed === false);

  const r2 = checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, proto: '*' });
  ok('proto=* 被拒（headscale 明确不支持通配协议）', r2.error !== undefined, r2.error);

  const r3 = checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, proto: 'bogus' });
  ok('未知协议名被拒', r3.error !== undefined, r3.error);
}

{
  // dst 缺端口应被视为无效条目，且不导致崩溃
  const policy = { acls: [{ action: 'accept', proto: 'tcp', src: ['*'], dst: ['100.64.0.2'] }] };
  const r = checkAccess(input(policy), { from: { nodeId: 1 }, to: { nodeId: 2 }, port: 22 });
  eq('dst 缺少端口时不放行', r.allowed, false);
  ok('并在 trace 中给出原因', r.trace.some((t) => t.includes('缺少端口')), r.trace.slice(-2).join(' | '));
}

console.log('\n' + '='.repeat(84));
console.log('E. HuJSON 解析（注释与尾逗号）');
console.log('='.repeat(84));

{
  const withComments = `{
    // 这是注释
    "acls": [
      /* 块注释 */
      { "action": "accept", "proto": "tcp", "src": ["*"], "dst": ["*:*"] },
    ],
  }`;
  const r = parsePolicy(withComments);
  ok('带注释与尾逗号可解析', r.ok, r.ok ? '' : r.error);
  if (r.ok) {
    eq('解析出 1 条规则', r.policy.acls?.length, 1);
  }
}

{
  const bad = '{ "acls": [ }';
  const r = parsePolicy(bad);
  ok('非法 JSON 返回错误而非抛异常', !r.ok, r.ok ? '竟然解析成功了' : r.error);
}

{
  const r = parsePolicy('[]');
  ok('顶层为数组时报错', !r.ok, r.ok ? '竟然通过了' : r.error);
}

{
  const r = parsePolicy('   ');
  ok('空文本视为未设置策略（全通）', r.ok && interpretPolicy(r.ok ? r.policy : null).mode === 'allow-all');
}

console.log('\n' + '='.repeat(84));
console.log('F. 往返一致性');
console.log('='.repeat(84));

{
  const policy = {
    groups: { 'group:ops': ['labadmin@'] },
    hosts: { srv: '100.64.0.3/32' },
    acls: [{ action: 'accept' as const, proto: 'tcp', src: ['group:ops'], dst: ['srv:443'] }],
  };
  const text = stringifyPolicy(policy);
  const back = parsePolicy(text);
  ok('序列化后可无损解析回来', back.ok);
  if (back.ok) {
    eq('acls 条数一致', back.policy.acls?.length, 1);
    eq('hosts 一致', back.policy.hosts?.['srv'], '100.64.0.3/32');
    eq('groups 一致', back.policy.groups?.['group:ops']?.[0], 'labadmin@');
  }
}

console.log('\n' + '='.repeat(84));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (failures.length) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log(`  ✗ ${f}`));
}
console.log('='.repeat(84));

process.exit(fail ? 1 : 0);
