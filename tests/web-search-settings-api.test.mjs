import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readEvents } from '../evals/provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'tvly-fixture-valid-key-for-settings';
const INVALID = 'tvly-fixture-invalid-key-for-settings';
test('搜索设置 HTTP：本机鉴权、草稿测试、热生效、重启、审计脱敏和移除', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-search-settings-api-'));
  const logFile = path.join(dir, 'requests.jsonl');
  await fs.writeFile(path.join(dir, 'papers.jsonl'), JSON.stringify({ id: 1, title: 'Formal verification', abstract: 'Formal verification proves properties relative to a specification.', discipline: '计算机' }) + '\n');
  let child, base, logs = '';
  async function stop() {
    if (child && child.exitCode === null && !child.signalCode) { const done = once(child, 'exit'); child.kill(); await done; }
  }
  t.after(async () => { await stop(); assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); await fs.rm(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['--import', './scripts/fixtures/joint-research-network.mjs', 'server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
      KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vec.json'), MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false',
      EMBEDDING_PROVIDER: 'off', QDRANT_URL: '', RAGFLOW_BASE_URL: '', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false',
      LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUTH_SECRET: 'isolated-search-settings-api-secret',
      SCHOLAR_SEARCH: 'false', WEB_SEARCH_PROVIDER: '', WEB_SEARCH_KEY: '', OPENALEX_API_KEY: '', WEB_FETCH_ENABLED: 'true',
      JOINT_FIXTURE_LOG: logFile, HTTP_PROXY: '', HTTPS_PROXY: '', AUX_LLM_MAX_CALLS: '0',
    } });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', c => { logs = (logs + c).slice(-6000); });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const port = (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim();
        base = 'http://127.0.0.1:' + port;
        if ((await (await fetch(base + '/api/health')).json()).ready) return;
      } catch {}
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('Isolated server did not start: ' + logs);
  }
  await start();
  const bootstrap = await fetch(base + '/api/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const url = '/api/settings/web-search';
  const get = (target = url, headers = {}) => fetch(base + target, { headers: { cookie, ...headers } });
  const send = (body, target = url, method = 'POST', headers = {}) => fetch(base + target, { method,
    headers: { cookie, origin: base, 'x-settings-request': '1', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + url)).status, 401);
  assert.equal((await send({}, url, 'POST', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({}, url, 'POST', { 'x-settings-request': '' })).status, 403);
  assert.equal((await send({}, url, 'POST', { 'x-forwarded-for': '8.8.8.8' })).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.request(base + url, { method: 'POST', headers: { cookie, origin: base, host: 'evil.example', 'x-settings-request': '1', 'content-type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(wrongHost, 403);
  assert.equal((await (await get(url, { forwarded: 'for=8.8.8.8' })).json()).canManage, false);
  assert.equal((await (await get()).json()).settings.configured, false);
  const draft = await (await send({ provider: 'tavily', apiKey: KEY }, url + '/test')).json();
  assert.equal(draft.ok, true);
  assert.equal(draft.resultCount, 1);
  await assert.rejects(fs.access(path.join(dir, '.web-search.json')));
  assert.equal((await (await get()).json()).settings.configured, false);
  const denied = await (await send({ provider: 'tavily', apiKey: INVALID }, url + '/test')).json();
  assert.equal(denied.ok, false); assert.equal(denied.code, 'authentication_failed');
  assert.ok(!JSON.stringify(denied).includes(INVALID));
  assert.equal((await send({ provider: 'tavily', apiKey: KEY, query: 'private content' }, url + '/test')).status, 400);
  const patch = { provider: 'tavily', apiKey: KEY, revision: 0, enabled: true, fetchEnabled: true };
  const saved = await (await send(patch)).json();
  assert.equal(saved.settings.configured, true);
  assert.equal(saved.settings.revision, 1);
  assert.equal(saved.capabilities.websites, true);
  assert.equal((await send(patch)).status, 409);
  const raw = await fs.readFile(path.join(dir, '.web-search.json'), 'utf8');
  assert.ok(!raw.includes(KEY)); assert.ok(!JSON.stringify(saved).includes(KEY));
  assert.equal((await get('/data/.web-search.json')).status, 403);
  const modelUrl = 'http://127.0.0.1:' + (await fs.readFile(path.join(dir, '.joint-model-port'), 'utf8')).trim() + '/v1';
  const modelKey = 'synthetic-model-key-persist';
  const modelSaved = await (await send({ baseUrl: modelUrl, model: 'web-search-contract', apiKey: modelKey, preset: 'custom', revision: 0 }, '/api/settings/models')).json();
  assert.ok(modelSaved.active.savedKeyId);
  assert.equal(modelSaved.active.apiKey, '');
  assert.ok(!JSON.stringify(modelSaved).includes(modelKey));
  assert.equal((await send({}, '/api/settings/models', 'POST', { origin: 'https://evil.example' })).status, 403);
  const chatResponse = await fetch(base + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    message: 'USE_WEB_SEARCH formal verification', provider: modelSaved.active,
  }) });
  const events = await readEvents(chatResponse);
  assert.ok(events.some(e => e.type === 'tool' && e.name === 'web_search' && e.summary.includes('结果')), JSON.stringify(events));
  assert.ok(events.some(e => e.type === 'done'));
  const fixtureLog = await fs.readFile(logFile, 'utf8');
  const model = fixtureLog.trim().split('\n').map(JSON.parse).find(r => r.kind === 'model' && r.body.tools);
  assert.ok(model.body.tools.some(s => s.function.name === 'web_search'), 'new task sees newly enabled tool');
  assert.ok(!fixtureLog.includes(KEY));
  assert.ok(!fixtureLog.includes(modelKey));
  // Deterministic model output, real orchestrator/renderers/artifact download.
  for (const format of ['PDF', 'DOCX']) {
    const documentEvents = await readEvents(await send({ message: 'USE_DOCUMENT ' + format, provider: modelSaved.active }, '/api/chat'));
    const fileApproval=documentEvents.find(e=>e.type==='approval_required')?.approval;
    assert.equal(fileApproval?.action,'create_document');
    assert.equal((await get('/api/workspace/file?path='+encodeURIComponent('报告.'+format.toLowerCase()))).status,404,'no file before user approval');
    assert.equal((await send({decision:'approved'},'/api/approvals/'+fileApproval.id+'/decide')).status,200);
    documentEvents.push(...await readEvents(await send({provider:modelSaved.active,approvalId:fileApproval.id},'/api/tasks/'+fileApproval.taskId+'/resume')));
    const done = documentEvents.find(e => e.type === 'done');
    const artifact = done?.result?.artifacts?.find(a => a.path === '报告.' + format.toLowerCase());
    assert.ok(artifact, JSON.stringify(documentEvents));
    const downloaded = await get('/api/workspace/file?download=1&path=' + encodeURIComponent(artifact.path));
    assert.equal(downloaded.status, 200);
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(bytes.subarray(0, format === 'PDF' ? 5 : 2).toString(), format === 'PDF' ? '%PDF-' : 'PK');
    const stranger = await fetch(base + '/api/bootstrap');
    const wrongOwner = await fetch(base + '/api/workspace/file?path=' + encodeURIComponent(artifact.path), { headers: { cookie: stranger.headers.get('set-cookie').split(';')[0] } });
    assert.equal(wrongOwner.status, 404);
  }
  // A real MCP process is configured by the local user; actual model execution
  // must stop at an approval and cannot write until that exact grant is consumed.
  const extensionUrl = '/api/settings/extensions';
  const ext = await send({ id: 'fixture', name: 'Approval fixture', kind: 'stdio', command: process.execPath,
    args: [path.join(ROOT, 'scripts', 'fixtures', 'extension-server.mjs')], revision: 0 }, extensionUrl);
  assert.equal(ext.status, 200, await ext.clone().text());
  assert.equal((await send({ id: 'fixture', revision: 1, enabled: true, allowedTools: ['write_note'] }, extensionUrl)).status, 200);
  const requested = await send({ message: 'USE_EXTENSION 保存验证说明', provider: modelSaved.active }, '/api/chat');
  const paused = await readEvents(requested);
  const approvalEvent = paused.find(e => e.type === 'approval_required');
  assert.ok(approvalEvent, JSON.stringify(paused));
  const user = (await (await get('/api/bootstrap')).json()).user.id;
  const artifact = path.join(dir, 'workspace', user, 'approved-note.txt');
  await assert.rejects(fs.access(artifact));
  assert.equal((await send({ decision: 'approved' }, '/api/approvals/' + approvalEvent.approval.id + '/decide')).status, 200);
  const resumed = await readEvents(await send({ provider: modelSaved.active, approvalId: approvalEvent.approval.id }, '/api/tasks/' + approvalEvent.taskId + '/resume'));
  assert.ok(resumed.some(e => e.type === 'done'), JSON.stringify(resumed));
  assert.equal(await fs.readFile(artifact, 'utf8'), 'approved via real orchestrator');
  await stop(); await start();
  const reloaded = await (await get()).json();
  assert.equal(reloaded.settings.configured, true); assert.equal(reloaded.settings.revision, 1);
  assert.equal((await (await send({ provider: 'tavily' }, url + '/test')).json()).ok, true);
  const disabled = await (await send({ ...patch, apiKey: '', revision: 1, enabled: false })).json();
  assert.equal(disabled.settings.configured, true); assert.equal(disabled.capabilities.websites, false);
  const removed = await (await send({ revision: 2 }, url, 'DELETE')).json();
  assert.equal(removed.settings.configured, false); assert.equal(removed.capabilities.websites, false);
  assert.equal((await send({ provider: 'tavily' }, url + '/test')).status, 400);
  const storeText = await fs.readFile(path.join(dir, 'store.json'), 'utf8');
  assert.ok(!storeText.includes(KEY)); assert.ok(!storeText.includes(INVALID));
  assert.match(storeText, /settings.web_search.update/);
  assert.match(storeText, /settings.web_search.test/);
  assert.ok(!logs.includes(KEY));
  const secondCookie = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  for (let n = 0; n < 6; n++) {
    const r = await send({ provider: 'tavily', apiKey: KEY }, url + '/test', 'POST', { cookie: secondCookie });
    assert.equal(r.status, n < 5 ? 200 : 429);
  }
});
