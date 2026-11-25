import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProgram, runProgram, HanLogicError, DEFAULT_LIMITS } from '../src/logic/hanlogic.mjs';

const status = (source, options) => runProgram(source, options).queries.map((query) => query.status);
const hasCode = (code) => (error) => error instanceof HanLogicError && error.code === code;

test('知衡：演绎、多跳与共享变量连接，保留可追踪的来源 DAG', () => {
  const result = runProgram(`事实 前置(甲) 依据 "s1"。
事实 已验证(甲) 依据 "s2"。
事实 已验证(乙) 依据 "s3"。
规则 契约：若 前置(?程序) 且 已验证(?程序) 则 后置(?程序) 依据 "r1"。
规则 扩展：若 后置(?程序) 则 可交付(?程序) 依据 "r2"。
查询 可交付(甲)。查询 可交付(乙)。`);
  assert.deepEqual(result.queries.map((q) => q.status), ['true', 'unknown']);
  const byId = new Map(result.proofs.map((p) => [p.id, p]));
  const root = byId.get(result.queries[0].positiveProof);
  assert.equal(root.rule, '扩展'); assert.equal(root.line, 5);
  const premise = byId.get(root.premises[0]);
  assert.deepEqual(premise.refs, ['r1']); assert.equal(premise.line, 4);
  assert.deepEqual(premise.premises.map((id) => byId.get(id).refs[0]), ['s1', 's2']);
});

test('知衡：未知不等于否定；正反支持独立、冲突不爆炸', () => {
  assert.deepEqual(status(`事实 P(甲)。事实 非 P(甲)。事实 非 P(乙)。
查询 P(甲)。查询 P(乙)。查询 P(丙)。查询 非 P(丙)。查询 任意(甲)。查询 非 P(乙)。`),
  ['both', 'false', 'unknown', 'unknown', 'unknown', 'true']);
});

test('知衡：不偷换逆命题、逆否命题或必要条件方向', () => {
  assert.deepEqual(status(`事实 后置(甲)。事实 非 后置(乙)。
规则 契约：若 前置(?x) 则 后置(?x)。
查询 前置(甲)。查询 非 前置(乙)。`), ['unknown', 'unknown']);
  assert.deepEqual(status(`事实 执行(甲)。事实 许可(乙)。
规则 必要：只有 许可(?x) 才 执行(?x)。
查询 许可(甲)。查询 执行(乙)。`), ['true', 'unknown']);
});

test('知衡：且优先于或，括号控制分组，显式否定可作为有证据的条件', () => {
  assert.deepEqual(status(`事实 A(甲)。事实 B(乙)。事实 C(乙)。事实 B(丙)。事实 非 A(丁)。
规则 合取优先：若 A(?x) 或 B(?x) 且 C(?x) 则 D(?x)。
规则 分组：若 (A(?x) 或 B(?x)) 且 C(?x) 则 E(?x)。
规则 反证：若 非 A(?x) 则 F(?x)。
查询 D(甲)。查询 D(乙)。查询 D(丙)。查询 E(甲)。查询 E(乙)。查询 F(丁)。`),
  ['true', 'true', 'unknown', 'unknown', 'true', 'true']);
});

test('知衡：中文引号、全角括号标点、注释及有类型常量', () => {
  assert.deepEqual(status(`// 引号中的句号与关键字不会切断语句
事实 标签（“若。且”，「甲」）。 # 行尾注释
事实 数值(甲, 2)。事实 数值(乙, "2")。
规则 匹配：若 数值(?x, 2) 则 命中(?x)。
查询 标签("若。且", 甲)。查询 命中(甲)。查询 命中(乙)。`), ['true', 'true', 'unknown']);
});

test('知衡：重复变量约束、递归闭包、重复事实及证明无循环', () => {
  const result = runProgram(`事实 边(甲,乙)。事实 边(乙,丙)。事实 边(甲,乙)。
规则 基础：若 边(?x,?y) 则 路径(?x,?y)。
规则 传递：若 路径(?x,?y) 且 边(?y,?z) 则 路径(?x,?z)。
规则 自环：若 路径(?x,?x) 则 环(?x)。
规则 空转：若 路径(?x,?y) 则 路径(?x,?y)。
查询 路径(甲,丙)。查询 环(甲)。`);
  assert.deepEqual(result.queries.map((q) => q.status), ['true', 'unknown']);
  assert.equal(result.facts.length, 5);
  for (const proof of result.proofs) for (const parent of proof.premises) assert.ok(Number(parent.slice(1)) < Number(proof.id.slice(1)));
});

