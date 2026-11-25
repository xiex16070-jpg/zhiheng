import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-rewind-store-'));
process.env.DATA_DIR = directory; process.env.STORE_FILE = path.join(directory, 'store.json');
const { createStore, tryConversationRun } = await import('../src/server/store.mjs');
const { writeArtifact, readFile } = await import('../src/server/workspace.mjs');
const store = await createStore(false);
after(async () => { process.removeAllListeners('beforeExit'); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });

test('rewind is owner-bound, preserves selected message and files, invalidates old retry checkpoints', async () => {
  await store.ensureUser('alice'); await store.createConversation({ id: 'conversation', userId: 'alice', title: 'Research' });
  const turn = await store.startConversationTurn({ conversationId: 'conversation', userId: 'alice', message: 'Question one', taskId: 'taskone', checkpoint: { secretOldContext: 'do not replay' } });
  assert.equal(turn.ok, true);
  const userMessage = (await store.listMessages('conversation'))[0];
  assert.equal((await store.truncateMessages('conversation', userMessage.id, 'alice')).error, 'conversation_busy');
  await store.addMessage({ conversationId: 'conversation', role: 'assistant', content: 'answer', taskId: 'taskone' });
  await store.updateTask('taskone', { status: 'failed', checkpoint: { messages: [{ content: 'stale tool state' }] } });
  await writeArtifact('alice', 'keep.txt', Buffer.from('Keep workspace output'));
  assert.equal((await store.truncateMessages('conversation', userMessage.id, 'bob')).error, 'not_found');
  const release = tryConversationRun('conversation'); assert.ok(release);
  assert.equal((await store.truncateMessages('conversation', userMessage.id, 'alice')).error, 'conversation_busy'); release();
  const result = await store.truncateMessages('conversation', userMessage.id, 'alice'); assert.deepEqual(result, { ok: true, removed: 1 });
  assert.equal((await store.listMessages('conversation')).length, 1);
  assert.equal((await store.getConversation('conversation')).messageCount, 1);
  assert.equal(await store.claimTask('taskone', 'alice', ['failed']), false);
  await assert.rejects(() => store.addMessage({ conversationId: 'conversation', role: 'assistant', content: 'stale result', taskId: 'taskone' }), /conversation_rewound/);
  await store.updateTask('taskone', { status: 'running', checkpoint: null });
  assert.ok((await store.getTask('taskone')).checkpoint.rewoundAt);
  assert.equal((await readFile('alice', 'keep.txt')).content, 'Keep workspace output');
  const next = await store.startConversationTurn({ conversationId: 'conversation', userId: 'alice', message: 'Fresh question', taskId: 'tasktwo' }); assert.equal(next.ok, true);
  const duplicate = await store.startConversationTurn({ conversationId: 'conversation', userId: 'alice', message: 'Race', taskId: 'taskthree' }); assert.equal(duplicate.error, 'conversation_busy');
  assert.equal((await store.listMessages('conversation')).length, 2);
  const durable = JSON.parse(await fs.readFile(path.join(directory, 'store.json'), 'utf8'));
  assert.equal(durable.messages.conversation.length, 2); assert.ok(durable.tasks.taskone.checkpoint.rewoundAt);
});

test('concurrent rewind/claim cannot resurrect deleted context', async () => {
  for (let i = 0; i < 12; i++) {
    const conversationId = 'race' + i, taskId = 'taskrace' + i;
    await store.createConversation({ id: conversationId, userId: 'alice', title: 'Race' });
    await store.startConversationTurn({ conversationId, userId: 'alice', message: 'old', taskId });
    const id = (await store.listMessages(conversationId))[0].id;
    await store.addMessage({ conversationId, role: 'assistant', content: 'old result', taskId });
    await store.updateTask(taskId, { status: 'failed' });
    const calls = i % 2 ? [store.claimTask(taskId, 'alice', ['failed']), store.truncateMessages(conversationId, id, 'alice')] : [store.truncateMessages(conversationId, id, 'alice'), store.claimTask(taskId, 'alice', ['failed'])];
    const outcomes = await Promise.all(calls); const rewind = outcomes.find(x => typeof x === 'object'), claimed = outcomes.find(x => typeof x === 'boolean');
    assert.ok((rewind.ok && claimed === false) || (rewind.error === 'conversation_busy' && claimed === true), JSON.stringify(outcomes));
    if (rewind.ok) assert.equal((await store.listMessages(conversationId)).length, 1);
  }
});
