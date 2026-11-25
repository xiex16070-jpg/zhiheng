/** Real HTTP/SSE contract for proof delivery; scripted model, not a quality benchmark. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Agent真实HTTP：logic_result SSE、最终证明、引用边界与持久化一致', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'csl-logic-chat-'));
  let child, model;
  t.after(async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
    if (model) {
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    }
    const target = path.resolve(temp);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(target, { recursive: true, force: true });
  });
  const paper = { id: 1, title: '程序甲证明与适用规则', abstract: '程序甲已有证明。已证明的对象在此规则系统中可用。',
    discipline: '形式逻辑', category: '演绎推理', keywords: '程序甲 证明 可用',
    sourceUrl: 'https://example.test/formal', sourceTitle: '测试来源', language: 'zh', license: 'CC0', recordType: 'fulltext_section' };
  await fs.writeFile(path.join(temp, 'papers.jsonl'), JSON.stringify(paper) + '\n');
  const program = '事实 已证明(程序甲) 依据 "1"。\n规则 可靠：若 已证明(?对象) 则 可用(?对象) 依据 "1"。\n查询 可用(程序甲)。';
  let seenTool = null;
  model = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    seenTool = body.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'logic-call');
    if (!seenTool) {
      send({ tool_calls: [
        { index: 0, id: 'read-call', type: 'function', function: { name: 'read_source', arguments: '{"ref":"1"}' } },
        { index: 1, id: 'logic-call', type: 'function', function: { name: 'logic_evaluate', arguments: JSON.stringify({ program, bindings: [
          { line: 1, ref: '1', quote: '程序甲已有证明。' },
          { line: 2, ref: '1', quote: '已证明的对象在此规则系统中可用。' },
        ] }) } },
      ] }, 'tool_calls');
    } else send({ content: '给定这些事实和规则，可以推出程序甲可用；原文到谓词的转写仍需核对。[[1]]' }, 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: temp, CORPUS_PROFILE: 'custom',
    CORPUS_JSONL: path.join(temp, 'papers.jsonl'), STORE_FILE: path.join(temp, 'store.json'),
    KB_FILE: path.join(temp, 'kb.json'), VECTOR_FILE: path.join(temp, 'vectors.json'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', EMBEDDING_PROVIDER: 'local',
    EMBEDDING_BASE_URL: '', EMBEDDING_DIM: '512', RAGFLOW_BASE_URL: '',
    AUTH_SECRET: 'isolated-logic-chat-contract', LEARNING_ENABLED: 'false', EXEC_ENABLED: 'false',
    WEB_FETCH_ENABLED: 'false', WEB_SEARCH_PROVIDER: '', INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '0',
    RERANK_ENABLED: 'false', MINERU_ENABLED: 'false', MCP_SDK_ENABLED: 'false',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  let logs = '';
  child.stdout.on('data', (data) => { logs = (logs + data).slice(-5000); });
  child.stderr.on('data', (data) => { logs = (logs + data).slice(-5000); });
  let baseUrl;
  const deadline = Date.now() + 20000;
  while (true) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Logic server startup failed: ${logs}`);
    try {
      const port = Number((await fs.readFile(path.join(temp, '.server-port'), 'utf8')).trim());
      if (port > 0) {
        baseUrl = `http://127.0.0.1:${port}`;
        if ((await (await fetch(baseUrl + '/api/health')).json()).ready) break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const bootstrap = await fetch(baseUrl + '/api/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const response = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    message: '程序甲已有证明，已证明的对象在规则系统中可用，能推出可用吗？',
    provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'scripted-logic-contract', apiKey: 'test' },
  }) });
  const events = await readEvents(response);
  const event = events.find((item) => item.type === 'logic_result');
  const done = events.find((item) => item.type === 'done');
  assert.ok(event, JSON.stringify(events));
  assert.equal(JSON.parse(seenTool.content).queries[0].status, 'true');
  assert.deepEqual(done.result.logicResults, [event.result]);
  assert.equal(event.result.verification.semanticSupportVerified, false);
  assert.equal(done.result.grounded, true);
  assert.equal(done.result.grounding.allCitationRefsValid, true);
  assert.equal(done.result.grounding.semanticSupportVerified, false);
  assert.equal(done.result.citations[0].sourceUrl, paper.sourceUrl);
  assert.equal(done.result.citations[0].license, paper.license);
  const task = await (await fetch(`${baseUrl}/api/tasks/${done.taskId}`, { headers: { cookie } })).json();
  assert.deepEqual(task.task.result.logicResults, done.result.logicResults);
});
