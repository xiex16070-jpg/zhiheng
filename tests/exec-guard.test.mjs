import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseCommandRisk } from '../src/server/exec-guard.mjs';
test('risk advice can never grant approval and has an independent auxiliary budget', async () => {
  const state = {}; let calls = 0;
  const opts = { argv: ['node', '--version'], state, enabled: true, chat: async () => { calls++; return { content: '{"decision":"APPROVE","reason":"read only"}' }; } };
  for (let i = 0; i < 3; i++) { const r = await adviseCommandRisk(opts); assert.equal(r.requiresApproval, true); assert.equal(r.decision, 'APPROVE'); assert.equal(r.llmCalls.aux, 1); }
  assert.equal((await adviseCommandRisk(opts)).decision, 'ESCALATE'); assert.equal(calls, 3);
  assert.equal((await adviseCommandRisk({ ...opts, classification: { mode: 'deny' } })).decision, 'DENY');
  const invalid = await adviseCommandRisk({ ...opts, state: {}, chat: async () => ({ content: 'APPROVE' }) }); assert.equal(invalid.decision, 'ESCALATE'); assert.equal(invalid.llmCalls.aux, 1);
});
