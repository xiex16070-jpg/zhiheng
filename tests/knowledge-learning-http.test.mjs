/** Whole server: import -> real chat SSE -> automatic capture -> same learning call
 * -> human confirmation -> restart -> source removal. All data/models are fixtures. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

test('automatic dialogue conclusions and semantic review persist through real server restart', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url)), dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-learning-http-'));
  let ref = '', child, base, reviews = 0, modelCalls = 0;
  const model = http.createServer(async (req, res) => {
    const buffers = []; for await (const chunk of req) buffers.push(chunk);
    const body = JSON.parse(Buffer.concat(buffers).toString()); let answer;
    if (body.messages[0]?.content.includes('学习审查器')) {
      reviews++; const id = /"id":"([a-f0-9-]{36})"/.exec(body.messages.at(-1).content)?.[1];
      answer = JSON.stringify({ memory: [], skills: [], conclusions: id ? [{ id, verdict: 'supported' }] : [] });
    } else if (body.tools) { modelCalls++; answer = `合取消去规则允许从同时成立的两个命题中取得其中一个命题，前提真实性仍需独立核对。 [[${ref}]]`; }
    else answer = '[]';
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(r => model.listen(0, '127.0.0.1', r));
  const env = { ...process.env };
  for (const line of (await fs.readFile(path.join(root, '.env'), 'utf8').catch(() => '')).split('\n')) {
    const key = /^\s*([A-Za-z_][\w]*)\s*=/.exec(line)?.[1]; if (key) env[key] = '';
  }
  Object.assign(env, { HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'), MYSQL_ENABLED: '0', REDIS_ENABLED: '0', EMBEDDING_PROVIDER: 'off', LEARNING_ENABLED: '1', REVIEW_EVERY_TASKS: '1', REVIEW_SETTLE_MS: '150', AUX_LLM_MAX_CALLS: '0', INFERENCE_AUDIT: '0', AUTH_SECRET: 'isolated-conclusion-http', HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost' });
  await fs.writeFile(env.CORPUS_JSONL, '');
  async function stop() { if (child && child.exitCode === null && !child.signalCode) { const end = once(child, 'exit'); child.kill(); await end; } }
  async function start() {
    // Only the test process can wait on this server's existing event-drain barrier.
    const fixture = `
      import { settleKnowledgeSourceChanges } from './src/server/kb-events.mjs';
      import './server.mjs';
      process.on('message', async message => {
        if (message !== 'drain-source-changes') return;
        try { await settleKnowledgeSourceChanges(); process.send({ settled: true }); }
        catch (error) { process.send({ settled: false, error: error.message }); }
      });
    `;
    child = spawn(process.execPath, ['--input-type=module', '-e', fixture], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let logs = ''; for (const s of [child.stdout, child.stderr]) s.on('data', b => { logs = (logs + b).slice(-3000); });
    for (const deadline = Date.now() + 20000; Date.now() < deadline;) {
      if (child.exitCode !== null) throw new Error('fixture startup failed: ' + logs);
      try { const port = (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim(); base = `http://127.0.0.1:${port}`; if ((await (await fetch(base + '/api/health')).json()).ready) return; } catch {}
      await new Promise(r => setTimeout(r, 30));
    }
    throw new Error('fixture startup timed out: ' + logs);
  }
  t.after(async () => { await stop(); model.closeAllConnections(); await new Promise(r => model.close(r)); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }); });
  await start();
  const cookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const get = async () => (await (await fetch(base + '/api/knowledge/conclusions', { headers: { cookie } })).json());
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, origin: base, 'x-settings-request': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const form = new FormData(); form.append('file', new Blob(['合取消去规则：从已经成立的 A 且 B 可以推出 A，也可以推出 B。不能把未知的前提当作已经成立。']), '自然演绎.txt');
  const imported = await fetch(base + '/api/kb/import', { method: 'POST', headers: { cookie }, body: form }); assert.equal(imported.status, 200);
  const docId = (await imported.json()).results[0].doc.id; ref = docId + '_0';
  const response = await post('/api/chat', { message: '合取消去规则有什么作用？', mode: 'knowledge', focusRef: ref, provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic', model: 'knowledge-integration' } });
  const events = await readEvents(response); assert.ok(events.some(e => e.type === 'done'), JSON.stringify(events));
  let entry;
  // The asynchronous review competes with other integration servers in the full suite.
  // Observe the persisted terminal state before restarting, as we already do for server readiness.
  for (const deadline = Date.now() + 15000; Date.now() < deadline;) {
    entry = (await get()).entries?.[0];
    if (entry && entry.semanticCheck.status !== 'pending') break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(entry?.status, 'candidate'); assert.equal(entry.semanticCheck.status, 'supported'); assert.equal(reviews, 1); assert.equal(modelCalls, 1);
  assert.equal((await post(`/api/knowledge/conclusions/${entry.id}/action`, { action: 'verify', revision: entry.revision })).status, 200);
  await stop(); await start(); entry = (await get()).entries[0]; assert.equal(entry.status, 'verified');
  const foreignCookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const foreign = await (await fetch(base + '/api/knowledge/conclusions', { headers: { cookie: foreignCookie } })).json(); assert.equal(foreign.entries.length, 0); assert.equal(foreign.documents.length, 0);
  const removed = await fetch(base + `/api/kb/docs/${docId}`, { method: 'DELETE', headers: { cookie } });
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { ok: true });
  const settled = once(child, 'message', { signal: AbortSignal.timeout(15000) });
  child.send('drain-source-changes');
  const [notification] = await settled;
  assert.deepEqual(notification, { settled: true });
  assert.equal((await fetch(base + `/api/kb/docs/${docId}`, { headers: { cookie } })).status, 404);
  const removedEntryId = entry.id;
  entry = (await get()).entries.find(item => item.id === removedEntryId);
  assert.ok(entry, 'removing the source must preserve the original conclusion record');
  assert.equal(entry.status, 'invalidated'); assert.equal(entry.sourceCheck.reason, 'source_removed');
});
