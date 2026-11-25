import test from 'node:test';
import assert from 'node:assert/strict';
import { scrubText, scrubDeep, sftEligible, toSftRow, toDpoRow, promptFingerprint, trajectoryIssues } from '../src/server/trajectory.mjs';

const record = (outcome = {}) => ({
  schema: 'zhiheng-traj/1', taskId: 't1', createdAt: '2026-11-06T00:00:00.000Z', model: { host: '127.0.0.1:8018', model: 'qwen', profile: 'local-qwen' },
  taskMode: 'knowledge', prompt: { systemSha: 'a', toolsSha: 'b', toolNames: [] },
  messages: [{ role: 'system', content: '系统' }, { role: 'user', content: '问题 sk-abcdefghijklmnopqrstuvwx' }, { role: 'assistant', content: '模型回答 [[S1]]' }],
  outcome: { status: 'completed', unverified: [], truncated: false, uncited: false, inference: null, ...outcome },
  capture: { exactCalls: true }, callSnapshots: [{ response: { role: 'assistant', content: '模型回答 [[S1]]' }, finishReason: 'stop' }],
});

test('export scrubbing removes keys, tokens, user paths and e-mail addresses', () => {
  const text = 'key sk-abcdefghijklmnopqrstuvwx Bearer abcdefghijklmnop1234 password=hunter22 C:\\Users\\alice\\doc.txt /home/bob/x a@b.example';
  const scrubbed = scrubText(text);
  for (const secret of ['sk-abcdef', 'abcdefghijklmnop1234', 'hunter22', 'alice', 'bob', 'a@b.example']) assert.ok(!scrubbed.includes(secret), secret);
});

test('SFT selection requires human approval; approval never overrides structural or outcome failures', () => {
  assert.equal(sftEligible(record(), null), false);
  assert.equal(sftEligible(record(), { current: { rating: 'up' } }), true);
  assert.equal(sftEligible(record({ unverified: ['9'] }), null), false);
  assert.equal(sftEligible(record({ truncated: true }), null), false);
  assert.equal(sftEligible(record({ unverified: ['9'] }), { current: { rating: 'up' } }), false);
  assert.equal(sftEligible(record({ truncated: true }), { current: { rating: 'up' } }), false);
  assert.equal(sftEligible(record({ toolErrors: 1 }), { current: { rating: 'up' } }), false);
  assert.equal(sftEligible(record(), { current: { rating: 'down' } }), false);
  assert.equal(sftEligible(record({ status: 'failed' }), { current: { rating: 'up' } }), false);
  const row = toSftRow(record(), null, [{ name: 'search_knowledge', parameters: {} }]);
  assert.ok(!JSON.stringify(row).includes('sk-abcdef'));
  assert.equal(row.tools[0].function.name, 'search_knowledge');
  assert.equal(row.messages.at(-1).content, '模型回答 [[S1]]');
});

test('nested serialized JSON is scrubbed without corrupting tool arguments and no unpaired call can train', () => {
  const value = scrubDeep({ content: JSON.stringify({ apiKey: 'plain-key-123', authorization: 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==', url: 'https://alice:password@example.org/a' }) });
  const parsed = JSON.parse(value.content);
  assert.equal(parsed.apiKey, '[REDACTED_KEY]'); assert.ok(!parsed.url.includes('password'));
  const broken = record(); broken.messages.splice(2, 0, { role: 'tool', content: 'ok', tool_call_id: 'not-offered' });
  assert.ok(trajectoryIssues(broken).includes('orphan_tool_result'));
  assert.equal(sftEligible(broken, { current: { rating: 'up' } }), false);
});

test('a final thumbs-up cannot turn repaired drafts or unresolved delivery issues into positive SFT', () => {
  const up = { current: { rating: 'up' } };
  assert.equal(sftEligible(record(), up), true, 'Older traces without new fields retain existing behavior');
  assert.equal(sftEligible(record({ answerRepairs: 0, answerContractIssues: [] }), up), true);
  for (const outcome of [{ answerRepairs: 1, answerContractIssues: [] },
    { answerRepairs: 0, answerContractIssues: ['requested_exact_quote_missing'] },
    { answerRepairs: 1, answerContractIssues: ['unknown_citation'] },
    { answerRepairs: '1' }, { answerRepairs: -1 }, { answerContractIssues: 'unknown_citation' }]) {
    const candidate = record(outcome), before = structuredClone(candidate);
    assert.equal(sftEligible(candidate, up), false, JSON.stringify(outcome));
    assert.deepEqual(candidate, before, 'Rejected traces remain intact for human curation');
  }
});

test('an auxiliary final answer without its own exact snapshot cannot become a training target', () => {
  const omitted = record(); omitted.callSnapshots[0].response.content = '';
  assert.ok(trajectoryIssues(omitted).includes('final_snapshot_incomplete'));
  assert.equal(sftEligible(omitted, { current: { rating: 'up' } }), false);
  const mismatched = record(); mismatched.messages.at(-1).content = 'auxiliary final answer';
  assert.equal(sftEligible(mismatched, { current: { rating: 'up' } }), false);
  const empty = record(); empty.messages.at(-1).content = ''; empty.callSnapshots[0].response.content = '';
  assert.ok(trajectoryIssues(empty).includes('final_answer_missing'));
  assert.equal(sftEligible(empty, { current: { rating: 'up' } }), false);
});

test('a written correction becomes a preference pair on the final answer', () => {
  assert.equal(toDpoRow(record(), { current: { rating: 'down' } }), null, 'no correction, no pair');
  const pair = toDpoRow(record(), { current: { rating: 'down', reasons: ['wrong_citation'], correction: '正确回答 [[S2]]' } });
  assert.equal(pair.chosen, '正确回答 [[S2]]');
  assert.equal(pair.rejected, '模型回答 [[S1]]');
  assert.equal(pair.prompt.at(-1).role, 'user');
});

test('prompt fingerprints change with the system prompt or the tool set', () => {
  const tools = [{ type: 'function', function: { name: 'a', description: 'x', parameters: {} } }];
  const base = promptFingerprint([{ role: 'system', content: 'p1' }], tools);
  assert.notEqual(base.systemSha, promptFingerprint([{ role: 'system', content: 'p2' }], tools).systemSha);
  assert.notEqual(base.toolsSha, promptFingerprint([{ role: 'system', content: 'p1' }], []).toolsSha);
  assert.deepEqual(base.toolNames, ['a']);
});
