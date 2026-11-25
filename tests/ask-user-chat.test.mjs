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

test('ask_user persists answers, binds ownership, resumes and enforces a two-question budget', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-tool-arguments-'));
  let seen = [];
  const model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen = body.messages;
    let delta, finish = 'stop';
    const replies = body.messages.filter(message => message.role === 'tool');
    if (body.tools && replies.length < 3) {
      delta = { tool_calls: [{ index: 0, id: 'question' + replies.length, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '报告侧重哪个方向？', options: ['形式逻辑', '机器学习'], recommended: 0 }) } }] };
      finish = 'tool_calls';
    } else delta = { content: body.tools ? '已收到偏好，将据此继续。' : '[]' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(dir, 'papers.jsonl'), '');
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'),
    KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '', EMBEDDING_PROVIDER: 'off',
    RERANK_ENABLED: 'false', MINERU_ENABLED: 'false', LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false',
    AUX_LLM_MAX_CALLS: '0', AUTH_SECRET: 'isolated-tool-argument-test', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-5000); });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  let base;
  const deadline = Date.now() + 20000;
  while (!base) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Server did not start: ' + logs);
    try {
      const port = (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim();
      if ((await (await fetch('http://127.0.0.1:' + port + '/api/health')).json()).ready) base = 'http://127.0.0.1:' + port;
    } catch { /* Wait until the isolated listener is ready. */ }
    if (!base) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const cookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'clarification-contract', apiKey: '' };
  const first = await readEvents(await post('/api/chat', { message: '请为我做研究报告', provider }));
  const approval = first.find(e => e.type === 'approval_required')?.approval;
  assert.equal(approval?.action, 'ask_user', JSON.stringify(first));
  const stranger = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const other = await fetch(base + '/api/approvals/' + approval.id + '/decide', { method: 'POST', headers: { cookie: stranger, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approved', answer: '伪造回答' }) });
  assert.equal(other.status, 404);
  assert.equal((await post('/api/approvals/' + approval.id + '/decide', { decision: 'approved', answer: '' })).status, 400);
  assert.ok((await post('/api/approvals/' + approval.id + '/decide', { decision: 'approved', answer: '形式逻辑' })).ok);
  const persisted = JSON.parse(await fs.readFile(path.join(dir, 'store.json'), 'utf8'));
  assert.equal(persisted.approvals[approval.id].answer, '形式逻辑');
  const second = await readEvents(await post('/api/tasks/' + approval.taskId + '/resume', { provider, approvalId: approval.id }));
  const next = second.find(e => e.type === 'approval_required')?.approval;
  assert.ok(next, JSON.stringify(second));
  assert.ok(seen.some(m => m.role === 'tool' && m.content.includes('形式逻辑')));
  assert.ok((await post('/api/approvals/' + next.id + '/decide', { decision: 'rejected' })).ok);
  const last = await readEvents(await post('/api/tasks/' + next.taskId + '/resume', { provider, approvalId: next.id }));
  assert.ok(last.some(e => e.type === 'done'), JSON.stringify(last));
  assert.ok(!last.some(e => e.type === 'approval_required'));
  assert.ok(seen.some(m => m.role === 'tool' && m.content.includes('已提问两次')));
});