test('知衡：除非在较低层闭包后执行，未检出例外不产生显式否定', () => {
  const result = runProgram(`事实 测试(甲)。事实 测试(乙)。事实 失败(乙)。
规则 候选：若 测试(?x) 则 候选(?x) 除非 反例(?x)。
规则 发现：若 失败(?x) 则 反例(?x)。
查询 候选(甲)。查询 候选(乙)。查询 非 反例(甲)。`);
  assert.deepEqual(result.queries.map((q) => q.status), ['true', 'unknown', 'unknown']);
  const proof = result.proofs.find((p) => p.rule === '候选');
  assert.deepEqual(proof.assumptions, [{ kind: 'not-derived', literal: '反例(甲)', scope: 'current-program' }]);
  assert.match(result.warnings.join(' '), /不构成现实世界中的否定证据/);
});

test('知衡：例外有正反冲突时仍阻止缺省规则；可声明多个例外', () => {
  assert.deepEqual(status(`事实 S(甲)。事实 S(乙)。事实 E(甲)。事实 非 E(甲)。事实 F(乙)。
规则 缺省：若 S(?x) 则 P(?x) 除非 E(?x) 或 F(?x)。
查询 P(甲)。查询 P(乙)。`), ['unknown', 'unknown']);
});

test('知衡：拒绝不安全变量、隐式全称事实、变量查询和参数数量错配', () => {
  for (const source of ['事实 P(?x)。', '查询 P(?x)。', '规则 R：若 P(?x) 则 Q(?y)。',
    '规则 R：若 P(?x) 或 Q(?y) 则 R(?x)。', '规则 R：若 P(?x) 则 Q(?x) 除非 E(?y)。']) {
    assert.throws(() => runProgram(source), hasCode('unsafe_rule'));
  }
  assert.throws(() => runProgram('事实 P(甲)。查询 P(甲,乙)。'), hasCode('syntax_error'));
});

test('知衡：拒绝经显式否定或正依赖掩藏的除非循环', () => {
  for (const source of [
    '规则 R：若 S(?x) 则 P(?x) 除非 P(?x)。',
    '规则 R：若 S(?x) 则 P(?x) 除非 Q(?x)。规则 T：若 P(?x) 则 Q(?x)。',
    '规则 R：若 S(?x) 则 非 P(?x) 除非 Q(?x)。规则 T：若 非 P(?x) 则 Q(?x)。',
  ]) assert.throws(() => parseProgram(source), hasCode('unstratified_negation'));
});

test('知衡：来源白名单与必需依据检查只保证绑定，不声称语义真实性', () => {
  const source = '事实 P(甲) 依据 "s1"。查询 P(甲)。';
  assert.equal(runProgram(source, { allowedRefs: ['s1'], requireEvidence: true }).queries[0].status, 'true');
  assert.throws(() => runProgram(source, { allowedRefs: [] }), hasCode('unbound_reference'));
  assert.throws(() => runProgram('事实 P(甲)。', { requireEvidence: true }), hasCode('unbound_reference'));
  assert.match(runProgram(source).warnings.join(''), /前提真实性仍须核验/);
});

test('三种求解计划产生一致的递归查询，增量减少重复匹配，魔集传递对象约束', () => {
  const program = [
    ...Array.from({ length: 9 }, (_, i) => `事实 边(${i},${i + 1})。`),
    '规则 单步：若 边(?x,?y) 则 路(?x,?y)。',
    '规则 连接：若 路(?x,?z) 且 路(?z,?y) 则 路(?x,?y)。', '查询 路(7,9)。',
  ].join('\n');
  const [full, delta, magic] = ['naive', 'semi-naive', 'magic-sets'].map(algorithm => runProgram(program, { algorithm }));
  for (const result of [full, delta, magic]) {
    assert.equal(result.queries[0].status, 'true');
    const seen = new Set();
    for (const proof of result.proofs) {
      assert.ok(proof.premises.every(id => seen.has(id)));
      seen.add(proof.id);
    }
    assert.ok(seen.has(result.queries[0].positiveProof));
  }
  const conclusions = result => result.facts.map(f => f.text).sort();
  assert.deepEqual(conclusions(full), conclusions(delta));
  assert.ok(delta.stats.comparisons < full.stats.comparisons);
  assert.equal(magic.factScope, 'query');
  assert.ok(magic.stats.demandPatterns > 1);
  assert.ok(!conclusions(magic).includes('路(0，9)'));
  const withoutQuery = program.slice(0, program.indexOf('查询'));
  const materialized = runProgram(withoutQuery, { algorithm: 'magic-sets' });
  assert.equal(materialized.factScope, 'complete');
  assert.deepEqual(conclusions(materialized), conclusions(full));
});

