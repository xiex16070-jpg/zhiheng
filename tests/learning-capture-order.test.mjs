import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/server/orchestrator.mjs', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

function captureFixture({ enabled = true, local = false, learning = 'on' } = {}) {
  let releaseCapture, failCapture;
  const captured = new Promise((resolve, reject) => { releaseCapture = resolve; failCapture = reject; });
  const observations = { captured: false, counters: 0, snapshots: [], warnings: [] };
  const start = source.indexOf('function queueLearnReview(');
  const end = source.indexOf('\n/** 工具异常', start);
  const hookStart = source.indexOf('  // 学习闭环：任务结束');
  const hookEnd = source.indexOf('\n  return { paused: false, result };', hookStart);
  assert.ok(start > 0 && end > start && hookStart > 0 && hookEnd > hookStart);
  const context = vm.createContext({
    config: { learning: { enabled } }, isLocalQwen: () => local,
    bumpTaskCounter: async () => { observations.counters++; }, collectObservations: () => [], shouldReview: async () => true,
    queueReview: () => observations.snapshots.push(observations.captured),
    getStore: () => ({ getPreferences: async () => ({ learning }) }),
    console: { warn: (...args) => observations.warnings.push(args.join(' ')) },
    task: { userId: 'user-fixture', question: 'known source' }, taskId: 'task-fixture', provider: { model: 'fixture' },
    messages: [], result: { body: 'known result' }, prefs: { learning },
    loadConclusions: async () => ({
      captureTaskConclusions: async () => { await captured; observations.captured = true; return { added: 1 }; },
      queueKnowledgeReview: () => true,
    }),
  });
  // Run the real completion hook and scheduler. Only the asynchronous storage
  // dependency is replaced, keeping the old race deterministic without sleeps.
  vm.runInContext(`${source.slice(start, end)}\nthis.complete = () => {${source.slice(hookStart, hookEnd)
    .replace("import('./knowledge-conclusions.mjs')", 'loadConclusions()')} };`, context);
  return { observations, complete: context.complete, releaseCapture, failCapture };
}

test('completion returns promptly while its learning snapshot waits for durable conclusion capture', async () => {
  const fixture = captureFixture();
  assert.equal(fixture.complete(), undefined, 'completion does not await storage or learning');
  await tick();
  assert.equal(fixture.observations.counters, 0);
  assert.deepEqual(fixture.observations.snapshots, [], 'do not consume the one review call before the new candidate exists');
  fixture.releaseCapture(); await tick();
  assert.equal(fixture.observations.counters, 1);
  assert.deepEqual(fixture.observations.snapshots, [true]);
});

test('capture failure does not suppress the remaining memory and skill learning', async () => {
  const fixture = captureFixture();
  fixture.complete(); fixture.failCapture(new Error('isolated capture failure')); await tick();
  assert.equal(fixture.observations.counters, 1);
  assert.deepEqual(fixture.observations.snapshots, [false]);
  assert.equal(fixture.observations.warnings.length, 1);
});

test('disabled or local-model learning still consumes a capture failure without extra model calls', async () => {
  for (const options of [{ enabled: false }, { local: true }, { learning: 'off' }]) {
    const fixture = captureFixture(options);
    fixture.complete(); fixture.failCapture(new Error('isolated capture failure')); await tick();
    assert.equal(fixture.observations.counters, 0);
    assert.deepEqual(fixture.observations.snapshots, []);
  }
});
