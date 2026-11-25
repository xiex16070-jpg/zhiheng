import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBackgroundTasks } from '../src/server/background-tasks.mjs';

test('background jobs persist bounded owner-isolated output and notifications, not credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-bg-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = createBackgroundTasks({ directory, run: async ({ input, emit }) => { assert.equal(input.apiKey, 'SECRET'); for (let i = 0; i < 300; i++) emit({ type: 'delta', delta: 'x'.repeat(500) }); return { text: 'done', llmCalls: { main: 2, sub: 3 } }; } }); t.after(() => manager.close());
  await manager.start({ userId: 'alice', taskId: 'task1', input: { apiKey: 'SECRET' } }); const record = await manager.wait('alice', 'task1');
  assert.equal(record.status, 'completed'); assert.ok(record.events.length <= 200); assert.ok(JSON.stringify(record.events).length <= 48000); assert.equal(record.llmCalls.sub, 3);
  assert.equal(await manager.get('bob', 'task1'), null); assert.equal((await manager.cancel('bob', 'task1')).ok, false);
  const notices = await manager.notifications('alice', { consume: true }); assert.equal(notices.length, 1); assert.match(notices[0].text, /NOT be treated as approval/); assert.equal((await manager.notifications('alice')).length, 0);
  assert.ok(!(await fs.readFile(path.join(directory, 'alice', 'task1.json'), 'utf8')).includes('SECRET'));
});
test('background cancellation, approval pause and restart recovery are explicit', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-bg-state-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = createBackgroundTasks({ directory, run: async ({ input, signal }) => input === 'pause' ? { paused: true } : new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) }); t.after(() => manager.close());
  await manager.start({ userId: 'alice', taskId: 'paused', input: 'pause' }); assert.equal((await manager.wait('alice', 'paused')).status, 'awaiting_approval');
  await manager.start({ userId: 'alice', taskId: 'cancelled', input: 'wait' }); await manager.cancel('alice', 'cancelled'); assert.equal((await manager.wait('alice', 'cancelled')).status, 'cancelled');
  await fs.writeFile(path.join(directory, 'alice', 'crashed.json'), JSON.stringify({ userId: 'alice', taskId: 'crashed', status: 'running', createdAt: new Date().toISOString(), events: [] }));
  assert.equal((await manager.recover()).interrupted, 1); assert.equal((await manager.get('alice', 'crashed')).status, 'interrupted'); assert.equal((await manager.get('alice', 'paused')).status, 'awaiting_approval');
});
test('concurrent duplicate submissions cannot overwrite one task', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-bg-race-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = createBackgroundTasks({ directory, run: async () => ({ text: 'done' }) }); t.after(() => manager.close());
  const result = await Promise.allSettled([manager.start({ userId: 'a', taskId: 'same' }), manager.start({ userId: 'a', taskId: 'same' })]); assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  await manager.wait('a', 'same');
});
test('paused background task resumed by foreground flow updates list, counts and exactly one final notification', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-bg-resume-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = createBackgroundTasks({ directory, run: async () => ({ paused: true }) }); t.after(() => manager.close());
  await manager.start({ userId: 'alice', taskId: 'resumed' }); await manager.wait('alice', 'resumed');
  assert.equal((await manager.list('alice'))[0].status, 'awaiting_approval'); await manager.notifications('alice', { consume: true });
  const finished = { id: 'resumed', userId: 'alice', status: 'completed', updatedAt: '2026-11-05T12:00:00.000Z', result: { body: '人工审批恢复后的结果', llmCalls: { main: 3, aux: 1, sub: 2 } } };
  await Promise.all([manager.updateFromTask(finished), manager.updateFromTask(finished)]);
  const record = (await manager.list('alice'))[0]; assert.equal(record.status, 'completed'); assert.equal(record.summary, finished.result.body); assert.equal(record.llmCalls.sub, 2);
  const notices = await manager.notifications('alice'); assert.equal(notices.length, 1); assert.equal(notices[0].status, 'completed');
  assert.equal((await manager.updateFromTask({ ...finished, userId: 'bob' })).synced, false);
  assert.equal((await manager.updateFromTask({ ...finished, status: 'awaiting_approval', updatedAt: '2026-11-05T11:00:00.000Z' })).reason, 'stale');
  assert.equal((await manager.get('alice', 'resumed')).status, 'completed');
});
test('foreground synchronization never overwrites a live background runner', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-bg-live-sync-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let finish; const manager = createBackgroundTasks({ directory, run: async () => new Promise(resolve => { finish = resolve; }) }); t.after(() => manager.close());
  await manager.start({ userId: 'alice', taskId: 'live' });
  assert.equal((await manager.updateFromTask({ id: 'live', userId: 'alice', status: 'completed' })).reason, 'running');
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1)); finish({ text: 'runner result' });
  assert.equal((await manager.wait('alice', 'live')).summary, 'runner result');
});
