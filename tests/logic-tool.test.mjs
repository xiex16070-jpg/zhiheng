import test from 'node:test';
import assert from 'node:assert/strict';

process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
const { evaluateLogicProgram, LOGIC_TOOL_SCHEMA } = await import('../src/server/logic-tool.mjs');
const { executeTool, toolLabel, TOOL_SCHEMAS } = await import('../src/server/tools.mjs');

const program = [
  '事实 已证明(程序甲) 依据 "formal_1"。',
  '规则 可靠：若 已证明(?对象) 则 可用(?对象) 依据 "formal_2"。',
  '查询 可用(程序甲)。',
].join('\n');
const evidence = new Map([
  ['formal_1', { ref: 'formal_1', title: '证明记录', content: '程序甲已有证明。此处是测试前提。', sourceUrl: 'https://example.test/proofs' }],
  ['formal_2', { ref: 'formal_2', title: '适用规则', content: '已证明的对象在此规则系统中可用。' }],
]);
const bindings = [
  { line: 1, ref: 'formal_1', quote: '程序甲已有证明。' },
  { line: 2, ref: 'formal_2', quote: '已证明的对象在此规则系统中可用。' },
];

test('logic_evaluate：真实worker执行可追溯推导，来源逐字检查不冒充语义证明', async () => {
  const result = await evaluateLogicProgram({ program, bindings }, { evidence });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.queries[0].status, 'true');
  assert.ok(result.queries[0].positiveProof);
  assert.ok(result.proofs.some((proof) => proof.kind === 'rule' && proof.premises.length));
  assert.equal(result.verification.formalDerivationVerified, true);
  assert.equal(result.verification.semanticSupportVerified, false);
  assert.equal(result.verification.sourceQuoteChecks.length, 2);
  assert.ok(result.verification.sourceQuoteChecks.every((binding) => binding.semanticMappingVerified === false));
  assert.deepEqual(result.verification.assumedStatements, []);
  assert.equal(evidence.size, 2);
});

test('PDF line wraps inside the source do not reject an otherwise verbatim quote', async () => {
  const wrapped = new Map([
    ['formal_1', { ref: 'formal_1', title: '证明记录', content: '程序甲已有证\n明。此处是测试前提。' }],
    ['formal_2', evidence.get('formal_2')],
  ]);
  const result = await evaluateLogicProgram({ program, bindings }, { evidence: wrapped });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  // The recorded quote is the exact source substring, line break included.
  assert.equal(result.verification.sourceQuoteChecks.find((b) => b.ref === 'formal_1').quote, '程序甲已有证\n明。');
});

test('logic_evaluate：缺失ref、伪造引文、缺少逐条绑定均拒绝', async () => {
  const cases = [
    [{ program, bindings }, new Map(), 'reference_not_retrieved'],
    [{ program, bindings: [{ ...bindings[0], quote: '资料中根本没有这个句子' }, bindings[1]] }, evidence, 'source_quote_mismatch'],
    [{ program, bindings: [bindings[0]] }, evidence, 'source_quote_required'],
    [{ program, bindings: [...bindings, bindings[0]] }, evidence, 'binding_duplicate'],
    [{ program, bindings: [{ ...bindings[0], line: 3 }] }, evidence, 'source_quote_required'],
  ];
  for (const [args, sources, expected] of cases) {
    const result = await evaluateLogicProgram(args, { evidence: sources });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, expected);
    assert.equal(result.queries, undefined);
  }
});

test('grounded aliases resolve only reference tokens; unused quotes never enter verified evidence', async () => {
  const refAliases = new Map([['S1', 'formal_1'], ['S2', 'formal_2']]);
  const src = '事实 S1("S1") 依据 「S1」、S2。 # 依据 S1\n查询 S1("S1")。';
  const all = [{ ...bindings[0], ref: 'S1' }, { ...bindings[1], line: 1, ref: 'S2' },
    { line: 99, ref: 'invented', quote: '无关的引文内容' }];
  const result = await evaluateLogicProgram({ program: src, bindings: all }, { evidence, refAliases, mode: 'logic_evaluate_grounded' });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.program, '事实 S1("S1") 依据 "formal_1"、"formal_2"。 # 依据 S1\n查询 S1("S1")。');
  assert.deepEqual(result.proofs[0].refs, ['formal_1', 'formal_2']);
  assert.deepEqual(result.verification.unusedBindings, [{ line: 99, ref: 'invented' }]);
  assert.equal(result.verification.sourceQuoteChecks.length, 2);
  assert.match(result.warnings.join(' '), /忽略/);
  assert.equal(result.queries[0].status, 'true');
});

