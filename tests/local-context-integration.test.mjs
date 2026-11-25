import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

test('local pressure archives survive restart, approval resume and completion without refilling calls or exposing other users', async t => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-local-context-integration-'));
  const requests = [], measurements = [], preGenerationArchives = []; let child, base, logs = '';
  const modelId = 'qwen3-8b-zhiheng-integration';
  const model = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const reads = body.messages.filter(m => m.role === 'tool' && m.tool_call_id.startsWith('read-'));
    if (req.url === '/v1/tokenize') {
      // Deterministic pressure fixture, not a tokenizer accuracy/performance claim.
      const overflowing = reads.length >= 2 && !JSON.parse(reads[0].content).excerptsOmitted;
      const prompt_tokens = overflowing ? 4100 : 2000;
      measurements.push({ body, prompt_tokens });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: modelId, prompt_tokens, max_context: 4096, max_new_tokens: 512 })); return;
    }
    assert.equal(req.url, '/v1/chat/completions'); requests.push(body);
    if (body.messages.some(message => message.tool_call_id === 'read-0' && JSON.parse(message.content).excerptsOmitted)) {
      const persisted = JSON.parse(await fs.readFile(path.join(directory, 'store.json'), 'utf8'));
      preGenerationArchives.push(Object.values(persisted.tasks).find(task => task.status === 'running')?.checkpoint?.localContextArchives || []);
    }
    const observations = body.messages.filter(m => m.role === 'tool');
    let name, args, id;
    if (!observations.some(m => m.tool_call_id === 'search')) { name = 'search_knowledge'; args = { query: '归档压力测试证据' }; id = 'search'; }
    else if (reads.length < 2) { name = 'read_source'; args = { ref: 'S1' }; id = 'read-' + reads.length; }
    else if (!observations.some(m => m.tool_call_id === 'preferences')) { name = 'update_preferences'; args = { style: 'concise' }; id = 'preferences'; }
    const delta = name && body.tools?.length
      ? { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
      : { content: '已完成材料检查，已按批准更新回答风格。[[S1]]' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const article = { id: 1, title: '归档压力测试证据', abstract: '归档压力测试证据说明：旧摘录应保存，最近原文不应丢失。'.repeat(100),
    keywords: '归档_压力_测试_证据', discipline: '计算机科学', category: '工学' };
  await fs.writeFile(path.join(directory, 'papers.jsonl'), JSON.stringify(article) + '\n');
  const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: directory,
    STORE_FILE: path.join(directory, 'store.json'), KB_FILE: path.join(directory, 'kb.json'), VECTOR_FILE: path.join(directory, 'vector.json'), CORPUS_JSONL: path.join(directory, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '', EMBEDDING_PROVIDER: 'off', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false',
    LEARNING_ENABLED: 'false', TRAJECTORY_CAPTURE: 'false', LANGFUSE_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '0', MAX_TOOL_ROUNDS: '4',
    SUGGEST_MODE: 'rules', AUTH_SECRET: 'local-context-integration-fixture', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
    WEB_SEARCH_PROVIDER: '', WEB_SEARCH_KEY: '', SCHOLAR_SEARCH: 'false' };
  const stop = async () => {
    if (child && child.exitCode === null && !child.signalCode) { const ended = once(child, 'exit'); child.kill(); await ended; }
  };
  t.after(async () => {
    await stop(); model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    base = null;
    child = spawn(process.execPath, ['server.mjs'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-5000); });
    const deadline = Date.now() + 20000;
    while (!base) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Isolated server startup failed: ' + logs);
      try {
        const port = (await fs.readFile(path.join(directory, '.server-port'), 'utf8')).trim(), candidate = 'http://127.0.0.1:' + port;
        if ((await (await fetch(candidate + '/api/health')).json()).ready) base = candidate;
      } catch {}
      if (!base) await new Promise(resolve => setTimeout(resolve, 30));
    }
  };
  await start();
  const cookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const otherCookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const provider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: modelId, apiKey: '' };
  const post = (url, body, who = cookie) => fetch(base + url, { method: 'POST', headers: { cookie: who, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const store = async () => JSON.parse(await fs.readFile(path.join(directory, 'store.json'), 'utf8'));
  const question = '检索归档压力测试证据，读取材料，然后把回答风格更新为简洁。';
  const events = await readEvents(await post('/api/chat', { message: question, provider }));
  const approval = events.find(event => event.type === 'approval_required')?.approval;
  assert.ok(approval, JSON.stringify(events)); assert.equal(approval.action, 'update_preferences');
  const paused = (await store()).tasks[approval.taskId];
  assert.equal(paused.checkpoint.llmCalls.main, 4); assert.equal(requests.length, 4);
  const archives = paused.checkpoint.localContextArchives;
  assert.equal(archives.length, 1); assert.equal(archives[0].toolCallId, 'read-0');
  const original = requests[2].messages.find(message => message.tool_call_id === 'read-0');
  assert.equal(archives[0].original.content, original.content);
  assert.equal(archives[0].sha256, crypto.createHash('sha256').update(original.content).digest('hex'));
  assert.deepEqual(preGenerationArchives[0], archives, 'Original bytes are durable before the first request with projected context');
  const compacted = requests[3].messages.find(message => message.tool_call_id === 'read-0');
  assert.equal(JSON.parse(compacted.content).excerptsOmitted, true);
  assert.equal(JSON.parse(compacted.content).sources[0].excerpt, undefined);
  const latest = requests[3].messages.find(message => message.tool_call_id === 'read-1');
  assert.equal(JSON.parse(latest.content).sources[0].excerpt.length, 900);
  assert.equal(JSON.parse(archives[0].original.content).sources[0].excerpt.length, 900);
  assert.equal(paused.checkpoint.callSnapshots.length, 0, 'Archive must not depend on optional trajectory capture');
  assert.ok(measurements.some(row => row.prompt_tokens > 4096));
  assert.ok(measurements.some(row => row.prompt_tokens === 2000 && row.body.messages.some(message => message.content?.includes('"excerptsOmitted":true'))));
  assert.equal((await fetch(base + '/api/tasks/' + approval.taskId, { headers: { cookie: otherCookie } })).status, 404);

  await stop(); await start();
  assert.deepEqual((await store()).tasks[approval.taskId].checkpoint.localContextArchives, archives);
  assert.equal((await post('/api/approvals/' + approval.id + '/decide', { decision: 'approved' }, otherCookie)).status, 404);
  assert.equal((await post('/api/approvals/' + approval.id + '/decide', { decision: 'approved' })).status, 200);
  const beforeResume = requests.length;
  const resumed = await readEvents(await post('/api/tasks/' + approval.taskId + '/resume', { provider, approvalId: approval.id }));
  const done = resumed.find(event => event.type === 'done'); assert.ok(done, JSON.stringify(resumed));
  assert.equal(requests.length - beforeResume, 1);
  assert.equal(requests.at(-1).tools, undefined, 'The fifth reserved call is the finalization, not a refreshed tool budget');
  assert.deepEqual(done.llmCalls, { main: 5, aux: 0, sub: 0, judge: 0 });
  assert.ok(requests.at(-1).messages.some(message => message.tool_call_id === 'preferences' && message.content.includes('审批通过')));
  assert.equal(requests.at(-1).messages.find(message => message.tool_call_id === 'read-1').content, latest.content);
  assert.ok(requests.every(request => request.messages.some(message => message.role === 'user' && message.content === question)));
  const completedStore = await store(), completed = completedStore.tasks[approval.taskId];
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.checkpoint.localContextArchives, archives);
  assert.equal(completed.checkpoint.messages, undefined, 'Completed tasks retain only a read-only archive, not resumable messages');
  assert.deepEqual(completed.checkpoint.llmCalls, done.llmCalls);
  assert.equal(completedStore.approvals[approval.id].status, 'consumed');
  assert.equal(completedStore.preferences[completed.userId].style, 'concise');
  const ownerView = await (await fetch(base + '/api/tasks/' + approval.taskId, { headers: { cookie } })).json();
  assert.deepEqual(ownerView.task.checkpoint.localContextArchives, archives);
  assert.equal((await post('/api/tasks/' + approval.taskId + '/resume', { provider, approvalId: approval.id })).status, 409);
  assert.equal((await fetch(base + '/api/tasks/' + approval.taskId, { headers: { cookie: otherCookie } })).status, 404);
});