test('正反需求、分层例外、非线性和互递归、重复变量与常量类型在各计划一致', () => {
  const program = `事实 A(甲)。事实 A(乙)。事实 问题(甲)。事实 P(1)。
    规则 初查：若 问题(?x) 则 待核(?x)。规则 核查：若 待核(?x) 则 例外(?x)。
    规则 许可：若 A(?x) 则 许可(?x) 除非 例外(?x)。
    规则 反证：若 A(?x) 则 非 许可(?x)。规则 互返：若 可达(?x,?y) 则 路(?x,?y)。
    规则 起点：若 P(?x) 则 路(?x,?x)。规则 互递：若 路(?x,?y) 则 可达(?x,?y)。
    查询 非 许可(乙)。查询 许可(甲)。查询 许可(丙)。查询 可达(1,1)。查询 可达(1,"1")。`;
  for (const algorithm of ['naive', 'semi-naive', 'magic-sets']) {
    const statuses = source => runProgram(source, { algorithm }).queries.map(q => q.status);
    assert.deepEqual(statuses(program), ['both', 'false', 'unknown', 'true', 'unknown']);
    // A single positive-stratum demand must also reject an inconsistent repeated head binding.
    assert.deepEqual(statuses('事实 P(1)。规则 R：若 P(?x) 则 Q(?x,?x)。查询 Q(1,"1")。'), ['unknown']);
  }
  for (const invalid of ['__proto__', 'unknown', null, 1]) {
    assert.throws(() => runProgram(program, { algorithm: invalid }), hasCode('invalid_option'));
  }
});

test('知衡：所有可调资源限制只能收紧，超限必须失败而非返回截断未知', () => {
  assert.throws(() => runProgram('事实 P(甲)。事实 P(乙)。', { limits: { maxFacts: 1 } }), hasCode('limit_exceeded'));
  assert.throws(() => runProgram('事实 P(甲)。规则 R：若 P(?x) 则 Q(?x)。查询 Q(甲)。', { limits: { maxSteps: 1 } }), hasCode('limit_exceeded'));
  assert.throws(() => runProgram(' '.repeat(DEFAULT_LIMITS.maxSourceChars + 1), { limits: { maxSourceChars: Number.MAX_SAFE_INTEGER } }), hasCode('limit_exceeded'));
  assert.throws(() => parseProgram('规则 R：若 (A(?x) 或 B(?x)) 且 (C(?x) 或 D(?x)) 则 E(?x)。', { limits: { maxBranches: 3 } }), hasCode('limit_exceeded'));
  assert.throws(() => runProgram('查询 P(甲)。', { limits: { maxMilliseconds: Infinity } }), hasCode('invalid_option'));
  assert.throws(() => parseProgram(`规则 R：若 ${'('.repeat(50)}P(?x)${')'.repeat(50)} 则 Q(?x)。`), hasCode('limit_exceeded'));
});

test('知衡：无 JS 执行入口，定位语法错误且不接受伪装关键字', () => {
  for (const source of ['process.exit(0)', '事实 P(甲)。\nglobalThis.x = 1', '事实 P(甲)。规则 R：若 P(?x) 则 Q(f(?x))。',
    '"事实" P(甲)。', '?事实 P(甲)。', '事实 P("坏\\z")。', '事实 P(9007199254740993)。', '事实 P(0.10000000000000001)。']) assert.throws(() => runProgram(source), hasCode('syntax_error'));
  assert.throws(() => parseProgram('事实 P(甲)。\n查询 P(甲'), (error) => error.code === 'syntax_error' && error.line === 2 && error.column > 1);
});

test('知衡 CLI：示例可执行、stdin支持JSON并以非零码报告错误', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  for (const file of ['program-verification', 'evidence-conflicts', 'exceptions']) {
    const result = JSON.parse(execFileSync(process.execPath, ['scripts/hanlogic.mjs', `examples/hanlogic/${file}.han`, '--json'], { cwd: root, encoding: 'utf8' }));
    assert.equal(result.status, 'complete'); assert.ok(result.queries.length >= 3);
  }
  const stdin = spawnSync(process.execPath, ['scripts/hanlogic.mjs', '-', '--json'], { cwd: root, input: '查询 未知(甲)。', encoding: 'utf8' });
  assert.equal(stdin.status, 0); assert.equal(JSON.parse(stdin.stdout).queries[0].status, 'unknown');
  const bad = spawnSync(process.execPath, ['scripts/hanlogic.mjs', '-', '--json'], { cwd: root, input: '事实 P(?x)。', encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(JSON.parse(bad.stderr).error, 'unsafe_rule');
});
