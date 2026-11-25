import test from 'node:test';
import assert from 'node:assert/strict';
import { runLogicProgram, inspectLogicProgram } from '../src/server/logic-runtime.mjs';

const program = '事实 已验证(程序甲)。\n规则 保证：若 已验证(?程序) 则 满足规范(?程序)。\n查询 满足规范(程序甲)。';

test('知衡 worker：完整结果与 AST 跨隔离边界返回，来源白名单仍有效', async () => {
  const result = await runLogicProgram(program);
  assert.equal(result.status, 'complete');
  assert.equal(result.queries[0].status, 'true');
  assert.equal(result.proofs.find((node) => node.kind === 'rule').line, 2);
  const ast = await inspectLogicProgram(program);
  assert.equal(ast.rules[0].head.predicate, '满足规范');
  assert.equal(ast.rules[0].line, 2);
  await assert.rejects(runLogicProgram('事实 P(甲) 依据 "missing"。', { allowedRefs: [] }), { code: 'unbound_reference' });
});

test('知衡 worker：语法/安全错误保留 code 与行列，失败后可立即再次使用', async () => {
  await assert.rejects(runLogicProgram('事实 P(甲)。\n查询 P('), (error) => error.code === 'syntax_error' && error.line === 2 && error.column > 1);
  await assert.rejects(inspectLogicProgram('规则 R：若 P(?x) 则 Q(?y)。'), { code: 'unsafe_rule' });
  const result = await runLogicProgram(program);
  assert.equal(result.queries[0].status, 'true');
});

test('知衡 worker：超限返回错误，不泄露部分闭包；空输入与长度先行限制', async () => {
  await assert.rejects(runLogicProgram(''), { code: 'invalid_program' });
  await assert.rejects(runLogicProgram({ source: program }), { code: 'invalid_program' });
  await assert.rejects(runLogicProgram(' '.repeat(50001) + '查询 P(甲)。'), { code: 'limit_exceeded' });
  await assert.rejects(runLogicProgram(program, { limits: { maxSteps: 1 } }), (error) => error.code === 'limit_exceeded' && error.result === undefined);
  await assert.rejects(inspectLogicProgram('规则 R：若 (P(?x) 或 Q(?x)) 且 (A(?x) 或 B(?x)) 则 C(?x)。', { limits: { maxBranches: 3 } }), { code: 'limit_exceeded' });
  assert.equal((await runLogicProgram(program)).status, 'complete');
});

test('知衡 worker：同时仅接纳四项；完成后槽位立即可复用', async () => {
  // These calls share one synchronous turn, so no worker message can settle before the fifth admission.
  const admitted = Array.from({ length: 4 }, () => runLogicProgram(program));
  const rejected = assert.rejects(runLogicProgram(program), { code: 'logic_busy' });
  const results = await Promise.all(admitted);
  await rejected;
  assert.ok(results.every((result) => result.queries[0].status === 'true'));
  const next = await Promise.all(Array.from({ length: 4 }, () => runLogicProgram(program)));
  assert.ok(next.every((result) => result.status === 'complete'));
});
