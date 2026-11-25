import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

test('HTTP rewind refuses concurrent foreground/background turns and old retry, then keeps chosen boundary', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-rewind-http-'));
  const pending = []; let modelCalls = 0;
  const model = http.createServer(async (req, res) => {
    for await (const ignored of req) { void ignored; }
    modelCalls++;
    const finish = () => { if (res.destroyed) return; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '这是本地回归测试回答。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); };
    pending.push(finish);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); await fs.writeFile(path.join(dir, 'papers.jsonl'), '');
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '', EMBEDDING_PROVIDER: 'off', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false', LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '0', AUTH_SECRET: 'isolated-rewind-test', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-5000); });
  t.after(async () => { for (const finish of pending.splice(0)) finish(); if (child.exitCode === null && !child.signalCode) { const stopped = once(child, 'exit'); child.kill(); await stopped; } model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }); });
  async function until(fn, label) { const deadline = Date.now() + 15000; while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 15)); } throw new Error(label + ': ' + logs); }
  const base = await until(async () => { try { const port = (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim(); const url = 'http://127.0.0.1:' + port; return (await (await fetch(url + '/api/health')).json()).ready ? url : null; } catch { return null; } }, 'boot');
  const cookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = async url => (await fetch(base + url, { headers: { cookie } })).json();
  const conversationId = (await (await post('/api/conversations', {})).json()).conversation.id;
  const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'rewind-fixture', apiKey: '' };
  const firstResponse = await post('/api/chat', { message: '先帮我梳理形式逻辑', conversationId, provider });
  const firstEvents = readEvents(firstResponse);
  await until(() => pending.length > 0, 'foreground model request');
  const firstHistory = await get('/api/conversations/' + conversationId + '/messages');
  const messageId = firstHistory.messages[0].id;
  assert.equal((await post('/api/conversations/' + conversationId + '/rewind', { messageId })).status, 409);
  assert.equal((await post('/api/chat', { message: '不要并发写入', conversationId, provider })).status, 409);
  pending.shift()(); const events = await firstEvents; assert.ok(events.some(e => e.type === 'done'), JSON.stringify(events));
  const taskId = events.find(e => e.type === 'conversation').taskId;
  const rewind = await post('/api/conversations/' + conversationId + '/rewind', { messageId }); assert.equal(rewind.status, 200, await rewind.clone().text());
  assert.equal((await get('/api/conversations/' + conversationId + '/messages')).messages.length, 1);
  const retry = await post('/api/tasks/' + taskId + '/resume', { provider }); assert.equal(retry.status, 409); assert.equal((await retry.json()).error, 'conversation_rewound');
  const background = await post('/api/chat', { message: '后台研究形式验证', conversationId, provider, background: true }); assert.equal(background.status, 202, await background.clone().text());
  await until(() => pending.length > 0, 'background model request');
  assert.equal((await post('/api/conversations/' + conversationId + '/rewind', { messageId })).status, 409);
  pending.shift()();
  await until(async () => (await get('/api/conversations/' + conversationId + '/messages')).messages.length === 3, 'background final message');
  await until(async () => (await post('/api/conversations/' + conversationId + '/rewind', { messageId })).status === 200, 'background rewind');
  assert.equal((await get('/api/conversations/' + conversationId + '/messages')).messages.length, 1);
  assert.equal(modelCalls, 2);
});
