/** Exercise actual chat, streaming model, search tool, corpus and OTLP export using loopback only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const marker = 'PRIVATE_TRACE_FIXTURE_';
const subject = '循环不变式';

async function eventually(check, label) {
  const deadline = Date.now() + 15000;
  do {
    const result = await check();
    if (result) return result;
    await sleep(50);
  } while (Date.now() < deadline);
  assert.fail(label);
}

test('HTTP chat exports private, correlated traces across tool searches, upstream failures and approval resumes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiheng-trace-'));
  let endpoint, child;
  t.after(async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
    if (endpoint?.listening) {
      endpoint.closeAllConnections();
      await new Promise((resolve) => endpoint.close(resolve));
    }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const paper = { id: 1, title: subject + marker + 'TITLE', keywords: subject, discipline: '形式逻辑',
    category: '计算机科学', abstract: subject + '在每轮循环开始时成立。' + marker + 'SOURCE' };
  const corpus = path.join(dir, 'papers.jsonl');
  await fs.writeFile(corpus, JSON.stringify(paper) + '\n');
  const packets = [];
  const spans = () => packets.flatMap(({ body }) => JSON.parse(body).resourceSpans
    .flatMap((r) => r.scopeSpans.flatMap((scope) => scope.spans)));
  let modelSawToolResult = false;
  endpoint = http.createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString('utf8');
    if (req.url === '/api/public/otel/v1/traces') {
      packets.push({ method: req.method, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end();
    const { model, messages } = JSON.parse(body);
    if (model === marker + 'FAILED_MODEL') {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: marker + 'UPSTREAM_DETAIL' } }));
      return;
    }
    const result = messages.find((m) => m.role === 'tool');
    const tool = model === marker + 'APPROVAL' ? { name: 'web_fetch', arguments: JSON.stringify({ url: endpointUrl + '/' + marker + 'URL' }) }
      : { name: 'search_knowledge', arguments: JSON.stringify({ query: subject + ' ' + marker + 'ARG', source: 'paper' }) };
    const delta = result ? { content: marker + 'RESPONSE [[1]]' } : { tool_calls: [
      { index: 0, id: marker + 'CALL_ID', type: 'function', function: tool },
    ] };
    if (result) modelSawToolResult = result.content.includes(paper.title);
    const chunk = { choices: [{ index: 0, delta, finish_reason: result ? 'stop' : 'tool_calls' }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
  const endpointUrl = 'http://127.0.0.1:' + endpoint.address().port;
  child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true, stdio: 'ignore', env: {
    ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, CORPUS_JSONL: corpus,
    STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '',
    EMBEDDING_PROVIDER: 'local', EMBEDDING_BASE_URL: '', RERANK_ENABLED: 'false', LEARNING_ENABLED: 'false',
    AUTH_SECRET: 'isolated-otlp-test', ADMIN_TOKEN: marker + 'ADMIN', ADMIN_LOOPBACK: '0',
    INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '0', APPROVAL_TOOLS: 'web_fetch', WEB_FETCH_ENABLED: 'true',
    LANGFUSE_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: endpointUrl, LANGFUSE_PUBLIC_KEY: 'pk-test', LANGFUSE_SECRET_KEY: 'sk-test',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  const base = await eventually(async () => {
    assert.equal(child.exitCode, null, 'server exited during boot');
    const port = await fs.readFile(path.join(dir, '.server-port'), 'utf8').catch(() => '');
    if (!port.trim()) return;
    const url = 'http://127.0.0.1:' + port.trim();
    if ((await (await fetch(url + '/api/health')).json()).ready) return url;
  }, 'server readiness deadline');
  const bootstrap = await fetch(base + '/api/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const { user } = await bootstrap.json();
  const post = (route, body) => fetch(base + route, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify(body),
  });
  const provider = (model) => ({ baseUrl: endpointUrl + '/v1', model, apiKey: marker + 'MODEL_KEY' });
  const chat = async (model) => readEvents(await post('/api/chat', { mode:'knowledge',message: subject + '是什么？' + marker + 'QUESTION', provider: provider(model) }));
  const traceId = (events) => events.find((e) => e.type === 'task' && e.task.status === 'running')?.task.traceId;
  const events = await chat(marker + 'MODEL');
  const done = events.find((event) => event.type === 'done');
  assert.equal(done?.result?.citations[0]?.title, paper.title);
  assert.ok(modelSawToolResult, 'follow-up model call must receive the real search result');
  const failedEvents = await chat(marker + 'FAILED_MODEL');
  const failure = failedEvents.find((event) => event.type === 'error');
  assert.ok(failure?.message.includes(marker + 'UPSTREAM_DETAIL'));
  const pause = await chat(marker + 'APPROVAL');
  const { approval, taskId } = pause.find((e) => e.type === 'approval_required');
  assert.equal((await post('/api/approvals/' + approval.id + '/decide', { decision: 'rejected' })).status, 200);
  // This provider rejects the pending tool before any model call or timed workflow step.
  const resume = await readEvents(await post('/api/tasks/' + taskId + '/resume', { approvalId: approval.id, provider: provider('qwen3-8b-zhiheng') }));
  assert.match(resume.find((e) => e.type === 'error')?.message, /local_qwen_tool_disabled/);
  await eventually(() => spans().filter((s) => s.name === 'agent.task').length === 4, 'missing finished traces');
  for (const packet of packets) {
    assert.equal(packet.method, 'POST');
    assert.match(packet.headers['content-type'], /application\/json/);
    assert.equal(packet.headers.authorization, 'Basic ' + Buffer.from('pk-test:sk-test').toString('base64'));
    const conversation = events.find((event) => event.type === 'conversation');
    for (const privateValue of [marker, subject, cookie, user.id, conversation.conversationId, done.taskId, failure.taskId, taskId, approval.id]) {
      assert.ok(!JSON.stringify(packet).includes(privateValue), 'private data in OTLP request');
    }
  }
  const all = spans();
  const tasks = all.filter((s) => s.name === 'agent.task');
  assert.equal(new Set(tasks.map((s) => s.traceId)).size, 4);
  const success = tasks.find((s) => s.traceId === traceId(events));
  const failed = tasks.find((s) => s.traceId === traceId(failedEvents));
  assert.ok(success && success.status.code !== 2);
  assert.equal(failed?.status.code, 2, 'failed upstream must also mark its task failed');
  const paused = tasks.find((s) => s.traceId === traceId(pause));
  assert.ok(paused?.attributes.some((kv) => kv.key === 'langfuse.observation.metadata.outcome' && kv.value.stringValue === 'awaiting_approval'));
  assert.ok(tasks.some((s) => s.traceId === traceId(resume) && s.status.code === 2));
  assert.ok(!all.some((s) => [traceId(pause), traceId(resume)].includes(s.traceId) && s.name === 'tool.execute'));
  const { steps } = await (await fetch(base + '/api/tasks/' + taskId, { headers: { cookie } })).json();
  for (const [attempt, batch] of [[1, pause], [2, resume]]) {
    assert.ok(steps.some((s) => s.attempt === attempt && s.detail?.traceId === traceId(batch)), 'missing persisted trace for attempt ' + attempt);
  }
  const taskDetails = await (await fetch(base + '/api/tasks/' + done.taskId, { headers: { cookie } })).json();
  assert.ok(taskDetails.steps.some((step) => step.detail?.traceId === success.traceId));
  const metrics = async (headers) => (await (await fetch(base + '/api/metrics', { headers: { cookie, ...headers } })).json()).stack;
  assert.ok(!Object.hasOwn(await metrics({}), 'tracing'));
  const { tracing } = await metrics({ 'x-admin-token': marker + 'ADMIN' });
  assert.ok(tracing.exported > 0);
  for (const secret of [marker, 'pk-test', 'sk-test', endpointUrl]) assert.ok(!JSON.stringify(tracing).includes(secret));
  const children = (parent) => all.filter((s) => s.traceId === parent.traceId && s.parentSpanId === parent.spanId);
  assert.equal(children(success).filter((s) => s.name === 'model.call').length, 2);
  assert.ok(children(success).some((s) => s.name === 'retrieval.search'));
  const tool = children(success).find((s) => s.name === 'tool.execute');
  assert.ok(tool);
  assert.ok(children(tool).some((s) => s.name === 'retrieval.search'));
  assert.ok(children(failed).some((s) => s.name === 'model.call' && s.status.code === 2));
});
