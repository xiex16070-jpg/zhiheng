import test from 'node:test';
import assert from 'node:assert/strict';
import { compareModelPairs } from '../evals/model-pairs.mjs';
import { digest } from '../evals/annotation-workflow.mjs';

function fixture() {
  return { schema: 'zhiheng/model-pair/1', kind: 'synthetic_fixture', suiteSha256: digest('fixed split'),
    model: { id: 'example', version: 'fixture-v1', runtimeVersion: 'fixture-runtime' }, cases: [{
      caseId: 'public-test', capture: { exactCalls: true, truncated: false, redacted: false },
      fixtureSha256: digest('project, grants, corpus'), conditionsSha256: digest('budget and decoding'),
      rubric: { expectedCalls: [{ name: 'lookup', arguments: { doc: 7 } }], responseSchema: { type: 'object', required: ['x'], properties: { x: { type: 'integer' } } } },
      snapshot: { messages: [{ role: 'user', content: 'Find 7' }], tools: [{ name: 'lookup' }],
        response: { role: 'assistant', content: '{"x":7}', tool_calls: [{ function: { name: 'lookup', arguments: '{"doc":7}' } }] } },
      observations: { taskSuccess: { value: true, evidenceSha256: digest('frozen check') }, latencyMs: 10 },
    }] };
}
test('fixed prestate differences in tool args and JSON change measured scores, missing cost and citation stay unknown', () => {
  const a = fixture(), b = fixture(), row = b.cases[0];
  b.model.id = 'candidate'; row.snapshot.response.tool_calls[0].function.arguments = '{"doc":9}';
  row.snapshot.response.content = '{"x":false}'; row.observations.costUSD = 0;
  const r = compareModelPairs(a,b);
  assert.equal(r.matched, 1);
  assert.deepEqual(r.metrics.toolCallCorrect, { paired: 1, baselineMean: 1, candidateMean: 0 });
  assert.equal(r.metrics.structuredOutputValid.candidateMean, 0);
  assert.equal(r.metrics.citationCorrect.baselineMean, null);
  assert.equal(r.metrics.costUSD.paired, 0);
  assert.equal(r.metrics.taskSuccess.baselineMean, 1);
});
test('different approval/fixture, tools, transcript, budget, or rubric cannot be paired; missing cases count', () => {
  for (const mutate of [r => { r.fixtureSha256 = digest('different grant'); }, r => { r.conditionsSha256 = digest('other budget'); },
    r => { r.snapshot.messages.push({ role: 'tool', content: 'later state' }); }, r => { r.snapshot.tools = []; }, r => { r.rubric.expectedCalls = []; }]) {
    const a = fixture(), b = fixture(); mutate(b.cases[0]);
    const r = compareModelPairs(a,b); assert.equal(r.matched, 0); assert.equal(r.excluded.differentState, 1);
  }
  const a = fixture(), b = fixture(); b.cases[0].caseId = 'absent';
  assert.deepEqual(compareModelPairs(a,b).excluded, { missingLeft: 1, missingRight: 1, incompleteCapture: 0, differentState: 0 });
  a.cases.push(a.cases[0]); assert.throws(() => compareModelPairs(a,b), /duplicate/);
});
test('legacy, truncated or redacted capture cannot establish an identical decision state', () => {
  for (const capture of [null, { exactCalls: false }, { exactCalls: true, truncated: true, redacted: false }, { exactCalls: true, truncated: false, redacted: true }]) {
    const a = fixture(), b = fixture();
    a.cases[0].capture = capture;
    assert.equal(compareModelPairs(a,b).excluded.incompleteCapture, 1);
  }
  const a = fixture(), b = fixture();
  a.cases[0].snapshot.messages[0].truncatedChars = 90000;
  assert.equal(compareModelPairs(a,b).excluded.incompleteCapture, 1);
  for (const p of [a,b]) {
    delete p.cases[0].snapshot.messages[0].truncatedChars;
    delete p.cases[0].snapshot.response;
    delete p.cases[0].observations;
  }
  assert.equal(compareModelPairs(a,b).status, 'no_paired_observations');
  for (const p of [a,b]) { p.cases[0].snapshot.response = {}; p.cases[0].rubric = { expectedCalls: [] }; }
  assert.equal(compareModelPairs(a,b).metrics.toolCallCorrect.paired, 0);
});
