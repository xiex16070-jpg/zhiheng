import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

test('legacy artifacts recover their historical project across messages and task reconciliation', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-legacy-artifacts-'));
  const folders = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-legacy-projects-'));
  const userId = 'legacy-owner', strangerId = 'legacy-stranger';
  process.env.DATA_DIR = data; process.env.AUTH_SECRET = 'legacy-artifact-fixture';
  const { selectWorkspace } = await import('../src/server/workspace-selection.mjs');
  const { signIdentity } = await import('../src/server/auth.mjs');
  const projects = [];
  for (const name of ['alpha', 'beta']) {
    const folder = path.join(folders, name); await fs.mkdir(folder);
    await fs.writeFile(path.join(folder, 'result.md'), '# Historical ' + name);
    projects.push((await selectWorkspace(userId, 'choose', { picker: async () => folder })).workspace);
  }
  const [a, b] = projects, now = new Date().toISOString();
  const conversation = (id, owner, workspace) => ({ id, userId: owner, title: id, messageCount: 4, createdAt: now, updatedAt: now, ...(workspace ? { workspaceId: workspace } : {}) });
  const task = (id, conv, owner, workspace, createdAt = now) => ({ id, conversationId: conv, userId: owner, question: id,
    status: 'completed', checkpoint: workspace ? { workspaceId: workspace } : {},
    result: { body: 'Legacy result', artifacts: [{ kind: 'text', path: 'result.md', bytes: 20 }] }, createdAt, updatedAt: createdAt });
  const oldA = task('task-old-a', 'legacy-conversation', userId, a.id, '2026-01-01T00:00:00.000Z');
  oldA.result.artifacts.push({ kind: 'text', path: 'already-scoped.md', workspaceId: 'default', bytes: 1 });
  const latestB = task('task-latest-b', 'legacy-conversation', userId, b.id);
  const fallback = task('task-fallback-a', 'fallback-conversation', userId);
  const foreign = task('foreign-task', 'legacy-conversation', strangerId, b.id);
  const wrongConversation = task('wrong-conversation-task', 'stranger-conversation', userId);
  const legacy = { conversations: {
    'legacy-conversation': conversation('legacy-conversation', userId),
    'fallback-conversation': conversation('fallback-conversation', userId, a.id),
    'stranger-conversation': conversation('stranger-conversation', strangerId, a.id),
  }, tasks: Object.fromEntries([oldA, latestB, fallback, foreign, wrongConversation].map(item => [item.id, item])),
    messages: {
      'legacy-conversation': [oldA, latestB, foreign].map((item, index) => ({ id: index + 1, role: 'assistant', content: item.id, taskId: item.id, createdAt: item.createdAt })),
      'fallback-conversation': [{ id: 4, role: 'assistant', content: fallback.id, taskId: fallback.id, createdAt: now }],
    } };
  const storePath = path.join(data, 'store.json');
  await fs.writeFile(storePath, JSON.stringify(legacy)); await fs.writeFile(path.join(data, 'papers.jsonl'), '');
  const env = { ...process.env };
  try { for (const line of (await fs.readFile(path.join(root, '.env'), 'utf8')).split(/\r?\n/)) {
    if (!line.trim().startsWith('#') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(line.trim())) env[line.split('=')[0].trim()] = '';
  } } catch { /* optional local environment */ }
  Object.assign(env, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: data, STORE_FILE: storePath, KB_FILE: path.join(data, 'kb.json'), VECTOR_FILE: path.join(data, 'vector.json'), CORPUS_JSONL: path.join(data, 'papers.jsonl'), MYSQL_ENABLED: '0', REDIS_ENABLED: '0', EMBEDDING_PROVIDER: 'off', LEARNING_ENABLED: '0', INFERENCE_AUDIT: '0', AUX_LLM_MAX_CALLS: '0', AUTH_SECRET: 'legacy-artifact-fixture', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1' });
  const server = spawn(process.execPath, ['server.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  t.after(async () => {
    if (server.exitCode === null && !server.signalCode) { const stopped = once(server, 'exit'); server.kill(); await stopped; }
    for (const directory of [data, folders]) { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); }
  });
  let base; const deadline = Date.now() + 20000;
  while (!base) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error('Server failed: ' + logs);
    try { const port = (await fs.readFile(path.join(data, '.server-port'), 'utf8')).trim(); if ((await (await fetch('http://127.0.0.1:' + port + '/api/health')).json()).ready) base = 'http://127.0.0.1:' + port; } catch { /* starting */ }
    if (!base) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const get = (url, owner = userId) => fetch(base + url, { headers: { cookie: 'uid=' + signIdentity(owner) } });
  const json = async url => { const response = await get(url); assert.equal(response.status, 200); return response.json(); };

  await t.test('message history uses original task before migrated conversation, preserving explicit artifact IDs', async () => {
    const state = await json('/api/projects'); assert.equal(state.activeId, b.id);
    assert.equal(state.conversations.find(item => item.id === 'legacy-conversation').workspaceId, b.id);
    const history = await json('/api/conversations/legacy-conversation/messages');
    const first = history.messages.find(item => item.taskId === oldA.id).result.artifacts;
    assert.equal(first[0].workspaceId, a.id); assert.equal(first[1].workspaceId, 'default');
    assert.equal(history.messages.find(item => item.taskId === latestB.id).result.artifacts[0].workspaceId, b.id);
    assert.equal(history.messages.find(item => item.taskId === foreign.id).result, undefined);
    const preview = await json('/api/workspace/preview?' + new URLSearchParams({ path: first[0].path, workspace: first[0].workspaceId }));
    assert.match(preview.html, /Historical alpha/); assert.equal(preview.workspaceId, a.id);
    const fallbackHistory = await json('/api/conversations/fallback-conversation/messages');
    assert.equal(fallbackHistory.messages[0].result.artifacts[0].workspaceId, a.id);
  });
  await t.test('task detail/reconcile and task listing recover the same historical workspace', async () => {
    assert.equal((await json('/api/tasks/' + oldA.id)).task.result.artifacts[0].workspaceId, a.id);
    assert.equal((await json('/api/tasks/' + fallback.id)).task.result.artifacts[0].workspaceId, a.id);
    const listing = await json('/api/tasks');
    assert.equal(listing.tasks.find(item => item.id === oldA.id).result.artifacts[0].workspaceId, a.id);
    assert.equal(listing.tasks.find(item => item.id === fallback.id).result.artifacts[0].workspaceId, a.id);
    assert.ok(!listing.tasks.some(item => item.id === foreign.id));
  });
  await t.test('foreign ownership never supplies the fallback and responses do not mutate stored artifacts', async () => {
    assert.equal((await get('/api/tasks/' + oldA.id, strangerId)).status, 404);
    assert.equal((await json('/api/tasks/' + wrongConversation.id)).task.result.artifacts[0].workspaceId, 'default');
    // A preference write persists the in-memory store, exposing accidental response mutation.
    const response = await fetch(base + '/api/preferences', { method: 'POST', headers: { cookie: 'uid=' + signIdentity(userId), 'content-type': 'application/json' }, body: JSON.stringify({ preferences: { style: 'balanced' } }) });
    assert.equal(response.status, 200);
    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
    assert.equal(persisted.tasks[oldA.id].result.artifacts[0].workspaceId, undefined);
    assert.equal(persisted.tasks[fallback.id].result.artifacts[0].workspaceId, undefined);
    assert.equal((await json('/api/projects')).activeId, b.id);
  });
});
