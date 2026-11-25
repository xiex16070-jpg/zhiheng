import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-task-cleanup-'));
process.env.DATA_DIR = directory; process.env.STORE_FILE = path.join(directory, 'store.json');
process.env.MYSQL_ENABLED = 'false'; process.env.REDIS_ENABLED = 'false'; process.env.EXEC_ENABLED = '1'; process.env.EXEC_SESSIONS = '1'; process.env.LEARNING_ENABLED = 'false';
const { createStore } = await import('../src/server/store.mjs');
const { runTask, failTask } = await import('../src/server/orchestrator.mjs');
const { execSessions } = await import('../src/server/exec-session.mjs');
const { workspaceRoot } = await import('../src/server/workspace.mjs');
const store = await createStore(false);
test.after(async () => { execSessions.closeAll(); store.flushSync(); store.flushSync = () => {}; clearTimeout(store.timer); await fs.rm(directory, { recursive: true, force: true }); });

test('task wrapper and failTask both kill active sessions even when status persistence fails', async () => {
  const update = store.updateTask;
  for (const [taskId, action] of [['wrapper', runTask], ['failure', failTask]]) {
    await store.createTask({ id: taskId, conversationId: 'conversation', userId: 'alice', question: 'cleanup test' });
    await fs.mkdir(workspaceRoot('alice'), { recursive: true });
    const ctx = { userId: 'alice', taskId, approved: true };
    const started = await execSessions.start({ command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] }, ctx); assert.equal(started.ok, true);
    store.updateTask = async () => { throw new Error('storage unavailable'); };
    try { await assert.rejects(action({ taskId, provider: {}, error: new Error('original failure') }), /storage unavailable/); }
    finally { store.updateTask = update; }
    let stopped = false;
    for (let i = 0; i < 100; i++) { const result = await execSessions.poll({ session_id: started.sessionId }, ctx); if (result.status === 'exited' || result.status === 'failed') { stopped = true; break; } await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.equal(stopped, true, taskId + ' must terminate the process tree');
  }
});
