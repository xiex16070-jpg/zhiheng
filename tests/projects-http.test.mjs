import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
test('真实 HTTP：项目会话绑定、跨项目发送拒绝、续接继承、重命名移除与用户隔离', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-project-http-'));
  const folders = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-project-http-folders-'));
  const projectA = path.join(folders, 'alpha'), projectB = path.join(folders, 'beta');
  await fs.mkdir(projectA); await fs.mkdir(projectB);
  await fs.writeFile(path.join(projectA, 'README.md'), '# retained');
  await fs.writeFile(path.join(dir, 'papers.jsonl'), '');
  process.env.DATA_DIR = dir;
  const { selectWorkspace } = await import('../src/server/workspace-selection.mjs');
  let modelCalls = 0;
  const model = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    modelCalls++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '已完成项目流程检查。' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const env = { ...process.env };
  try { for (const line of (await fs.readFile(path.join(ROOT, '.env'), 'utf8')).split(/\r?\n/)) {
    if (!line.trim().startsWith('#') && /^[A-Za-z_][A-Za-z0-9_]*=/.test(line.trim())) env[line.split('=')[0].trim()] = '';
  } } catch { /* optional */ }
  Object.assign(env, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vec.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'), MYSQL_ENABLED: '0', REDIS_ENABLED: '0', EMBEDDING_PROVIDER: 'off', LEARNING_ENABLED: '0', INFERENCE_AUDIT: '0', AUX_LLM_MAX_CALLS: '0', AUTH_SECRET: 'projects-contract-fixture', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1' });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-4000); });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) { const done = once(child, 'exit'); child.kill(); await done; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    for (const folder of [dir, folders]) { assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir())); await fs.rm(folder, { recursive: true, force: true }); }
  });
  let base = ''; const deadline = Date.now() + 20000;
  while (!base) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Server failed: ' + logs);
    try { const port = (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim(); if ((await (await fetch('http://127.0.0.1:' + port + '/api/health')).json()).ready) base = 'http://127.0.0.1:' + port; } catch { /* starting */ }
    if (!base) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const bootstrap = await fetch(base + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie').split(';')[0], uid = (await bootstrap.json()).user.id;
  const stranger = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'project-fixture', apiKey: '' };
  const post = (url, body, extra = {}) => fetch(base + url, { method: 'POST', headers: { cookie, origin: base, 'x-workspace-picker': '1', 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const get = (url, extra = {}) => fetch(base + url, { headers: { cookie, ...extra } });
  const a = (await selectWorkspace(uid, 'choose', { picker: async () => projectA })).workspace;
  const b = (await selectWorkspace(uid, 'choose', { picker: async () => projectB })).workspace;
  assert.equal((await post(`/api/projects/${a.id}/select`, {})).status, 200);
  const created = await post('/api/conversations', {}); assert.equal(created.status, 200);
  const conversation = (await created.json()).conversation;
  assert.equal(conversation.workspaceId, a.id);
  const events = await readEvents(await post('/api/chat', { message: '检查项目会话', conversationId: conversation.id, workspaceId: a.id, provider }));
  assert.ok(events.some(e => e.type === 'done'), JSON.stringify(events));
  const previous = modelCalls;
  assert.equal((await post(`/api/projects/${b.id}/select`, {})).status, 200);
  const previewUrl = `/api/workspace/preview?workspace=${a.id}&path=README.md`;
  const preview = await get(previewUrl); assert.equal(preview.status, 200);
  const rendered = await preview.json(); assert.equal(rendered.workspaceId, a.id); assert.match(rendered.html, /retained/);
  assert.equal((await get(previewUrl, { cookie: stranger })).status, 404);
  assert.equal((await get(previewUrl, { 'x-forwarded-for': '203.0.113.3' })).status, 403);
  assert.equal((await get('/preview.html')).status, 200);
  const stale = await post('/api/chat', { message: '不得写到新项目', conversationId: conversation.id, workspaceId: a.id, provider });
  assert.equal(stale.status, 409);
  const mismatch = await post('/api/chat', { message: '会话仍属于甲', conversationId: conversation.id, workspaceId: b.id, provider });
  assert.equal(mismatch.status, 409);
  assert.equal(modelCalls, previous, '项目不匹配时不发模型请求');
  const carry = await post(`/api/conversations/${conversation.id}/new-context`, {}); assert.equal(carry.status, 201);
  assert.equal((await carry.json()).conversation.workspaceId, a.id);
  const list = await (await get('/api/projects')).json();
  assert.equal(list.activeId, b.id);
  assert.equal(list.projects.find(p => p.id === a.id).conversationCount, 2);
  assert.ok((await (await get('/api/conversations')).json()).conversations.every(c => c.workspaceId === a.id));
  assert.equal((await post(`/api/projects/${a.id}/rename`, { name: '算法实验室' })).status, 200);
  assert.equal((await post(`/api/projects/${a.id}/select`, {}, { cookie: stranger })).status, 404);
  assert.equal((await post(`/api/projects/${a.id}/select`, {}, { origin: 'http://untrusted.invalid' })).status, 403);
  assert.equal((await post(`/api/projects/${a.id}/remove`, {})).status, 200);
  const removed = await (await get('/api/projects')).json();
  assert.equal(removed.projects.find(p => p.id === a.id).removed, true);
  assert.equal(removed.conversations.length, 2);
  assert.equal((await get(previewUrl)).status, 404, '移除注册后不能继续读取原项目');
  assert.equal(await fs.readFile(path.join(projectA, 'README.md'), 'utf8'), '# retained');
});
