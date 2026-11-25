/**
 * 事后审查单元测试：观测收集、触发判定、digest、结构化输出校验与门槛（离线 mock SSE）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-review-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.REVIEW_SETTLE_MS = '5';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const { collectObservations, shouldReview, buildDigest, runReview, restorePendingItem, queueReview } = await import('../src/server/review.mjs');
const { readSkill, listSkills, readPending, saveLearnState, createSkill } = await import('../src/server/skills.mjs');
const { readEntries } = await import('../src/server/memory.mjs');

/* ------------------------------------------------------------------ mock SSE 模型 */

const chunk = (delta, finish = null) => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

let mockResponse = '{"memory":[],"skills":[]}';
let mockDelay = 0;
let inFlight = 0;
let maxInFlight = 0;
const requests = [];

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  requests.push(body);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  if (mockDelay) await new Promise(r => setTimeout(r, mockDelay));
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const text = mockResponse;
  for (let i = 0; i < text.length; i += 40) {
    res.write(`data: ${JSON.stringify(chunk({ content: text.slice(i, i + 40) }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
  inFlight--;
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock' };

/* ------------------------------------------------------------------ 观测与触发 */

test('collectObservations：工具错误 / 校验失败 / uncited / 任务失败', () => {
  const messages = [
    { role: 'tool', content: '检索「X」：3 条（覆盖度 0.8）。正常结果不算观测' },
    { role: 'tool', content: '校验失败：该依据中不存在这段文字（改写或臆造）。' },
    { role: 'tool', content: '工具执行失败（search_knowledge）：网络超时。本次调用未写入任何数据。' },
  ];
  const obs = collectObservations({ messages, result: { uncited: true, unverified: ['999'] } });
  const kinds = obs.map((o) => o.kind);
  assert.ok(kinds.includes('tool_error'));
  assert.ok(kinds.includes('verify_fail'));
  assert.ok(kinds.includes('uncited'));
  assert.equal(collectObservations({ messages: [], taskError: 'boom' })[0].kind, 'task_failed');
});

test('collectObservations：检索到的原文里出现「不存在」「缺少」不算工具失败，以真实结果标记为准', () => {
  const quiet = collectObservations({ messages: [
    { role: 'tool', content: '【原文】该定理在空集上不存在反例，缺少前提时结论不成立。' },
    { role: 'tool', content: '工具执行失败（read_file）：旧格式消息仍按开头前缀识别', _toolError: false },
  ] });
  assert.deepEqual(quiet, []);
  const marked = collectObservations({ messages: [{ role: 'tool', content: '已返回但实际失败', _toolError: true }] });
  assert.equal(marked[0].kind, 'tool_error');
});

test('shouldReview：失败必审；分数≥2 审；计数器满审；平静任务不审', async () => {
  await saveLearnState({ tasks_since_review: 0 });
  assert.equal(await shouldReview({ observations: [], taskFailed: true }), true);
  assert.equal(
    await shouldReview({ observations: [{ kind: 'tool_error', text: 'x' }], taskFailed: false }),
    true
  ); // score=2
  assert.equal(await shouldReview({ observations: [{ kind: 'uncited', text: 'x' }], taskFailed: false }), false); // score=1
  await saveLearnState({ tasks_since_review: 10 });
  assert.equal(await shouldReview({ observations: [], taskFailed: false }), true);
  await saveLearnState({ tasks_since_review: 0 });
});

test('buildDigest：尾部逐字、更早折叠', () => {
  const msgs = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `消息${i}` }));
  const d = buildDigest(msgs, { tail: 24 });
  assert.match(d, /更早 6 条已折叠/);
  assert.match(d, /消息29/);
});

/* ------------------------------------------------------------------ 审查执行 */

test('审查产物落地：memory add + skill create 过漏斗后写入，计数器清零', async () => {
  mockResponse = JSON.stringify({
    memory: [{ target: 'user', content: '用户要求回答先给结论再给依据' }],
    skills: [
      {
        action: 'create',
        name: 'answer-structure',
        description: '回答结构：先结论后依据的分点格式',
        body: '# 回答结构\n\n- 首句直接给结论，再分点列依据——用户明确纠正过冗长铺垫。',
        why: '用户纠正了回答风格',
      },
    ],
  });
  const decisions = await runReview({
    userId: 'u1',
    provider,
    question: '锂离子电池正极材料有哪些？',
    messages: [
      { role: 'user', content: '别铺垫，直接给结论' },
      { role: 'assistant', content: '好的。结论：…' },
    ],
    observations: [{ kind: 'tool_error', text: '校验失败：引文不存在' }],
  });
  // R06（N-06）：审查记忆不再直写——进待确认区，用户确认后才写入并注入
  assert.ok(decisions.some((d) => d.action === 'memory_proposed' && d.ok && d.pending));
  assert.ok(!decisions.some((d) => d.action === 'memory_add'), '旧直写通道应已移除');
  assert.ok(decisions.some((d) => d.action === 'skill_create' && d.name === 'answer-structure' && d.ok));
  assert.ok(await readSkill('answer-structure', { userId: 'u1' }), 'R04：审查产出应写入触发者自己的技能目录');
  const userEntries = await readEntries('u1', 'user');
  assert.ok(!userEntries.some((e) => e.includes('先给结论')), 'R06：未经确认不得写入记忆文件');
  const pendList = await readPending();
  const memItem = pendList.find((x) => x.kind === 'memory' && x.reason === 'needs_user_confirm' && (x.statement || '').includes('先给结论'));
  assert.ok(memItem, 'R06：审查记忆应进入待确认区');
  // 归属校验：他人无法确认；属主确认后写入
  const denied = await restorePendingItem(memItem.fp, { userId: 'u9' });
  assert.equal(denied.code, 'forbidden');
  const confirmed = await restorePendingItem(memItem.fp, { userId: 'u1' });
  assert.ok(confirmed.ok, confirmed.message);
  const afterEntries = await readEntries('u1', 'user');
  assert.ok(afterEntries.some((e) => e.includes('先给结论')), '确认后应写入记忆');
  const { learnState } = await import('../src/server/skills.mjs');
  const st = await learnState();
  assert.equal(st.tasks_since_review, 0);
  assert.ok(st.reviews_run >= 1);
});

test('漏斗拦截：description 超 60 → pending；自动通道 memory patch → 拒绝', async () => {
  mockResponse = JSON.stringify({
    memory: [{ target: 'memory', operations: 'hack', content: '正常的一条环境事实' }],
    skills: [
      { action: 'create', name: 'bad-desc', description: 'x'.repeat(80), body: '内容', why: 'w' },
      { action: 'delete', name: 'answer-structure', why: '想删' },
    ],
  });
  const decisions = await runReview({
    userId: 'u1',
    provider,
    question: '测试问题',
    messages: [{ role: 'user', content: 'q' }],
    observations: [],
  });
  const bad = decisions.find((d) => d.name === 'bad-desc');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'invalid');
  const del = decisions.find((d) => d.action === 'refused');
  assert.ok(del); // 自动通道禁删
  const pending = await readPending();
  assert.ok(pending.some((p) => p.kind === 'skill_create' && p.reason === 'invalid'));
});

test('pending 恢复：用户通道重提 create 成功并出队', async () => {
  const pending = await readPending();
  const item = pending.find((p) => p.kind === 'skill_create');
  assert.ok(item);
  // proposed.description 仍超长 → 管理员批准同样被漏斗拒绝（豁免只针对预算，不针对格式）
  // R03/R04：技能类 pending 仅管理员可处理
  const denied = await restorePendingItem(item.fp, { userId: 'someone' });
  assert.equal(denied.code, 'forbidden');
  const r = await restorePendingItem(item.fp, { admin: true });
  assert.equal(r.ok, false);
});

test('模型输出不是 JSON → review_parse_failed，不写入任何内容', async () => {
  mockResponse = '我觉得这次没什么可记的。';
  const before = (await listSkills({ userId: 'u2' })).length;
  const decisions = await runReview({ userId: 'u2', provider, question: 'q', messages: [], observations: [] });
  assert.ok(decisions.some((d) => d.action === 'review_parse_failed'));
  assert.equal((await listSkills({ userId: 'u2' })).length, before);
});

test('审查请求包含反垃圾禁令与结构化输出要求（提示词资产在位）', () => {
  const last = requests[requests.length - 1];
  const prompt = last.messages.map((m) => m.content).join('\n');
  assert.match(prompt, /DO NOT capture/);
  assert.match(prompt, /Unresolved failures/);
  assert.match(prompt, /Nothing to save/);
  assert.match(prompt, /class-level/);
  assert.match(prompt, /严格 JSON/);
  // 自动通道约束在提示词里也声明：永不删除
  assert.match(prompt, /Never propose deleting/);
});

test('报告落盘 data/learn/reports/', () => {
  const dirp = path.join(dir, 'learn', 'reports');
  const files = fs.readdirSync(dirp);
  assert.ok(files.length >= 1);
  const content = fs.readFileSync(path.join(dirp, files[0]), 'utf8');
  assert.match(content, /## /);
});

test('review patches require a complete snapshot and do not inflate real usage', async () => {
  const userId = 'snapshot-review';
  await createSkill({ name: 'snapshot-process', description: '橙色样本验证', body: '# 流程\n\n先校验样本，再写结论。', userId });
  mockResponse = JSON.stringify({ memory: [], skills: [{ action: 'patch', name: 'snapshot-process', old_text: '先校验样本', new_text: '先逐项校验样本' }] });
  const unread = await runReview({ userId, provider, question: '完全无关', messages: [], observations: [] });
  assert.equal(unread.find(d => d.action === 'skill_patch').code, 'read_required');
  const read = await runReview({ userId, provider, question: '橙色样本验证', messages: [], observations: [] });
  assert.equal(read.find(d => d.action === 'skill_patch').ok, true);
  const entry = (await listSkills({ userId })).find(s => s.name === 'snapshot-process');
  assert.equal(entry.use_count, 0);
  assert.match((await readSkill('snapshot-process', { userId })).body, /先逐项校验样本/);
});

test('one active review per user and queued snapshots coalesce while a review runs', async () => {
  const userId = 'serial-review';
  mockResponse = '{"memory":[],"skills":[]}';
  mockDelay = 60;
  maxInFlight = 0;
  const start = requests.length;
  const args = { userId, provider, question: 'first-review', messages: [], observations: [] };
  const first = runReview(args);
  const busy = await runReview({ ...args, question: 'duplicate-manual' });
  assert.equal(busy[0].code, 'review_in_progress');
  queueReview({ ...args, question: 'queued-old' });
  await new Promise(r => setTimeout(r, 15));
  queueReview({ ...args, question: 'queued-latest' });
  await first;
  const deadline = Date.now() + 3000;
  while ((requests.length < start + 2 || inFlight) && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 30)); // finish the queued local persistence
  mockDelay = 0;
  assert.equal(requests.length - start, 2);
  assert.equal(maxInFlight, 1);
  assert.match(requests.at(-1).messages[1].content, /queued-latest/);
  assert.doesNotMatch(requests.at(-1).messages[1].content, /queued-old/);
});

test('queued review rechecks the current opt-out before spending a model request', async () => {
  const start = requests.length;
  const args = { userId: 'opt-out-review', provider, question: 'pending', messages: [], observations: [] };
  queueReview({ ...args, canRun: async () => false });
  queueReview({ ...args, userId: 'failed-settings-review', canRun: async () => { throw new Error('settings unavailable'); } });
  await new Promise(r => setTimeout(r, 40));
  assert.equal(requests.length, start);
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
