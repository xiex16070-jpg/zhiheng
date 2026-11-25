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

test('Task-wide model budget survives approvals and failed requests, with one bounded finalization', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-resume-budget-'));
  const requests = [];
  const model = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    if (JSON.stringify(body.messages).includes('FAIL_REQUEST') && body.tools?.length) {
      res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":{"message":"fixture failure"}}'); return;
    }
    const replies = body.messages.filter(m => m.role === 'tool');
    const delta = body.tools?.length ? { tool_calls: [{ index: 0, id: 'question' + replies.length, type: 'function',
      function: { name: 'ask_user', arguments: JSON.stringify({ question: '选择研究方向', options: ['逻辑', '验证'] }) } }] } : { content: '已用现有信息完成总结。' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(directory, 'papers.jsonl'), '');
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: directory,
    STORE_FILE: path.join(directory, 'store.json'), KB_FILE: path.join(directory, 'kb.json'), VECTOR_FILE: path.join(directory, 'vector.json'), CORPUS_JSONL: path.join(directory, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '', EMBEDDING_PROVIDER: 'off', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false',
    LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '3', MAX_TOOL_ROUNDS: '2', SUGGEST_MODE: 'rules', AUTH_SECRET: 'resume-budget-fixture',
    HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1', WEB_SEARCH_PROVIDER: '', WEB_SEARCH_KEY: '', SCHOLAR_SEARCH: 'false' };
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-5000); });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) { const ended = once(child, 'exit'); child.kill(); await ended; }
    model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true });
  });
  let base; const deadline = Date.now() + 20000;
  while (!base) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Server startup failed: ' + logs);
    try { const port = (await fs.readFile(path.join(directory, '.server-port'), 'utf8')).trim();
      if ((await (await fetch('http://127.0.0.1:' + port + '/api/health')).json()).ready) base = 'http://127.0.0.1:' + port;
    } catch {} if (!base) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const cookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'resume-budget-fixture', apiKey: '' };
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const resume = async (id, approvalId) => readEvents(await post('/api/tasks/' + id + '/resume', { provider, ...(approvalId ? { approvalId } : {}) }));
  const store = async () => JSON.parse(await fs.readFile(path.join(directory, 'store.json'), 'utf8'));
  let events = await readEvents(await post('/api/chat', { message: 'BUDGET_APPROVAL 请核实研究方向', provider }));
  const first = events.find(e => e.type === 'approval_required')?.approval; assert.ok(first, JSON.stringify(events));
  await post('/api/approvals/' + first.id + '/decide', { decision: 'approved', answer: '逻辑' });
  events = await resume(first.taskId, first.id);
  const second = events.find(e => e.type === 'approval_required')?.approval; assert.ok(second, JSON.stringify(events));
  assert.equal((await store()).tasks[first.taskId].checkpoint.llmCalls.main, 2);
  await post('/api/approvals/' + second.id + '/decide', { decision: 'approved', answer: '验证' });
  const before = requests.length; events = await resume(first.taskId, second.id);
  const done = events.find(e => e.type === 'done'); assert.ok(done, JSON.stringify(events));
  assert.equal(requests.length - before, 1); assert.equal(requests.at(-1).tools, undefined);
  assert.deepEqual(done.llmCalls, { main: 3, aux: 0, sub: 0, judge: 0 });
  assert.equal(requests.at(-1).messages.filter(m => m.role === 'tool').length, 2);
  assert.equal((await post('/api/tasks/' + first.taskId + '/resume', { provider, approvalId: second.id })).status, 409);

  events = await readEvents(await post('/api/chat', { message: 'FAIL_REQUEST accounting fixture', provider }));
  const taskId = events.find(e => e.type === 'task')?.task.id; assert.ok(taskId);
  assert.equal(events.find(e => e.type === 'error')?.llmCalls.main, 1);
  assert.equal((await store()).tasks[taskId].checkpoint.llmCalls.main, 1);
  events = await resume(taskId);
  assert.equal(events.find(e => e.type === 'error')?.llmCalls.main, 2);
  assert.equal((await store()).tasks[taskId].checkpoint.llmCalls.main, 2);
  const spent = requests.length; events = await resume(taskId);
  assert.equal(requests.length - spent, 1, 'The reserved last round is a no-tool finalization, even across failed requests');
  assert.equal(requests.at(-1).tools, undefined);
  assert.deepEqual(events.find(e => e.type === 'done')?.llmCalls, { main: 3, aux: 0, sub: 0, judge: 0 });
  assert.equal((await post('/api/tasks/'+taskId+'/resume',{provider})).status,409);
});
