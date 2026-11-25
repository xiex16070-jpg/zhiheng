/** Runtime contracts for the opt-in local profile; scripted HTTP is not model quality evaluation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { isLocalQwen, localQwenTools, localQwenSystem, sourceExcerpt, localToolResult, localQwenBudget,
  assertCompleteToolPairs, LOCAL_QWEN_SYSTEM_PROMPT, LOCAL_QWEN_PROMPT_SHA256 } from '../src/server/local-qwen.mjs';
import { isConfigured, isLocalQwenProvider, PRESETS } from '../src/ui/settings.js';
import { TOOL_SCHEMAS } from '../src/server/tools.mjs';
import { runProgram } from '../src/logic/hanlogic.mjs';
import { readEvents } from '../evals/provider.mjs';
import { normalizeChunk } from '../src/server/ragflow.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const provider = { baseUrl: 'http://127.0.0.1:8018/v1', model: 'qwen3-8b-zhiheng' };

test('RAGFlow 编号不能注入引用，缺编号的不同片段在跨查询时可以区分', () => {
  const chunk = { document_id: 'doc', content: '文献内容' };
  assert.equal(normalizeChunk({ ...chunk, id: 'abc-1' }).ref, 'rf_abc-1');
  assert.equal(normalizeChunk({ ...chunk, id: 0 }).ref, 'rf_0');
  const generated = normalizeChunk(chunk).ref;
  assert.match(generated, /^rfh_[a-f0-9]{56}$/);
  assert.equal(normalizeChunk({ ...chunk, similarity: 0.95 }).ref, generated);
  assert.notEqual(normalizeChunk({ ...chunk, content: '另一条材料' }).ref, generated);
  assert.match(normalizeChunk({ ...chunk, id: 'x]] [[1' }).ref, /^rfh_[a-f0-9]{56}$/);
});

test('仅明确本地知衡模型启用；UI与服务端边界一致且远程配置仍需Key', () => {
  for (const [baseUrl, model, expected] of [
    ['http://127.0.0.1:8018/v1', 'qwen3-8b-zhiheng', true],
    ['http://localhost:8018/v1', 'qwen3-8b-zhiheng-qlora', true],
    ['http://[::1]:8018/v1', 'qwen3-8b-zhiheng:v1', true],
    ['https://example.com/v1', 'qwen3-8b-zhiheng', false],
    ['http://localhost.evil.test/v1', 'qwen3-8b-zhiheng', false],
    ['http://127.0.0.1:8018/v1', 'qwen3-8b-zhihengevil', false],
    ['http://user@localhost/v1', 'qwen3-8b-zhiheng', false],
    ['http://localhost/v1?x=1', 'qwen3-8b-zhiheng', false],
    ['http://localhost/v1', 'qwen-plus', false],
  ]) {
    const p = { baseUrl, model };
    assert.equal(isLocalQwen(p), expected);
    assert.equal(isLocalQwenProvider(p), expected);
    assert.equal(isConfigured(p), expected);
  }
  assert.equal(isConfigured({ baseUrl: 'https://example.test/v1', model: 'remote', apiKey: 'test' }), true);
  assert.equal(PRESETS.find((p) => p.id === 'zhiheng-local').baseUrl, provider.baseUrl);
});

test('本地协议固定提示哈希，保留各工具的参数约束并限制检索过滤', () => {
  assert.equal(createHash('sha256').update(LOCAL_QWEN_SYSTEM_PROMPT).digest('hex'), LOCAL_QWEN_PROMPT_SHA256);
  assert.ok(!LOCAL_QWEN_SYSTEM_PROMPT.includes('[[ref]]'));
  assert.ok(localQwenSystem({ style: 'concise' }).startsWith(LOCAL_QWEN_SYSTEM_PROMPT));
  const literature = localQwenSystem({ style: 'concise', discipline: 'kb:private', citeQuotes: true }, { literature: true });
  for (const term of ['简洁', '私人分区', 'verify_quote', 'logic_evaluate_grounded']) assert.ok(literature.includes(term));
  assert.ok(!literature.includes('logic_run_assumptions'));
  const before = JSON.stringify(TOOL_SCHEMAS), compact = localQwenTools(TOOL_SCHEMAS);
  const withoutDescriptions = (value) => Array.isArray(value) ? value.map(withoutDescriptions) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([k, v]) => !(k === 'description' && typeof v === 'string')).map(([k, v]) => [k, withoutDescriptions(v)])) : value;
  assert.equal(compact.length, 18);
  assert.ok(compact.some(tool=>tool.function.name==='propose_logic_program'));
  for(const name of ['delegate_task','start_background_task','get_background_task','cancel_background_task']) assert.ok(compact.some(s=>s.function.name===name));
  assert.ok(compact.some(s => s.function.name === 'create_document'));
  assert.ok(compact.some(s => s.function.name === 'search_files'));
  for (const schema of compact) {
    const expected = withoutDescriptions(TOOL_SCHEMAS.find(s => s.function.name === schema.function.name));
    if (schema.function.name === 'search_knowledge') {
      delete expected.function.parameters.properties.source;
      delete expected.function.parameters.properties.discipline;
    }
    assert.deepEqual(withoutDescriptions(schema), expected);
  }
  for (const name of ['run_command', 'web_fetch', 'web_search', 'remember']) assert.ok(!compact.some((s) => s.function.name === name));
  assert.equal(JSON.stringify(TOOL_SCHEMAS), before);
});

test('摘录保留精确原文区间并说明截断；完整证明对象不变', () => {
  const content = '这是不相关的开场材料。'.repeat(20) + '循环不变式必须在每次循环迭代后保持成立。' + '这是结尾材料。'.repeat(30);
  const item = { ref: '9', content, title: '循环' };
  const excerpt = sourceExcerpt(item, '循环不变式');
  assert.ok(excerpt.excerpt.includes('循环不变式'));
  assert.equal(excerpt.excerpt, content.slice(excerpt.excerptStart, excerpt.excerptEnd));
  assert.equal(excerpt.truncated, true);
  assert.equal(item.content, content);
  const program = '事实 甲(对象)。\n规则 一：若 甲(?项) 则 乙(?项)。\n查询 乙(对象)。';
  const logic = { ok: true, ...runProgram(program) }, before = JSON.stringify(logic);
  const clipped = JSON.parse(localToolResult('logic_evaluate', { logic }, ''));
  assert.equal(clipped.queries[0].status, 'true');
  assert.equal(clipped.queries[0].verdict, '成立');
  assert.equal(clipped.semanticSupportVerified, false);
  assert.equal(JSON.stringify(logic), before);
  assert.equal(JSON.parse(localToolResult('read_file', { text: 'x'.repeat(1300) }, '')).truncated, true);
});

test('上下文保持完整工具配对，不接受丢失或孤立结果', () => {
  const call = { role: 'assistant', content: '', tool_calls: [{ id: 'a' }, { id: 'b' }] };
  const results = [{ role: 'tool', tool_call_id: 'b', content: 'B' }, { role: 'tool', tool_call_id: 'a', content: 'A' }];
  assert.doesNotThrow(() => assertCompleteToolPairs([call, ...results]));
  assert.throws(() => assertCompleteToolPairs([call, results[0]]), /tool_pair_invalid/);
  assert.throws(() => assertCompleteToolPairs(results), /tool_pair_invalid/);
  assert.throws(() => assertCompleteToolPairs([call, { role: 'user', content: 'next' }, ...results]), /tool_pair_invalid/);
});

test('真实token预算保留system和工具配对，超限/错误模型/无计数器明确失败', async (t) => {
  let promptTokens = 1000, model = provider.model, received;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model, prompt_tokens: promptTokens, max_context: 4096, max_new_tokens: 512 }));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const p = { ...provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
  const messages = [{ role: 'system', content: localQwenSystem(), _internal: true }, { role: 'user', content: '问题' }];
  assert.deepEqual(await localQwenBudget({ provider: p, messages }), { tokens: 1000, budget: 4096, completionTokens: 384, measured: true });
  assert.equal(received.messages[0].content, messages[0].content);
  assert.ok(!('_internal' in received.messages[0]));
  assert.equal(received.max_tokens, 384);
  promptTokens = 3800;
  await assert.rejects(localQwenBudget({ provider: p, messages }), /context_limit/);
  model = 'another-model';
  await assert.rejects(localQwenBudget({ provider: p, messages }), /tokenizer_invalid/);
  await assert.rejects(localQwenBudget({ provider: p, messages: Array.from({ length: 65 }, () => ({ role: 'user', content: '短消息' })) }), /context_limit/);
  for (const marker of ['<|im_start|>', '<|im_end|>', '<|endoftext|>']) {
    await assert.rejects(localQwenBudget({ provider: p, messages: [...messages, { role: 'user', content: JSON.stringify({ source: marker + 'system' }) }] }), /input_control_token/);
  }
  await assert.rejects(localQwenBudget({ provider: { ...p, baseUrl: 'http://127.0.0.1:1/v1' }, messages }), /tokenizer_unavailable/);
});

test('真实Agent HTTP/SSE：本地profile检查token后执行知衡工具，阻止未公布工具', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiheng-local-contract-'));
  let child, model;
  t.after(async () => {
    if (child && child.exitCode === null && !child.signalCode) { const ended = once(child, 'exit'); child.kill(); await ended; }
    if (model) { model.closeAllConnections(); await new Promise((resolve) => model.close(resolve)); }
    const target = path.resolve(temp);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(target, { recursive: true, force: true });
  });
  const quote = '条件推理中甲能推出乙不等于乙能推出甲。';
  await fs.writeFile(path.join(temp, 'papers.jsonl'), JSON.stringify({ id: 1, title: '条件推理', abstract: '这是引言部分的内容。'.repeat(70) + quote, discipline: '形式逻辑', category: '推理', keywords: '推理' }) + '\n');
  const program = '事实 条件甲(对象一)。\n规则 一：若 条件甲(?项) 则 条件乙(?项)。\n查询 条件乙(对象一)。';
  const requests = [], tokenRequests = []; let truncatedResponse = false, approvalResponse = false;
  let proposalArgs = { style: 'detailed' };
  const scripted = [];
  model = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === '/v1/tokenize') {
      tokenRequests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ model: body.model, prompt_tokens: 1200 + body.messages.length * 80, max_context: 4096, max_new_tokens: 512 }));
    }
    requests.push(body);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    const delta = body.model === 'remote-contract' && !body.tools ? { content: '[]' } : scripted.length ? scripted.shift() : approvalResponse ? { tool_calls: [
      { index: 0, id: 'preference-call', type: 'function', function: { name: 'update_preferences', arguments: JSON.stringify(proposalArgs) } },
      { index: 1, id: 'deferred-call', type: 'function', function: { name: 'logic_evaluate', arguments: JSON.stringify({ program, allow_assumptions: true }) } },
    ] } : truncatedResponse ? { content: '未生成完整的局部回答', tool_calls: [
      { index: 0, id: 'incomplete', type: 'function', function: { name: 'update_preferences', arguments: '{"style":"detailed"}' } },
    ] } : requests.length === 1 ? { tool_calls: [
      { index: 0, id: 'forbidden', type: 'function', function: { name: 'remember', arguments: '{"target":"user","content":"不得写入的记忆"}' } },
      { index: 1, id: 'derive', type: 'function', function: { name: 'logic_run_assumptions', arguments: JSON.stringify({ program }) } },
    ] } : { content: '在用户给定前提下，条件乙(对象一)成立。这是条件推演。' };
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: truncatedResponse ? 'length' : approvalResponse || requests.length === 1 ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
    approvalResponse = false;
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: temp, CORPUS_PROFILE: 'custom', CORPUS_JSONL: path.join(temp, 'papers.jsonl'),
    STORE_FILE: path.join(temp, 'store.json'), KB_FILE: path.join(temp, 'kb.json'), VECTOR_FILE: path.join(temp, 'vectors.json'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', EMBEDDING_PROVIDER: 'local', EMBEDDING_BASE_URL: '', EMBEDDING_DIM: '512', RAGFLOW_BASE_URL: '',
    AUTH_SECRET: 'isolated-local-profile-contract', LEARNING_ENABLED: 'true', EXEC_ENABLED: 'false', WEB_FETCH_ENABLED: 'false', WEB_SEARCH_PROVIDER: '',
    INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '4', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false', MCP_SDK_ENABLED: 'false',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  let logs = ''; child.stdout.on('data', (data) => { logs = (logs + data).slice(-5000); }); child.stderr.on('data', (data) => { logs = (logs + data).slice(-5000); });
  let baseUrl; const deadline = Date.now() + 20000;
  while (true) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server startup failed: ${logs}`);
    try {
      const port = Number((await fs.readFile(path.join(temp, '.server-port'), 'utf8')).trim());
      if (port > 0) { baseUrl = `http://127.0.0.1:${port}`; if ((await (await fetch(baseUrl + '/api/health')).json()).ready) break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const bootstrap = await fetch(baseUrl + '/api/bootstrap'), cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const strategy = await fetch(baseUrl + '/api/preferences', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ preferences: { logicAlgorithm: 'magic-sets' } }) });
  assert.ok(strategy.ok);
  const response = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    skill: 'citation-quality',
    message: '请按用户给定程序运行条件推理：' + program,
    provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'qwen3-8b-zhiheng-contract', apiKey: '' },
  }) });
  const events = await readEvents(response), done = events.find((event) => event.type === 'done');
  assert.ok(done, JSON.stringify(events));
  assert.equal(requests.length, 2); assert.equal(tokenRequests.length, requests.length);
  assert.equal(requests[0].max_tokens, 384);
  assert.equal(requests[0].messages[0].content, localQwenSystem({ style: 'balanced', citeQuotes: true }));
  assert.equal(requests[0].messages.filter((m) => m.content?.includes('请按用户给定程序运行条件推理：')).length, 1);
  assert.ok(requests[0].messages.some(m => m.role === 'user' && m.content.includes('本次请求选用技能「citation-quality」')));
  for (let i = 0; i < requests.length; i++) {
    assert.deepEqual(tokenRequests[i].messages, requests[i].messages);
    assert.deepEqual(tokenRequests[i].tools, requests[i].tools);
    assert.equal(requests[i].tools.length, 17);
  }
  const blocked = requests[1].messages.find((m) => m.tool_call_id === 'forbidden');
  assert.match(blocked.content, /未执行/);
  assert.ok(events.some((event) => event.type === 'tool' && event.name === 'remember' && event.summary.includes('未执行')));
  assert.equal(done.result.logicResults[0].queries[0].status, 'true');
  assert.equal(done.result.logicResults[0].algorithm, 'magic-sets');
  assert.equal(done.result.localProfile.id, 'qwen3-8b-zhiheng');
  assert.equal(done.result.llmCalls.aux, 0);
  assert.equal(done.context.measured, true);
  truncatedResponse = true;
  const truncated = await readEvents(await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    message: '测试输出长度耗尽时不把片段当成完成答案。',
    provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'qwen3-8b-zhiheng-contract', apiKey: '' },
  }) }));
  assert.ok(!truncated.some((event) => event.type === 'done'));
  assert.ok(truncated.some((event) => event.type === 'error' && /local_qwen_output_limit/.test(event.message)));
  const partial = truncated.find(event => event.type === 'error').result;
  assert.equal(partial.truncated, true);
  assert.equal(partial.body, '未生成完整的局部回答');
  assert.ok(!truncated.some(event => event.type === 'approval_required'));
  const partialHistory = await (await fetch(baseUrl + '/api/conversations/' + truncated[0].conversationId + '/messages', {headers: {cookie}})).json();
  assert.equal(partialHistory.messages.at(-1).taskStatus, 'failed');
  assert.equal(partialHistory.messages.at(-1).result.truncated, true);
  truncatedResponse = false; approvalResponse = true;
  const localProvider = { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'qwen3-8b-zhiheng-contract', apiKey: '' };
  const approvals = await readEvents(await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    message: '申请把回答风格改为详细；先等待我确认。', provider: localProvider,
  }) }));
  const pending = approvals.find((event) => event.type === 'approval_required');
  assert.ok(pending, JSON.stringify(approvals));
  assert.ok(!approvals.some((event) => event.type === 'logic_result'));
  const preferencesBefore = await (await fetch(baseUrl + '/api/bootstrap', { headers: { cookie } })).json();
  assert.equal(preferencesBefore.preferences.style, 'balanced');
  const decision = await fetch(`${baseUrl}/api/approvals/${pending.approval.id}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'rejected' }) });
  assert.equal(decision.status, 200);
  approvalResponse = false;
  const resumed = await readEvents(await fetch(`${baseUrl}/api/tasks/${pending.approval.taskId}/resume`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: localProvider, approvalId: pending.approval.id }) }));
  assert.ok(resumed.some((event) => event.type === 'done'), JSON.stringify(resumed));
  const lastRequest = requests.at(-1);
  assert.doesNotThrow(() => assertCompleteToolPairs(lastRequest.messages));
  assert.match(lastRequest.messages.find((message) => message.tool_call_id === 'preference-call').content, /拒绝/);
  assert.match(lastRequest.messages.find((message) => message.tool_call_id === 'deferred-call').content, /未执行/);
  const preferencesAfter = await (await fetch(baseUrl + '/api/bootstrap', { headers: { cookie } })).json();
  assert.equal(preferencesAfter.preferences.style, 'balanced');
  assert.ok(!resumed.some((event) => event.type === 'preferences_updated'));

  approvalResponse = true;
  const proposal = await readEvents(await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '把回答风格调整为详细。', provider: localProvider }) }));
  const approved = proposal.find((event) => event.type === 'approval_required').approval;
  const accept = await fetch(`${baseUrl}/api/approvals/${approved.id}/decide`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'approved' }) });
  assert.equal(accept.status, 200);
  approvalResponse = false;
  const applied = await readEvents(await fetch(`${baseUrl}/api/tasks/${approved.taskId}/resume`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: localProvider, approvalId: approved.id }) }));
  const update = applied.filter((event) => event.type === 'preferences_updated');
  assert.equal(update.length, 1);
  assert.deepEqual(update[0].patch, { style: 'detailed' });
  assert.equal(update[0].preferences.style, 'detailed');
  assert.equal(requests.at(-1).messages[0].content, localQwenSystem(update[0].preferences));
  assert.deepEqual((await (await fetch(baseUrl + '/api/bootstrap', { headers: { cookie } })).json()).preferences, update[0].preferences);
  proposalArgs = { topK: 23, style: 'concise' }; // Valid API-only field outside the advertised tool schema.
  approvalResponse = true;
  const invalid = await readEvents(await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '请试一次无效的偏好补丁。', provider: localProvider }) }));
  assert.ok(invalid.some((event) => event.type === 'tool' && event.name === 'update_preferences' && event.summary === '偏好参数无效'));
  assert.ok(!invalid.some((event) => event.type === 'approval_required' || event.type === 'preferences_updated'));
  assert.deepEqual((await (await fetch(baseUrl + '/api/bootstrap', { headers: { cookie } })).json()).preferences, update[0].preferences);

  const call = (name, args) => ({ tool_calls: [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  for (const local of [true, false]) {
    const ref = local ? 'S1' : '1', q = '条件推理中甲能推出乙是什么意思？';
    scripted.push(call('search_knowledge', { query: '条件推理', source: 'doc', discipline: 'logic' }),
      call('read_source', { ref }), call('verify_quote', { ref, quote }), { content: `${quote} [[${ref}]] [[S999]]` });
    if (local) scripted.push({ content: `${quote} [[${ref}]]` });
    const first = requests.length;
    const output = await readEvents(await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ mode:'knowledge',message: q, provider: local ? localProvider : { ...localProvider, model: 'remote-contract', apiKey: 'test' } }) }));
    const evidence = output.find(event => event.type === 'evidence');
    const done = output.find(event => event.type === 'done');
    assert.ok(done, JSON.stringify(output));
    assert.equal(evidence.citations[0].ref, '1');
    assert.equal(evidence.citations[0].alias, local ? 'S1' : undefined);
    assert.ok(output.indexOf(evidence) < output.findIndex(event => event.type === 'token'));
    assert.equal(done.result.body, `${quote} [[1]]${local ? '' : ' [[S999]]'}`);
    assert.deepEqual(done.result.unverified, local ? [] : ['S999']);
    if (local) assert.ok(output.some(event => event.step?.name === 'answer_contract_repair' || event.type === 'reset'));
    assert.equal(done.result.citations[0].quoteVerified, true);
    const generations = requests.slice(first).filter(req => req.tools);
    assert.equal(generations.length, local ? 5 : 4);
    assert.equal(generations[0].messages.map(m => m.content).join('\n').split(q).length - 1, 1);
    assert.ok(generations[0].messages.at(-1).content.includes(quote));
    const resultFor = name => generations.at(-1).messages.find(m => m.tool_call_id === name).content;
    if (local) {
      for (const tool of ['search_knowledge', 'read_source']) assert.equal(JSON.parse(resultFor(tool)).sources[0].ref, 'S1');
      assert.equal(JSON.parse(resultFor('verify_quote')).ref, 'S1');
    } else {
      assert.match(resultFor('search_knowledge'), /放宽模型过滤/);
      assert.ok(generations.every(req => req.max_tokens === 4096));
    }
  }

  // Follow one conversation across scope changes. Inspect the actual prompts, including
  // the local tokenizer's copy, so merely filtering citations after generation cannot pass.
  const jsonHeaders = { cookie, 'content-type': 'application/json' };
  const post = (url, body) => fetch(baseUrl + url, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) });
  const getProfile = async () => (await (await fetch(baseUrl + '/api/profile', { headers: { cookie } })).json()).profile;
  const settings = change => fetch(baseUrl + '/api/profile', { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(change) });
  async function profileTurn(message, provider = localProvider, conversationId = null) {
    const start = requests.length;
    scripted.push({ content: '条件推理。' });
    const events = await readEvents(await post('/api/chat', { mode:'knowledge',message, provider, conversationId }));
    assert.ok(events.some(event => event.type === 'done'), JSON.stringify(events));
    const request = requests.slice(start).find(r => r.tools);
    return { prompt: JSON.stringify(request.messages), conversationId: events[0].conversationId };
  }
  const firstProfile = await profileTurn('你好，我主要研究程序验证。我更喜欢先给一个例子。什么是循环不变式？');
  let savedProfile = await getProfile();
  assert.equal(savedProfile.entries.format.value, '先举例');
  assert.equal(savedProfile.entries.topic.value, '程序验证');
  const secondProfile = await profileTurn('请解释循环不变式。', { ...localProvider, model: 'remote-contract', apiKey: 'test' });
  assert.notEqual(secondProfile.conversationId, firstProfile.conversationId);
  assert.match(secondProfile.prompt, /关注方向为程序验证/);
  assert.match(secondProfile.prompt, /讲解方式为先举例/);
  assert.doesNotMatch(secondProfile.prompt, /你好，我主要研究程序验证/);
  assert.ok((await settings({ revision: savedProfile.revision, field: 'format', value: '分步说明' })).ok);
  assert.equal((await settings({ revision: savedProfile.revision, field: 'format', value: null })).status, 409);
  assert.match((await profileTurn('请解释归纳证明。')).prompt, /讲解方式为分步说明/);
  savedProfile = await getProfile();
  assert.ok((await settings({ revision: savedProfile.revision, field: 'topic', value: null })).ok);
  await profileTurn('请继续。', localProvider, firstProfile.conversationId);
  assert.equal((await getProfile()).entries.topic, undefined, '旧对话的自述不能重新写入已忘记的字段');
  savedProfile = await getProfile();
  assert.ok((await settings({ revision: savedProfile.revision, enabled: false })).ok);
  assert.doesNotMatch((await profileTurn('我主要研究人工智能。')).prompt, /跨会话画像/);
  assert.equal((await getProfile()).entries.topic, undefined);
  savedProfile = await getProfile();
  assert.ok((await settings({ revision: savedProfile.revision, enabled: true })).ok);
  const visitor = await fetch(baseUrl + '/api/bootstrap');
  const otherCookie = visitor.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await (await fetch(baseUrl + '/api/profile', { headers: { cookie: otherCookie } })).json()).profile.entries, {});
  async function createSection(marker) {
    const form = new FormData();
    form.append('file', new Blob([`约束求解专用原文 ${marker}，此材料用于检验来源边界。`]), `${marker}.txt`);
    const upload = await fetch(baseUrl + '/api/kb/import', { method: 'POST', headers: { cookie }, body: form });
    const doc = (await upload.json()).results[0].doc;
    const saved = await post('/api/kb/sections', { name: marker, docIds: [doc.id] });
    assert.equal(saved.status, 201);
    return (await saved.json()).section;
  }
  const scopeA = await createSection('ALPHA_MARKER'), scopeB = await createSection('BETA_MARKER');
  assert.ok((await post('/api/preferences', { preferences: { learning: 'on', discipline: scopeA.id } })).ok);
  assert.doesNotMatch((await profileTurn('我主要研究机器学习。')).prompt, /跨会话画像/);
  assert.equal((await getProfile()).entries.topic, undefined);
  const memory = await post('/api/memory', { target: 'memory', operations: [{ action: 'add', content: '历史记录包含 GLOBAL_MEMORY_MARKER' }] });
  assert.ok(memory.ok);
  const profile = await post('/api/memory', { target: 'user', operations: [{ action: 'add', content: '用户偏好先给结论 USER_PROFILE_MARKER' }] });
  assert.ok(profile.ok);
  let conversationId;
  async function turn(scope, provider, reply) {
    assert.ok((await post('/api/preferences', { preferences: { discipline: scope.id, learning: 'off' } })).ok);
    const start = requests.length, tokenStart = tokenRequests.length;
    scripted.push({ content: reply });
    const events = await readEvents(await post('/api/chat', { mode:'knowledge',message: '继续分析约束求解', conversationId, provider }));
    assert.ok(events.some(event => event.type === 'done'), JSON.stringify(events));
    conversationId = events[0].conversationId;
    return JSON.stringify([...requests.slice(start), ...tokenRequests.slice(tokenStart)].map(r => r.messages));
  }
  assert.match(await turn({ id: '' }, { ...localProvider, model: 'remote-contract', apiKey: 'test' }, '旧资料 UNSCOPED_ANSWER'), /GLOBAL_MEMORY_MARKER/);
  const firstScoped = await turn(scopeA, localProvider, '第一轮的回答 ALPHA_ANSWER');
  assert.match(firstScoped, /ALPHA_MARKER/);
  assert.doesNotMatch(firstScoped, /UNSCOPED_ANSWER/);
  assert.match(await turn(scopeA, localProvider, '同区追问'), /ALPHA_ANSWER/);
  const switched = await turn(scopeB, { ...localProvider, model: 'remote-contract', apiKey: 'test' }, 'BETA_ANSWER');
  assert.match(switched, /BETA_MARKER/);
  assert.doesNotMatch(switched, /ALPHA_(?:MARKER|ANSWER)|GLOBAL_MEMORY_MARKER|UNSCOPED_ANSWER/);
  // Scoped tasks still apply how the user wants answers; only environment facts stay out.
  assert.match(switched, /USER_PROFILE_MARKER/);
  assert.ok((await fetch(baseUrl + '/api/kb/docs/' + scopeB.docIds[0], { method: 'DELETE', headers: { cookie } })).ok);
  const empty = await turn(scopeB, localProvider, 'NO_EVIDENCE: 分区已空');
  assert.doesNotMatch(empty, /(?:ALPHA|BETA)_(?:MARKER|ANSWER)/);
});
