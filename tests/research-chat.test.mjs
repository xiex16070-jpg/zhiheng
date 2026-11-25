/** Exercise each research strategy through the same isolated HTTP/SSE entry used by the composer. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('文献策略真实问答：追检和分支选择使用分区资料，受辅助预算约束', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-research-chat-'));
  const calls = [];
  let stage = '';
  let excludedRef = '';
  const model = http.createServer(async (req, res) => {
    const data = [];
    for await (const chunk of req) data.push(chunk);
    const body = JSON.parse(Buffer.concat(data).toString());
    const system = body.messages[0]?.content || '';
    let answer;
    if (body.tools) {
      const input = stage === 'focus-approval' || stage.startsWith('document-') ? body.messages.map(m => m.content || '').join('\n') : body.messages.at(-1).content;
      const ref = /ref=([A-Za-z0-9_-]+)/.exec(input)?.[1];
      answer = ref ? `因为[[${ref}]]中‘这两种定义确实是等价的’。` : 'NO_EVIDENCE: 没有依据';
      if (stage === 'citations-only') answer = `[[${ref}]]。`;
    } else if (system.includes('[IRCoT:next]')) {
      answer = JSON.stringify(calls.some(c => c.stage === stage && c.system.includes('[IRCoT:next]')) ? { done: true } : { query: 'GARNET' });
    } else if (system.includes('[ToT:propose]')) answer = JSON.stringify({ branches: ['GARNET', 'MOSAIC'] });
    else if (system.includes('[ToT:expand]')) answer = JSON.stringify({ children: [{ parent: 1, query: 'AZURE' }] });
    else answer = '[]'; // ReAct's existing pre-retrieval rewrite.
    calls.push({ stage, body, system });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if ((stage === 'focus-approval' || stage === 'document-approval') && body.tools && !body.messages.some(m => m.role === 'tool')) {
      const call = { index: 0, id: 'preference', type: 'function', function: { name: 'update_preferences', arguments: '{"style":"concise"}' } };
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (stage === 'document-tools' && body.tools && !body.messages.some(m => m.role === 'tool')) {
      const attempts = [
        ['search_knowledge', {query:'ORBITAL',source:'paper',discipline:'其他学科'}],
        ['read_source', {ref:excludedRef}],
        ['web_fetch', {url:'https://example.com/'}],
        ['start_background_task', {goal:'Move document research to background'}],
      ].map(([name,args],index)=>({index,id:'boundary-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}}));
      res.end(`data: ${JSON.stringify({choices:[{index:0,delta:{tool_calls:attempts},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
      return;
    }
    if (stage === 'forbidden' && body.tools && !body.messages.some(m => m.role === 'tool')) {
      const call = { index: 0, id: 'outside', type: 'function', function: { name: 'run_command', arguments: '{"command":"echo witness"}' } };
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(dir, 'papers.jsonl'), JSON.stringify({ id: 1, title: 'ORBITAL', abstract: 'CORPUS_OUT_OF_SCOPE', discipline: '其他学科' }) + '\n');
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir, STORE_FILE: path.join(dir, 'store.json'), CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vec.json'), MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false',
    EMBEDDING_PROVIDER: 'off', EMBEDDING_BASE_URL: '', QDRANT_URL: '', RAGFLOW_BASE_URL: '', RERANK_ENABLED: 'false',
    MINERU_ENABLED: 'false', LEARNING_ENABLED: 'false', INFERENCE_AUDIT: 'false', AUTH_SECRET: 'isolated-research-test-secret',
    HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1', EXEC_ENABLED: 'true',
  };
  let child, base;
  async function stopServer() {
    if (child && child.exitCode === null && !child.signalCode) { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  t.after(async () => {
    await stopServer();
    model.closeAllConnections();
    await new Promise(resolve => model.close(resolve));
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function startServer(budget) {
    child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, AUX_LLM_MAX_CALLS: String(budget) } });
    let logs = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
    const deadline = Date.now() + 20000;
    while (true) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server startup failed: ${logs}`);
      try {
        const port = (await fs.readFile(path.join(dir, '.server-port'), 'utf8')).trim();
        base = 'http://127.0.0.1:' + port;
        if ((await (await fetch(base + '/api/health')).json()).ready) return;
      } catch { /* The process may not have published its listener yet. */ }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  await startServer(2);
  async function cookie() { return (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0]; }
  const owner = await cookie(), other = await cookie();
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify(url==='/api/chat'?{...body,mode:'knowledge'}:body) });
  const upload = async (userCookie, name, contents) => {
    const form = new FormData();
    form.append('file', new Blob([contents]), name + '.txt');
    const res = await fetch(base + '/api/kb/import', { method: 'POST', headers: { cookie: userCookie }, body: form });
    assert.ok(res.ok);
    return (await res.json()).results[0].doc.id;
  };
  const docs = [];
  for (const [name, contents] of [
    ['Seed', 'ORBITAL opens GARNET by the protocol. SEED_WITNESS.'],
    ['Rule', 'GARNET resolves via AZURE. FOLLOWUP_WITNESS.'],
    ['Variant', 'MOSAIC uses a different mapping. ALTERNATE_WITNESS.'],
    ['Bound', 'AZURE completes the connection. FINAL_WITNESS.'],
  ]) docs.push(await upload(owner, name, contents));
  const outsideDoc = await upload(owner, 'Outside', 'ORBITAL GARNET AZURE MOSAIC OUTSIDE_SECTION_SECRET.');
  const otherDoc = await upload(other, 'Other', 'ORBITAL GARNET AZURE MOSAIC OTHER_USER_SECRET.');
  const questionsFor = async userCookie => (await (await fetch(base + '/api/kb/questions', { headers: { cookie: userCookie } })).json()).questions;
  const outsideRef = (await questionsFor(owner)).find(item => item.docId === outsideDoc).ref;
  const otherRef = (await questionsFor(other)).find(item => item.docId === otherDoc).ref;
  const section = await post('/api/kb/sections', { name: '批准的范围', docIds: docs });
  assert.equal(section.status, 201);
  assert.ok((await post('/api/preferences', { preferences: { discipline: (await section.json()).section.id } })).ok);
  const baseChat = { message: 'ORBITAL', provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'strategy-contract', apiKey: 'test' } };
  const invalid = await post('/api/chat', { ...baseChat, researchStrategy: 'unknown' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_research_strategy');
  assert.equal(calls.length, 0);

  for (stage of ['default', 'react', 'ircot', 'tot']) {
    const response = await post('/api/chat', { ...baseChat, ...(stage === 'default' ? {} : { researchStrategy: stage }) });
    const events = await readEvents(response);
    const done = events.find(e => e.type === 'done');
    assert.ok(done, JSON.stringify(events));
    assert.ok(!events.some(e => e.type === 'step' && e.name === 'selected_source'));
    const expected = stage === 'default' ? 'react' : stage;
    assert.equal(done.result.research.strategy, expected);
    assert.ok(done.result.citations.length);
    if (stage === 'default') assert.equal(done.result.quoteAudit, undefined);
    else {
      assert.equal(done.result.quoteAudit.checks[0].status, 'unmatched');
      assert.equal(done.result.quoteAudit.checks[0].quote, '这两种定义确实是等价的');
      assert.match(done.result.body, /这两种定义确实是等价的/);
    }
    const recorded = calls.filter(c => c.stage === stage);
    assert.doesNotMatch(JSON.stringify([recorded, events]), /OUTSIDE_SECTION_SECRET|OTHER_USER_SECRET|CORPUS_OUT_OF_SCOPE/);
    const main = recorded.filter(c => c.body.tools);
    assert.equal(main.length, 1);
    const names = main[0].body.tools.map(tool => tool.function.name);
    if (stage === 'default') assert.ok((names.includes('run_command') && names.includes('logic_run_assumptions')) || (names.includes('tool_search') && JSON.stringify(main[0].body.messages).includes('run_command') && JSON.stringify(main[0].body.messages).includes('logic_run_assumptions')));
    else assert.deepEqual(names.sort(), ['current_time', 'logic_evaluate_grounded', 'read_source', 'search_knowledge', 'verify_quote']);
    const aux = recorded.filter(c => !c.body.tools);
    assert.equal(aux.length, done.result.llmCalls.aux);
    assert.ok(aux.length <= 2);
    const steps = events.filter(e => e.type === 'step' && e.name.startsWith('research_'));
    if (expected === 'react') {
      assert.equal(steps.length, 0);
      assert.ok(aux.every(c => !/\[(?:IRCoT|ToT):/.test(c.system)));
      assert.doesNotMatch(main[0].body.messages.at(-1).content, /FOLLOWUP_WITNESS|ALTERNATE_WITNESS/);
      continue;
    }
    const stats = done.result.research.stats;
    const { process, ...recordedStats } = steps.find(e => e.status === 'ok')?.detail || {};
    assert.deepEqual(recordedStats, stats);
    assert.deepEqual(process, done.result.research.process);
    assert.equal(process.length, stats.searches);
    assert.ok(process.every(operation => Number.isInteger(operation.hits)));
    assert.equal(stats.modelCalls, aux.length);
    assert.match(main[0].body.messages.at(-1).content, /FOLLOWUP_WITNESS|ALTERNATE_WITNESS|FINAL_WITNESS/);
    if (stage === 'ircot') {
      assert.equal(stats.searches, 1);
      assert.ok(aux.some(c => c.system.includes('[IRCoT:next]') && JSON.stringify(c.body.messages).includes('FOLLOWUP_WITNESS')));
    } else {
      assert.equal(stats.searches, 3);
      assert.ok(stats.evaluated >= 2);
      assert.ok(stats.selected.length >= 1);
      assert.ok(aux.some(c => c.system.includes('[ToT:expand]') && /FOLLOWUP_WITNESS|ALTERNATE_WITNESS/.test(JSON.stringify(c.body.messages))));
    }
    const task = (await (await fetch(base + '/api/tasks/' + done.taskId, { headers: { cookie: owner } })).json()).task;
    assert.deepEqual(task.result.research, done.result.research);
    assert.deepEqual(task.result.quoteAudit, done.result.quoteAudit);
  }
  const focus = (await questionsFor(owner)).find(item => item.docId === docs[0]);
  assert.ok(focus && !focus.question.includes('Seed'));
  stage = 'focus';
  const focused = await readEvents(await post('/api/chat', { ...baseChat, message: focus.question, focusRef: focus.ref }));
  const focusedDone = focused.find(event => event.type === 'done');
  assert.ok(focusedDone, JSON.stringify(focused));
  assert.equal(focusedDone.result.citations[0].ref, focus.ref);
  assert.equal(focusedDone.result.citations[0].docId, docs[0]);
  assert.equal(focusedDone.result.citations[0].locatable, true);
  assert.ok(focused.some(event => event.type === 'step' && event.name === 'selected_source' && event.status === 'ok' && event.detail.ref === focus.ref));
  const focusedInput = calls.find(call => call.stage === stage && call.body.tools).body.messages.at(-1).content;
  assert.match(focusedInput, /SEED_WITNESS/);
  assert.doesNotMatch(focusedInput, /OUTSIDE_SECTION_SECRET|OTHER_USER_SECRET/);
  for (const invalidFocus of [null, 1, '', 'bad/ref', 'x'.repeat(65)]) {
    const response = await post('/api/chat', { ...baseChat, focusRef: invalidFocus });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_focus_ref');
  }
  for (const inaccessible of [outsideRef, otherRef, 'missing_chunk']) {
    const before = calls.length;
    const denied = await readEvents(await post('/api/chat', { ...baseChat, focusRef: inaccessible }));
    assert.ok(denied.some(event => event.type === 'error' && event.message.includes('selected_source_unavailable')), JSON.stringify(denied));
    assert.ok(!denied.some(event => event.type === 'done'));
    assert.equal(calls.length, before, 'invalid selected material must fail before any model request');
  }
  stage = 'focus-approval';
  const paused = await readEvents(await post('/api/chat', { ...baseChat, focusRef: focus.ref }));
  const approval = paused.find(event => event.type === 'approval_required')?.approval;
  assert.ok(approval, JSON.stringify(paused));
  const pausedTask = (await (await fetch(base + '/api/tasks/' + approval.taskId, { headers: { cookie: owner } })).json()).task;
  assert.equal(pausedTask.checkpoint.focusRef, focus.ref);
  assert.ok((await post('/api/approvals/' + approval.id + '/decide', { decision: 'approved' })).ok);
  const resumed = await readEvents(await post('/api/tasks/' + approval.taskId + '/resume', { provider: baseChat.provider, approvalId: approval.id }));
  assert.ok(resumed.some(event => event.type === 'done'), JSON.stringify(resumed));
  assert.ok(!resumed.some(event => event.type === 'step' && event.name === 'selected_source'), 'resume uses frozen source context');
  stage = 'forbidden';
  const guarded = await readEvents(await post('/api/chat', { ...baseChat, researchStrategy: 'react' }));
  assert.ok(guarded.some(e => e.type === 'tool' && e.name === 'run_command' && e.summary.includes('未执行')));
  assert.ok(guarded.some(e => e.type === 'done'));
  assert.ok(!guarded.some(e => e.type === 'approval_required'));
  stage = 'citations-only';
  const partial = await readEvents(await post('/api/chat', { ...baseChat, researchStrategy: 'ircot' }));
  assert.ok(!partial.some(e => e.type === 'done'));
  const failure = partial.find(e => e.type === 'error');
  assert.equal(failure.result.incompleteReason, 'citations_only');
  assert.equal(failure.result.grounded, false);
  assert.equal(failure.result.grounding.status, 'citations_without_answer');
  assert.equal(failure.result.grounding.allCitationRefsValid, true);
  assert.equal(failure.result.noEvidence, false);
  assert.ok(failure.result.citations[0].ref);
  assert.equal(failure.result.body, `[[${failure.result.citations[0].ref}]]。`);
  assert.equal(calls.filter(c => c.stage === stage && c.body.tools).length, 1);
  const failedTask = await (await fetch(base + '/api/tasks/' + failure.taskId, { headers: { cookie: owner } })).json();
  assert.equal(failedTask.task.status, 'failed');
  const history = await (await fetch(base + '/api/conversations/' + partial[0].conversationId + '/messages', { headers: { cookie: owner } })).json();
  const last = history.messages.at(-1);
  assert.deepEqual(last.result.citations, failure.result.citations);
  assert.equal(last.taskStatus, 'failed');
  assert.match(last.content, /仅返回来源编号，没有回答正文/);
  // An explicit document overrides a saved section for this turn, never expands
  // the source boundary through model filters, external tools, or a resume.
  excludedRef = focus.ref;
  assert.ok((await post('/api/preferences', {preferences:{jointResearch:true}})).ok);
  const documentChat={...baseChat,message:'ORBITAL',focusDocId:outsideDoc,focusRef:outsideRef};
  stage='document-tools';
  const documentEvents=await readEvents(await post('/api/chat',documentChat));
  const documentDone=documentEvents.find(e=>e.type==='done');
  assert.ok(documentDone,JSON.stringify(documentEvents));
  assert.deepEqual(documentDone.result.knowledgeScope,{id:'document:'+outsideDoc,members:[outsideDoc]});
  assert.equal(documentDone.result.focusDocId,outsideDoc);
  assert.ok(documentDone.result.citations.every(c=>c.docId===outsideDoc));
  const documentCalls=calls.filter(c=>c.stage===stage);
  assert.match(JSON.stringify(documentCalls),/OUTSIDE_SECTION_SECRET/);
  assert.doesNotMatch(JSON.stringify(documentCalls),/SEED_WITNESS|OTHER_USER_SECRET|CORPUS_OUT_OF_SCOPE/);
  const documentNames=documentCalls.find(c=>c.body.tools).body.tools.map(s=>s.function.name);
  assert.ok(!documentNames.includes('web_fetch')&&!documentNames.includes('start_background_task'));
  assert.ok(documentEvents.some(e=>e.type==='tool'&&e.name==='read_source'&&e.summary.includes('来源超出')));
  assert.ok(!documentEvents.some(e=>e.type==='step'&&e.name==='authority_retrieve'));
  stage='document-approval';
  const documentPaused=await readEvents(await post('/api/chat',documentChat));
  const documentApproval=documentPaused.find(e=>e.type==='approval_required')?.approval;
  assert.ok(documentApproval,JSON.stringify(documentPaused));
  const frozen=(await (await fetch(base+'/api/tasks/'+documentApproval.taskId,{headers:{cookie:owner}})).json()).task;
  assert.equal(frozen.checkpoint.focusDocId,outsideDoc);
  assert.equal(frozen.checkpoint.jointResearch.enabled,false);
  assert.ok((await post('/api/approvals/'+documentApproval.id+'/decide',{decision:'approved'})).ok);
  const documentResumed=await readEvents(await post('/api/tasks/'+documentApproval.taskId+'/resume',{provider:baseChat.provider,approvalId:documentApproval.id}));
  const resumedDone=documentResumed.find(e=>e.type==='done');
  assert.ok(resumedDone,JSON.stringify(documentResumed));
  assert.equal(resumedDone.result.focusDocId,outsideDoc);
  assert.deepEqual(resumedDone.result.knowledgeScope,{id:'document:'+outsideDoc,members:[outsideDoc]});
  assert.ok(resumedDone.result.citations.every(c=>c.docId===outsideDoc));
  assert.doesNotMatch(JSON.stringify(calls.filter(c=>c.stage===stage)),/SEED_WITNESS|OTHER_USER_SECRET|CORPUS_OUT_OF_SCOPE/);
  const deletionPending=await readEvents(await post('/api/chat',documentChat));
  const deletionApproval=deletionPending.find(e=>e.type==='approval_required')?.approval;
  assert.ok(deletionApproval,JSON.stringify(deletionPending));
  assert.ok((await post('/api/approvals/'+deletionApproval.id+'/decide',{decision:'approved'})).ok);
  assert.ok((await fetch(base+'/api/kb/docs/'+outsideDoc,{method:'DELETE',headers:{cookie:owner}})).ok);
  const beforeResume=calls.length;
  const deletedResume=await readEvents(await post('/api/tasks/'+deletionApproval.taskId+'/resume',{provider:baseChat.provider,approvalId:deletionApproval.id}));
  assert.ok(deletedResume.some(e=>e.type==='error'&&e.message.includes('selected_document_unavailable')),JSON.stringify(deletedResume));
  assert.equal(calls.length,beforeResume,'deleted focused document must fail before model access');
  assert.ok((await post('/api/preferences',{preferences:{jointResearch:false}})).ok);
  // A deployment can reserve every model call for the answer. Both planners
  // must use the initial evidence without a hidden auxiliary model request.
  await stopServer();
  await startServer(0);
  for (const researchStrategy of ['ircot', 'tot']) {
    stage = 'budget-zero-' + researchStrategy;
    const events = await readEvents(await post('/api/chat', { ...baseChat, researchStrategy }));
    const done = events.find(e => e.type === 'done');
    assert.ok(done, JSON.stringify(events));
    assert.equal(done.result.research.strategy, researchStrategy);
    assert.equal(done.result.llmCalls.aux, 0);
    assert.equal(done.result.research.stats.searches, 0);
    const recorded = calls.filter(c => c.stage === stage);
    assert.equal(recorded.length, 1);
    assert.match(recorded[0].body.messages.at(-1).content, /SEED_WITNESS/);
  }
});
