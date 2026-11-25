import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/server/config.mjs';
import { captureTrajectory, readTrajectories, toSftRows } from '../src/server/trajectory.mjs';

test('capture redacts known arbitrary provider credentials before disk and preserves per-call schema versions', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-trajectory-'));
  const prior = config.dataDir, enabled = config.learning.trajectories; config.dataDir = root; config.learning.trajectories = true;
  t.after(async () => { config.dataDir = prior; config.learning.trajectories = enabled; if (path.dirname(root) === os.tmpdir()) await fs.rm(root, { recursive: true, force: true }); });
  const secret = 'arbitrary-service-credential-12345';
  const tool = { type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } };
  const first = [{ role: 'system', content: 'protocol' }, { role: 'user', content: 'inspect' }];
  const response = { role: 'assistant', content: 'result ' + secret };
  await captureTrajectory({ task: { id: 't1', userId: 'u1', conversationId: 'c1' }, provider: { apiKey: secret, model: 'fixture', baseUrl: 'http://127.0.0.1/v1' },
    status: 'completed', messages: first, answer: response.content, tools: [tool], result: {},
    callSnapshots: [{ messages: first, tools: [], response, finishReason: 'stop', toolMode: 'compatibility-auto',
      backendCapabilities: { schema: 'zhiheng-backend-capabilities/1', source: 'unknown', features: { tools: 'unknown' },
        runtime: { name: 'fixture', version: '1' }, apiKey: secret, endpoint: 'https://user:' + secret + '@example.org/v1' } }] });
  const saved = await fs.readFile(path.join(root, 'trajectories/u1/t1.json'), 'utf8');
  assert.ok(!saved.includes(secret)); assert.match(saved, /REDACTED_KEY/);
  const capturedCall = JSON.parse(saved).callSnapshots[0];
  assert.equal(capturedCall.toolMode, 'compatibility-auto');
  assert.deepEqual(capturedCall.backendCapabilities.features, { tools: 'unknown' });
  assert.deepEqual(capturedCall.backendCapabilities.runtime, { name: 'fixture', version: '1' });
  assert.equal(capturedCall.backendCapabilities.apiKey, '[REDACTED_KEY]');
  assert.ok(!capturedCall.backendCapabilities.endpoint.includes('user:'));
  let envelopes = []; for await (const row of readTrajectories({ userId: 'u1' })) envelopes.push(row);
  assert.deepEqual(envelopes[0].record.integrityIssues, []);
  const rows = toSftRows(envelopes[0].record, { current: { rating: 'up' } });
  assert.equal(rows.length, 0, 'Redacted sensitive context needs human recuration before training');
  const clean = await captureTrajectory({ task: { id: 't2', userId: 'u2', conversationId: 'c2' }, provider: { model: 'fixture' },
    status: 'completed', messages: first, answer: 'safe result', tools: [tool], result: {},
    callSnapshots: [{ messages: first, tools: [], response: { role: 'assistant', content: 'safe result' }, finishReason: 'stop' }] });
  const exact = toSftRows(clean, { current: { rating: 'up' } });
  assert.equal(exact.length, 1); assert.deepEqual(exact[0].tools, []); assert.equal(exact[0].meta.conversationId, 'c2');
  const imageMessages = [...first, { role: 'user', content: [{ type: 'text', text: 'inspect image' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJDREVGSElKS0xNTg==' } }] }];
  const image = await captureTrajectory({ task: { id: 't3', userId: 'u3', conversationId: 'c3' }, provider: {}, status: 'completed', messages: imageMessages, answer: 'image answer',
    callSnapshots: [{ messages: imageMessages, tools: [], response: { role: 'assistant', content: 'image answer' }, finishReason: 'stop' }] });
  assert.ok(!JSON.stringify(image).includes('QUJDREVG')); assert.equal(image.messages.at(-2).multimodalOmitted, true);
  assert.deepEqual(toSftRows(image, { current: { rating: 'up' } }), []);
  const draft = { role: 'assistant', content: '错误草稿 [[S9]]' };
  const repairedMessages = [...first, draft, { role: 'user', content: '[系统交付检查] 来源编号错误，请重新作答。' }];
  const repaired = await captureTrajectory({ task: { id: 't4', userId: 'u4' }, provider: {}, status: 'completed',
    messages: repairedMessages, answer: '修复后的回答', result: { answerContract: { repairs: 1, issues: [], semanticSupportVerified: false } },
    callSnapshots: [{ messages: first, tools: [], response: draft, finishReason: 'stop', toolMode: 'native',
      backendCapabilities: { source: 'verified-local-runtime', features: { tools: 'supported' } } },
    { messages: repairedMessages, tools: [], response: { role: 'assistant', content: '修复后的回答' }, finishReason: 'stop' }] });
  assert.equal(repaired.outcome.answerRepairs, 1); assert.deepEqual(repaired.outcome.answerContractIssues, []);
  assert.deepEqual(toSftRows(repaired, { current: { rating: 'up' } }), [], 'Neither erroneous draft nor repaired snapshot is automatically positive training data');
  const persistedRepair = JSON.parse(await fs.readFile(path.join(root, 'trajectories/u4/t4.json'), 'utf8'));
  assert.equal(persistedRepair.callSnapshots[0].response.content, draft.content);
  assert.equal(persistedRepair.callSnapshots[0].toolMode, 'native');
  assert.equal(persistedRepair.callSnapshots.length, 2, 'Original calls remain available for manual curation');
  const unresolved = await captureTrajectory({ task: { id: 't5', userId: 'u5' }, provider: {}, status: 'completed',
    messages: first, answer: '仍缺原文', result: { answerContract: { repairs: 0, issues: ['requested_exact_quote_missing'] } },
    callSnapshots: [{ messages: first, tools: [], response: { role: 'assistant', content: '仍缺原文' }, finishReason: 'stop' }] });
  assert.deepEqual(unresolved.outcome.answerContractIssues, ['requested_exact_quote_missing']);
  assert.deepEqual(toSftRows(unresolved, { current: { rating: 'up' } }), []);
  // A modified tool manifest must never be substituted into a valid trace.
  const digest = envelopes[0].record.prompt.toolsSha;
  await fs.writeFile(path.join(root, 'trajectories/_tools', digest + '.json'), '[]');
  envelopes = []; for await (const row of readTrajectories()) envelopes.push(row);
  assert.ok(envelopes[0].record.integrityIssues.includes('tool_schema_integrity_failed'));
  assert.deepEqual(toSftRows(envelopes[0].record, { current: { rating: 'up' } }), []);
  // Hash-shaped input is mandatory; no path read based on ../ supplied in JSON.
  const record = JSON.parse(saved); record.prompt.toolsSha = '../../outside';
  await fs.writeFile(path.join(root, 'trajectories/u1/t1.json'), JSON.stringify(record));
  envelopes = []; for await (const row of readTrajectories()) envelopes.push(row);
  assert.ok(envelopes[0].record.integrityIssues.includes('invalid_tools_hash'));
});
