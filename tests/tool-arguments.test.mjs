import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool, parseToolArguments, toolArgumentError } from '../src/server/tools.mjs';

test('tool arguments reject malformed JSON and schema failures without guessing values', async () => {
  for (const raw of ['', '{', '{"style":"concise",}', 'null', '[]', '1', '"text"', '{}', '{"citeQuotes":"no"}', '{"citeQuotes":"0"}', '{"style":"concise","extra":1}']) {
    assert.ok(parseToolArguments('update_preferences', raw).error, raw);
  }
  for (const args of [null, [], { content: 'missing path' }, { path: 'output.md', content: 3 }]) {
    // Invalid write requests return before requiring a user, opening a workspace or touching files.
    const result = await executeTool('write_file', args, {});
    assert.equal(result.summary, '工具参数无效');
    assert.deepEqual(result.evidence, []);
  }
  const args = { ref: 12 };
  assert.ok(toolArgumentError('read_source', args));
  assert.deepEqual(args, { ref: 12 });
});

test('lossless provider quirks are repaired before validation and approval binding', () => {
  assert.deepEqual(parseToolArguments('list_files', ''), { args: {} });
  assert.deepEqual(parseToolArguments('list_files', '  \n'), { args: {} });
  assert.deepEqual(parseToolArguments('read_file', '```json\n{"path":"a.txt"}\n```'), { args: { path: 'a.txt' } });
  assert.deepEqual(parseToolArguments('read_file', '{"path":"a.txt","start_line":"3"}'), { args: { path: 'a.txt', start_line: 3 } });
  assert.deepEqual(parseToolArguments('update_preferences', '{"citeQuotes":"false"}'), { args: { citeQuotes: false } });
  // Non-numeric text stays a schema error instead of being guessed.
  assert.ok(parseToolArguments('read_file', '{"path":"a.txt","start_line":"three"}').error);
  assert.ok(parseToolArguments('read_file', '{"path":"a.txt","start_line":"3.5"}').error);
  assert.ok(parseToolArguments('read_file', '{"path":"a.txt","start_line":"9007199254740993"}').error,'unsafe integers cannot be silently rounded');
});

test('failed tool calls are flagged as errors so traces never show them as successes', async () => {
  const result = await executeTool('write_file', { content: 'missing path' }, {});
  assert.equal(result.isError, true);
});

test('nested argument schemas preserve optional defaults and existing extra-field policy', () => {
  const args = { program: '查询 已完成(甲)。', bindings: [{ line: 1, ref: 'source1', quote: '这是一段原文' }] };
  const raw = JSON.stringify(args);
  assert.deepEqual(parseToolArguments('logic_evaluate', raw), { args });
  assert.ok(!Object.hasOwn(args, 'allow_assumptions'));
  assert.ok(toolArgumentError('logic_evaluate', { ...args, bindings: [{ ...args.bindings[0], line: '1' }] }));
  assert.ok(toolArgumentError('logic_evaluate', { ...args, bindings: [{ ...args.bindings[0], unexpected: true }] }));
  assert.ok(toolArgumentError('update_plan', { items: [{ content: '读原文', status: 'invented' }] }));
  assert.equal(toolArgumentError('update_plan', { items: [{ content: '读原文', status: 'pending', extra: 1 }], extra: 1 }), '');
  assert.equal(toolArgumentError('list_files', { extra: 1 }), '');
});
