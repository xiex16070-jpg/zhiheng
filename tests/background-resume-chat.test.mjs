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

test('HTTP background approval pause resumes through SSE and finishes its task-center record exactly once', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-background-resume-')); let child;
  const model = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); const request = JSON.parse(Buffer.concat(chunks));
    const waiting = request.tools && !request.messages.some(m => m.role === 'tool');
    const delta = waiting ? { tool_calls: [{ index: 0, id: 'ask_direction', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '选择研究方向', options: ['形式逻辑','机器学习'] }) } }] } : { content: request.tools ? '已完成后台研究报告。' : '[]' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: waiting ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve)); await fs.writeFile(path.join(directory, 'papers.jsonl'), '');
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: ['ignore','pipe','pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: directory, STORE_FILE: path.join(directory, 'store.json'),
    KB_FILE: path.join(directory, 'kb.json'), VECTOR_FILE: path.join(directory, 'vectors.json'), CORPUS_JSONL: path.join(directory, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '', EMBEDDING_PROVIDER: 'off', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false', LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '0', AUTH_SECRET: 'background-resume-contract', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  let logs = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { logs = (logs + value).slice(-5000); });
  t.after(async () => { if (child.exitCode === null && !child.signalCode) { const ended = once(child, 'exit'); child.kill(); await ended; } model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); await fs.rm(directory, { recursive: true, force: true }); });
  let base; const deadline = Date.now() + 20_000;
  while (!base) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error('Isolated server startup failed: ' + logs);
    try { const port = (await fs.readFile(path.join(directory, '.server-port'), 'utf8')).trim(); const url = 'http://127.0.0.1:' + port; if ((await (await fetch(url + '/api/health')).json()).ready) base = url; } catch {}
    if (!base) await new Promise(resolve => setTimeout(resolve, 30));
  }
  const cookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const get = async url => (await fetch(base + url, { headers: { cookie } })).json();
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'background-contract', apiKey: '' };
  const submitted = await post('/api/chat', { message: '请生成研究报告', provider, background: true }); assert.equal(submitted.status, 202); const job = await submitted.json();
  let paused;
  for (let i = 0; i < 150; i++) { paused = (await get('/api/background')).tasks.find(row => row.taskId === job.taskId); if (paused?.status === 'awaiting_approval') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(paused?.status, 'awaiting_approval');
  const approval = (await get('/api/approvals')).approvals.find(row => row.taskId === job.taskId); assert.equal(approval.action, 'ask_user');
  assert.ok((await post(`/api/approvals/${approval.id}/decide`, { decision: 'approved', answer: '形式逻辑' })).ok);
  const events = await readEvents(await post(`/api/tasks/${job.taskId}/resume`, { provider, approvalId: approval.id })); assert.ok(events.some(e => e.type === 'done'), JSON.stringify(events));
  const record = (await get('/api/background')).tasks.find(row => row.taskId === job.taskId); assert.equal(record.status, 'completed'); assert.match(record.summary, /后台研究报告/); assert.equal(record.llmCalls.main, 2);
  for (let i = 0; i < 2; i++) { const notifications = (await get('/api/background/notifications')).notifications.filter(n => n.taskId === job.taskId && n.status === 'completed'); assert.equal(notifications.length, 1); }
});
