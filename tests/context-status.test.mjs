import test from 'node:test';
import assert from 'node:assert/strict';
import { contextStatus, withContextStatus, summarizeForNewContext } from '../src/server/context-status.mjs';
test('context budget replaces hints and carries no approval state', async () => {
  const input = [{ role: 'user', content: '研究问题' }]; const first = withContextStatus(input, { budget: 100, round: 2, maxRounds: 8 }); const next = withContextStatus(first.messages, { budget: 100 });
  assert.equal(next.messages.length, 2); assert.equal(first.status.remainingRounds, 6); assert.equal(first.status.tokens, contextStatus(input).tokens);
  assert.equal(next.messages.at(-1), input[0]); assert.equal(next.status.tokens, first.status.tokens);
  const summary = await summarizeForNewContext({ messages: input }); assert.equal(summary.carryApprovals, false); assert.equal(summary.llmCalls.aux, 0); assert.match(summary.summary, /不是用户输入或任何批准/);
  let count = 0; const long = Array.from({ length: 8 }, () => ({ role: 'user', content: '中'.repeat(1000) }));
  const compacted = await summarizeForNewContext({ messages: long, aux: { allowed: true, use: () => count++ }, compact: async () => ({ messages: input, mode: 'llm' }) }); assert.equal(compacted.llmCalls.aux, 1); assert.equal(count, 1);
});
test('context hint is separate runtime data while preserving the system cache prefix and complete tool pairs', () => {
  const evidence = { role: 'user', content: '来源 [1]：原文' };
  const input = [{ role: 'system', content: '原始规则\n第二条规则' }, evidence];
  let current = withContextStatus(input, { budget: 100 });
  for (let round = 1; round < 6; round++) current = withContextStatus(current.messages, { budget: 100, round });
  assert.equal(current.messages.length, 3); assert.equal(current.messages.at(-1), evidence);
  assert.equal(current.messages.filter(message=>message._runtimeStatus).length, 1);
  assert.equal(current.status.tokens, contextStatus(input).tokens);
  assert.equal(current.messages[0].content,'原始规则\n第二条规则');
  const migrated = withContextStatus([...current.messages, { role: 'system', content: '[CONTEXT BUDGET STATUS] stale appended status' }]);
  assert.equal(migrated.messages.length, 3); assert.equal(migrated.messages.at(-1), evidence); assert.equal(migrated.status.tokens, current.status.tokens);
  const paired=[input[0],{role:'assistant',content:'',tool_calls:[{id:'a',function:{name:'current_time',arguments:'{}'}}]},{role:'tool',tool_call_id:'a',content:'now'}];
  const updated=withContextStatus(paired);
  assert.equal(updated.messages[1],paired[1]);assert.equal(updated.messages[2],paired[2]);assert.equal(updated.messages.at(-1)._runtimeStatus,true);
});
test('transport base64 size does not masquerade as text tokens in multimodal context', async () => {
  const { estimateTokens } = await import('../src/server/context.mjs');
  const count = length => estimateTokens([{ role: 'user', content: [{ type: 'text', text: '请描述图片中的证据。' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(length) } }] }]);
  assert.equal(count(100), count(4 * 1024 * 1024));
  assert.ok(count(100) > 2000 && count(100) < 10000);
});
