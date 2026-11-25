import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
test('联合研究通过真实 HTTP/SSE 与持久化：开关、范围、引用、审批恢复和私密边界', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-joint-chat-'));
  const logFile = path.join(dir, 'requests.jsonl');
  await fs.writeFile(path.join(dir, 'papers.jsonl'), JSON.stringify({ id: 1, title: 'Formal verification corpus', abstract: 'formal verification OUTSIDE_SECTION_SECRET', discipline: '计算机' }) + '\n');
  const child = spawn(process.execPath, ['--import', './scripts/fixtures/joint-research-network.mjs', 'server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vec.json'), MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false',
    EMBEDDING_PROVIDER: 'off', QDRANT_URL: '', RAGFLOW_BASE_URL: '', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false',
    LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUTH_SECRET: 'isolated-joint-test-secret',
    SCHOLAR_SEARCH: 'true', WEB_SEARCH_PROVIDER: '', WEB_SEARCH_KEY: '', OPENALEX_API_KEY: '', WEB_FETCH_ENABLED: 'false',
    JOINT_FIXTURE_LOG: logFile, HTTP_PROXY: '', HTTPS_PROXY: '', AUX_LLM_MAX_CALLS: '3',
  } });
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) { const done = once(child, 'exit'); child.kill(); await done; }
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  let logs = '', base;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      base = 'http://127.0.0.1:' + (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim();
      if ((await (await fetch(base + '/api/health')).json()).ready) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  assert.ok(base && child.exitCode === null, logs);
  const provider = { baseUrl: 'http://127.0.0.1:' + (await fs.readFile(path.join(dir, '.joint-model-port'), 'utf8')).trim() + '/v1', model: 'joint-contract', apiKey: 'test' };
  const bootstrap = await fetch(base + '/api/bootstrap');
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const initial = await bootstrap.json();
  assert.equal(initial.preferences.jointResearch, false);
  assert.equal(initial.config.jointResearch.websites, false);
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const get = url => fetch(base + url, { headers: { cookie } }).then(r => r.json());
  const entries = async () => (await fs.readFile(logFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const publicCalls = async () => (await entries()).filter(r => r.kind === 'discovery');
  const preferences = async prefs => { const r = await post('/api/preferences', { preferences: prefs }); assert.ok(r.ok, await r.text()); };
  const question = 'formal verification';
  const chat = (extra = {}) => post('/api/chat', { mode:'knowledge',message: question, provider, ...extra }).then(readEvents);
  const form = new FormData();
  form.append('file', new Blob(['formal verification uses specifications and proofs. PRIVATE_DOCUMENT_TEXT never goes to external search.']), 'private-study.txt');
  const imported = await fetch(base + '/api/kb/import', { method: 'POST', headers: { cookie }, body: form }).then(r => r.json());
  const docId = imported.results[0].doc.id;
  const section = await post('/api/kb/sections', { name: '形式验证', docIds: [docId] }).then(r => r.json());
  await preferences({ discipline: section.section.id, learning: 'off' });
  const off = await chat();
  assert.ok(off.some(e => e.type === 'done'), JSON.stringify(off));
  assert.equal((await publicCalls()).length, 0);
  await preferences({ jointResearch: true, localWeight: 50, includePreprints: false });
  for (const strategy of ['react', 'ircot', 'tot']) {
    const events = await chat({ researchStrategy: strategy });
    const done = events.find(e => e.type === 'done');
    assert.ok(done, JSON.stringify(events));
    const report = done.result.jointResearch;
    assert.ok(report.counts.local >= 1 && report.counts.external >= 1);
    assert.equal(report.requested.local, 50);
    assert.equal(report.audit.externalCited, 1);
    assert.equal(report.audit.crossVerification, 'not_verified');
    assert.ok(events.some(e => e.type === 'step' && e.name === 'authority_retrieve' && e.status === 'ok'));
    assert.ok(events.some(e => e.type === 'tool' && e.name === 'read_source' && e.summary === '已读取外部检索材料'), JSON.stringify(events.filter(e => e.type === 'tool')));
    const citation = done.result.citations.find(c => c.authority);
    assert.ok(citation.sourceText.includes('Formal verification'));
    assert.ok(citation.sourceUrl.startsWith('https://doi.org/'));
    assert.equal(citation.authority.evidenceLevel, 'abstract');
    assert.equal(citation.authority.peerReviewVerified, false);
    assert.equal(done.result.citations.find(c => c.kind === 'doc').docId, docId);
    assert.ok(!JSON.stringify(events).includes('OUTSIDE_SECTION_SECRET'));
    const task = await get('/api/tasks/' + done.taskId);
    assert.deepEqual(task.task.result.jointResearch, report);
    const history = await get('/api/conversations/' + events.find(e => e.type === 'conversation').conversationId + '/messages');
    assert.ok(history.messages.some(m => m.citations?.some(c => c.authority && c.sourceText)));
    if (strategy === 'react') {
      const assistant = history.messages.find(m => m.taskId === done.taskId && m.role === 'assistant');
      const conv = events.find(e => e.type === 'conversation').conversationId;
      const endpoint = '/api/tasks/' + done.taskId + '/references';
      const exported = await get(endpoint + '?format=csl-json');
      assert.deepEqual(exported.map(item => item.id), done.result.citations.map(c => c.ref));
      assert.match(exported.find(item => item.id === citation.ref).note, /仅摘要/);
      const historic = await get('/api/conversations/' + conv + '/messages/' + assistant.id + '/references?format=csl-json');
      assert.deepEqual(historic, exported);
      const bib = await fetch(base + endpoint + '?format=bibtex', { headers: { cookie } });
      assert.equal(bib.headers.get('content-disposition'), 'attachment; filename="references.bib"');
      assert.match(await bib.text(), /仅摘要/);
      const other = (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
      assert.equal((await fetch(base + endpoint + '?format=ris', { headers: { cookie: other } })).status, 404);
      assert.equal((await fetch(base + endpoint + '?format=arbitrary', { headers: { cookie } })).status, 400);
    }
  }
  assert.ok((await publicCalls()).every(c => !c.url.includes('PRIVATE_DOCUMENT_TEXT') && !c.url.includes('OUTSIDE_SECTION_SECRET') && !c.url.includes('export.arxiv.org')));
  const modelCalls = (await entries()).filter(e => e.kind === 'model' && e.body.tools);
  assert.ok(modelCalls.filter(e => e.body.messages[0].content.includes('联合研究证据纪律')).every(e => !e.body.tools.some(t => ['web_search', 'web_fetch', 'scholar_search'].includes(t.function.name))));
  const bypass = await chat({ message: question + ' TRY_BYPASS' });
  assert.ok(bypass.some(e => e.type === 'done'));
  assert.ok(bypass.some(e => e.type === 'tool' && e.summary.includes('联合研究来源策略')));
  assert.ok(bypass.find(e => e.type === 'done').result.quoteAudit);
  assert.ok(!(await publicCalls()).some(c => c.url.includes('evil.example')));
  const offline = await chat({ message: question + ' OFFLINE' });
  const offlineResult = offline.find(e => e.type === 'done')?.result;
  assert.ok(offlineResult, JSON.stringify(offline));
  assert.equal(offlineResult.jointResearch.counts.external, 0);
  assert.equal(offlineResult.jointResearch.status, 'no_external_evidence');

  const paused = await chat({ message: question + ' ASK_APPROVAL' });
  const approval = paused.find(e => e.type === 'approval_required');
  assert.ok(approval, JSON.stringify(paused));
  const before = (await publicCalls()).length;
  const taskBefore = (await get('/api/tasks/' + approval.taskId)).task;
  assert.equal(taskBefore.checkpoint.jointResearch.localWeight, 50);
  const denied = await post('/api/approvals/' + approval.approval.id + '/decide', { decision: 'denied' });
  assert.ok(denied.ok, await denied.text());
  const resumed = await post('/api/tasks/' + approval.taskId + '/resume', { provider }).then(readEvents);
  assert.ok(resumed.some(e => e.type === 'done'), JSON.stringify(resumed));
  assert.equal((await publicCalls()).length, before, 'resume must not rediscover');
  assert.equal(resumed.find(e => e.type === 'done').result.jointResearch.requested.local, 50);
  const approvedEvents = await chat({ message: question + ' ASK_APPROVAL' });
  const approved = approvedEvents.find(e => e.type === 'approval_required');
  assert.ok(approved);
  assert.ok((await post('/api/approvals/' + approved.approval.id + '/decide', { decision: 'approved' })).ok);
  const approvedResume = await post('/api/tasks/' + approved.taskId + '/resume', { provider }).then(readEvents);
  assert.ok(approvedResume.some(e => e.type === 'done'), JSON.stringify(approvedResume));
  const lastPrompt = (await entries()).filter(e => e.kind === 'model' && e.body.tools).at(-1).body.messages[0].content;
  assert.equal((lastPrompt.match(/# 联合研究证据纪律/g) || []).length, 1, 'preference refresh retains the joint policy exactly once');
  const changedEvents = await chat({ message: question + ' ASK_APPROVAL' });
  const changed = changedEvents.find(e => e.type === 'approval_required');
  assert.ok(changed);
  await preferences({ jointResearch: false });
  assert.ok((await post('/api/approvals/' + changed.approval.id + '/decide', { decision: 'rejected' })).ok);
  const beforeDisable = (await publicCalls()).length;
  const changedResume = await post('/api/tasks/' + changed.taskId + '/resume', { provider }).then(readEvents);
  assert.ok(changedResume.some(e => e.type === 'error' && e.message.includes('联合研究设置已变更')), JSON.stringify(changedResume));
  await chat();
  assert.equal((await publicCalls()).length, beforeDisable);
});