test('separate tools preserve assumptions and evidence boundaries', async () => {
  const exercise = '事实 红(甲)。\n查询 红(甲)。';
  for (const name of ['logic_run_assumptions', 'logic_evaluate_grounded']) {
    assert.ok(TOOL_SCHEMAS.some(schema => schema.function.name === name));
    const args = { program: exercise, ...(name === 'logic_evaluate_grounded' ? { bindings: [] } : {}) };
    const result = await executeTool(name, args, { evidence, userId: 'logic-test', preferences: {} });
    if (name === 'logic_run_assumptions') assert.equal(result.logic.verification.assumedStatements.length, 1);
    else assert.equal(JSON.parse(result.text).error.code, 'evidence_required');
  }
  const bypass = await evaluateLogicProgram({ program: exercise, allow_assumptions: true }, { mode: 'logic_evaluate_grounded' });
  assert.equal(bypass.error.code, 'assumption_flag_invalid');
});

test('unallocated local aliases cannot collide with a real external ref in any evidence tool', async () => {
  const quote = '这是外部文献中的逐字内容';
  const evidence = new Map([['S99', { ref: 'S99', kind: 'external', content: quote, title: '测试来源' }]]);
  const ctx = { evidence, localProfile: true, refAliases: new Map([['S1', 'S99']]) };
  for (const name of ['read_source', 'verify_quote']) {
    assert.deepEqual((await executeTool(name, { ref: 'S99', quote }, ctx)).evidence, []);
    assert.equal((await executeTool(name, { ref: 'S1', quote }, ctx)).evidence[0].ref, 'S99');
  }
  const logic = (codeRef, bound, context) => evaluateLogicProgram({
    program: `事实 红(甲) 依据 "${codeRef}"。\n查询 红(甲)。`, bindings: [{ line: 1, ref: bound, quote }],
  }, { ...context, mode: 'logic_evaluate_grounded' });
  assert.equal((await logic('S99', 'S99', ctx)).error.code, 'reference_not_retrieved');
  assert.equal((await logic('S1', 'S99', ctx)).error.code, 'source_quote_required');
  assert.equal((await logic('S1', 'S1', ctx)).ok, true);
  assert.equal((await logic('S99', 'S99', { evidence })).ok, true);
});

test('logic_evaluate：用户显式假设可执行，但unknown不能变成否定，前提不冒充已核验', async () => {
  const example = '事实 已证明(程序甲)。\n查询 已证明(程序甲)。\n查询 可用(程序甲)。';
  const rejected = await evaluateLogicProgram({ program: example });
  assert.equal(rejected.error.code, 'evidence_required');
  const result = await evaluateLogicProgram({ program: example, allow_assumptions: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.queries.map((query) => query.status), ['true', 'unknown']);
  assert.deepEqual(result.verification.assumedStatements, [{ line: 1, kind: 'fact', status: 'assumed' }]);
  assert.equal(result.verification.semanticSupportVerified, false);
  assert.match(result.verification.scope, /不证明这些前提真实/);
});

test('logic_evaluate：Agent注册、执行不把机器推导写入知识库证据', async () => {
  assert.equal(TOOL_SCHEMAS.find((schema) => schema.function.name === 'logic_evaluate'), LOGIC_TOOL_SCHEMA);
  assert.equal(toolLabel('logic_evaluate'), '知衡逻辑推演');
  const before = JSON.stringify([...evidence]);
  const result = await executeTool('logic_evaluate', { program, bindings }, { evidence, userId: 'logic-test', preferences: {} });
  assert.deepEqual(result.evidence, []);
  assert.equal(result.logic.ok, true);
  assert.equal(JSON.parse(result.text).verification.semanticSupportVerified, false);
  assert.equal(JSON.stringify([...evidence]), before);
});

test('logic_evaluate：参数、语法、取消和输入上限失败友好且无部分结论', async () => {
  const controller = new AbortController();
  controller.abort();
  const cases = [
    [null, {}, 'arguments_invalid'],
    [{ program: 'a'.repeat(20001) }, {}, 'program_too_large'],
    [{ program, allow_assumptions: 'false' }, {}, 'assumption_flag_invalid'],
    [{ program, bindings: {} }, {}, 'bindings_invalid'],
    [{ program }, { signal: controller.signal }, 'aborted'],
  ];
  for (const [args, context, expected] of cases) {
    const result = await evaluateLogicProgram(args, context);
    assert.equal(result.error.code, expected);
    assert.equal(result.queries, undefined);
  }
  const syntax = await evaluateLogicProgram({ program: '事实 A(甲)。\n执行 JavaScript("process.exit()")。', allow_assumptions: true });
  assert.equal(syntax.ok, false);
  assert.equal(syntax.error.code, 'syntax_error');
  assert.equal(syntax.error.line, 2);
});
