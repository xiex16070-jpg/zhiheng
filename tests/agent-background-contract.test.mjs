import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('background rejections remain failed tool results instead of successful launches/cancellations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-background-contract-'));
  process.env.DATA_DIR = directory;
  process.env.STORE_FILE = path.join(directory, 'store.json');
  process.env.MYSQL_ENABLED = '0'; process.env.REDIS_ENABLED = '0';
  const { createStore } = await import('../src/server/store.mjs');
  const { configureAgentBackground, executeBackgroundTool } = await import('../src/server/agent-background.mjs');
  const store = await createStore(false), userId = 'background-owner', taskId = 'background-parent';
  await store.createTask({ id: taskId, userId, conversationId: 'background-conversation', question: 'independent test', checkpoint: { workspaceId: 'default' } });
  let starts = 0, reservations = 0;
  configureAgentBackground({
    start: async () => { starts++; throw new Error('must not start rejected task'); },
    get: async (_owner, id) => id === 'completed-child' ? { taskId: id, status: 'completed', summary: 'Completed', metadata: { workspaceId: 'default' } } : null,
    cancel: async () => ({ ok: false, reason: 'Task is no longer running' }),
  });
  t.after(async () => {
    configureAgentBackground(null);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const context = { userId, taskId, workspaceId: 'default', delegationProvider: {}, reserveBackground: async () => { reservations++; } };
  const forbidden = await executeBackgroundTool('start_background_task', { goal: 'nested task' }, { ...context, backgroundDepth: 1 });
  assert.equal(forbidden.isError, true); assert.equal(JSON.parse(forbidden.text).error, 'background_depth');
  const exhausted = await executeBackgroundTool('start_background_task', { goal: 'third child' }, { ...context, backgroundCount: 2 });
  assert.equal(exhausted.isError, true); assert.equal(JSON.parse(exhausted.text).error, 'background_budget');
  const scoped = await executeBackgroundTool('start_background_task', { goal: 'single document' }, { ...context, focusDocId: 'doc' });
  assert.equal(scoped.isError, true); assert.equal(JSON.parse(scoped.text).error, 'background_document_scope');
  const absent = await executeBackgroundTool('get_background_task', { task_id: 'missing-child' }, context);
  assert.equal(absent.isError, true); assert.equal(JSON.parse(absent.text).error, 'task_not_found');
  const cancelled = await executeBackgroundTool('cancel_background_task', { task_id: 'completed-child' }, context);
  assert.equal(cancelled.isError, true); assert.match(cancelled.summary, /no longer running/);
  const completed = await executeBackgroundTool('get_background_task', { task_id: 'completed-child' }, context);
  assert.equal(completed.isError, false); assert.equal(JSON.parse(completed.text).status, 'completed');
  assert.equal(starts, 0); assert.equal(reservations, 0);
});
