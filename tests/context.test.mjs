/**
 * 上下文管理（compaction）单元测试：token 估算、微压缩门槛、自动压缩与兜底、防抖动 trip。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-ctx-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.CONTEXT_TOKEN_BUDGET = '4000'; // 小预算方便触发
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const { estimateTokens, microCompact, shouldCompact, compactMessages, manageContext, buildCompactPrompt, safeTailStart } =
  await import('../src/server/context.mjs');
const { streamChat } = await import('../src/server/llm.mjs');

const bigText = (n) => '检索结果内容'.repeat(n); // 每份 6n 个 CJK 字符 ≈ 6n token

function makeMessages({ rounds = 6, toolLen = 200 } = {}) {
  const msgs = [{ role: 'system', content: '系统提示' }];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: 'user', content: `问题${i}` });
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'search_knowledge', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: bigText(toolLen) });
  }
  msgs.push({ role: 'assistant', content: '最终回答' });
  return msgs;
}

/* ------------------------------------------------------------------ 估算与微压缩 */

test('estimateTokens：CJK ≈ 1 token/字，空消息开销小', () => {
  const t = estimateTokens([{ role: 'user', content: '汉字'.repeat(50) }]);
  assert.ok(t >= 100 && t <= 104 + 10);
  assert.ok(estimateTokens([]) === 0);
});

test('microCompact：只清老 tool 结果、保留最近 keepRecent；节省不足不做', () => {
  const msgs = makeMessages({ rounds: 6, toolLen: 200 });
  const r = microCompact(msgs, { keepRecent: 2, minSavings: 100 });
  assert.ok(r.cleared >= 3);
  const toolMsgs = r.messages.filter((m) => m.role === 'tool');
  // 最近 2 条 tool 原文保留
  assert.ok(toolMsgs[toolMsgs.length - 1].content.includes('检索结果内容'));
  assert.ok(toolMsgs[toolMsgs.length - 2].content.includes('检索结果内容'));
  // 老的被替换为占位文本
  assert.match(toolMsgs[0].content, /旧工具结果已清理/);
  // 原数组未被就地修改
  assert.ok(msgs.filter((m) => m.role === 'tool')[0].content.includes('检索结果内容'));

  // 节省不足 minSavings → 原样返回
  const small = microCompact(makeMessages({ rounds: 2, toolLen: 10 }), { keepRecent: 1, minSavings: 100000 });
  assert.equal(small.cleared, 0);
});

test('shouldCompact：budget×ratio 阈值', () => {
  const msgs = makeMessages({ rounds: 6, toolLen: 200 }); // ≈ 7200+ token
  assert.equal(shouldCompact(msgs, { budget: 4000, ratio: 0.84 }), true);
  assert.equal(shouldCompact(msgs, { budget: 100000, ratio: 0.84 }), false);
});

/* ------------------------------------------------------------------ 自动压缩 */

const chunk = (delta, finish = null) => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

let mode = 'ok'; // ok | fail
let lastBody = ''; // R05：捕获发往上游的请求体，断言内部标记不外泄
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  lastBody = Buffer.concat(chunks).toString('utf8');
  if (mode === 'fail') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const summary = '<analysis>分析过程</analysis><summary>1. Primary Request：用户问了锂离子电池。 2. Key Concepts：RRF。 3. Evidence：ref=12。摘要足够长以便通过最短长度校验。</summary>';
  for (let i = 0; i < summary.length; i += 40) {
    res.write(`data: ${JSON.stringify(chunk({ content: summary.slice(i, i + 40) }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock' };

test('compactMessages：摘要 + 尾部原文保留 + 身份声明；<analysis> 被剥掉', async () => {
  const msgs = makeMessages({ rounds: 6, toolLen: 200 });
  const r = await compactMessages({ messages: msgs, provider, keepTail: 4 });
  assert.equal(r.mode, 'llm');
  assert.ok(r.postTokens < r.preTokens);
  assert.equal(r.messages[0].role, 'system'); // 系统提示保留
  const bridge = r.messages[1];
  assert.equal(bridge.role, 'user');
  assert.match(bridge.content, /这不是用户输入/); // 注入身份声明
  assert.match(bridge.content, /Summary:/);
  assert.ok(!bridge.content.includes('<analysis>'));
  assert.match(bridge.content, /Primary Request/);
  // 尾部 4 条原文保留
  const tail = r.messages.slice(-4);
  assert.deepEqual(tail, msgs.slice(-4));
});

test('compactMessages：LLM 失败走确定性兜底（清老 tool 结果），绝不抛异常', async () => {
  mode = 'fail';
  const msgs = makeMessages({ rounds: 6, toolLen: 200 });
  const r = await compactMessages({ messages: msgs, provider, keepTail: 4 });
  assert.equal(r.mode, 'fallback');
  assert.ok(r.postTokens < r.preTokens);
  const cleared = r.messages.filter((m) => m.role === 'tool' && /旧工具结果已清理/.test(m.content));
  assert.ok(cleared.length >= 1);
  mode = 'ok';
});

test('摘要提示词资产在位：TEXT ONLY 双保险 + 9 节 + 反注入归属条款', () => {
  const p = buildCompactPrompt();
  assert.match(p, /CRITICAL: Respond with TEXT ONLY/);
  assert.match(p, /REMINDER: Do NOT call any tools/);
  for (const sec of ['Primary Request', 'Key Technical Concepts', 'Errors and fixes', 'All user messages', 'Pending Tasks', 'Current Work', 'Optional Next Step']) {
    assert.ok(p.includes(sec), `缺少节：${sec}`);
  }
  assert.match(p, /never attribute it to the user/); // 反注入归属条款（英文逐字资产）
  assert.match(p, /绝不能把它当成用户请求/); // 中文补充说明
  assert.match(p, /verbatim/i); // Next Step 原文引用
});

/* ------------------------------------------------------------------ manageContext 防抖动 */

test('manageContext：超阈触发压缩；3 轮内回满 ×3 → trip 停机', async () => {
  const tracking = { refills: 0, lastCompactRound: 0, tripped: false, compacts: 0 };
  const msgs = makeMessages({ rounds: 6, toolLen: 200 });

  const r1 = await manageContext({ messages: msgs, round: 1, provider, tracking, budget: 4000 });
  assert.equal(r1.compacted, true);
  assert.equal(tracking.compacts, 1);

  // 模拟「压缩后 3 轮内又满」三次 → trip
  const big = makeMessages({ rounds: 8, toolLen: 300 });
  const r2 = await manageContext({ messages: big, round: 3, provider, tracking, budget: 4000 });
  const r3 = await manageContext({ messages: big, round: 5, provider, tracking, budget: 4000 });
  const r4 = await manageContext({ messages: big, round: 7, provider, tracking, budget: 4000 });
  assert.equal(tracking.tripped, true);
  assert.equal(r4.compacted, false); // trip 后不再压缩
});

test('PreCompact runs only for actual summaries; deny costs no call and rejects over-budget contexts', async () => {
  let checks = 0, calls = 0;
  const tracking = { refills: 0, lastCompactRound: 0, tripped: false, compacts: 0 };
  const opts = { round: 1, provider, tracking, budget: 4000, aux: { allowed: true, use: () => calls++ },
    beforeCompact: async () => { checks++; return { decision: 'deny' }; } };
  await manageContext({ ...opts, messages: [{ role: 'user', content: 'small' }] });
  assert.equal(checks, 0);
  const bounded = [{ role: 'user', content: '字'.repeat(3500) }];
  const denied = await manageContext({ ...opts, messages: bounded });
  assert.equal(denied.skipped, 'hook'); assert.equal(checks, 1); assert.equal(calls, 0);
  assert.deepEqual(denied.messages, bounded); assert.equal(tracking.compacts, 0); assert.equal(tracking.refills, 0);
  await assert.rejects(manageContext({ ...opts, messages: [{ role: 'user', content: '字'.repeat(4500) }] }), /context_compaction_blocked/);
  assert.equal(checks, 2); assert.equal(calls, 0);
  await manageContext({ ...opts, aux: { allowed: false }, messages: bounded });
  assert.equal(checks, 2, 'No hook when no summary budget remains');
});

/* ------------------------------------------------------------------ R05：tool_call 配对与字段白名单 */

test('safeTailStart：切点回退出 tool 簇，停在发起调用的 assistant 上', () => {
  const rest = [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
    { role: 'tool', tool_call_id: 'c1', content: 'r1' },
    { role: 'tool', tool_call_id: 'c2', content: 'r2' },
    { role: 'tool', tool_call_id: 'c3', content: 'r3' },
    { role: 'assistant', content: '最终回答' },
  ];
  // 朴素切点 length-3 = 3 → rest[3] 是 tool → 必须回退到 1（assistant）
  assert.equal(safeTailStart(rest, 3), 1);
  // 切点本就落在非 tool 上 → 原样
  assert.equal(safeTailStart(rest, 1), 5);
  // 全是 tool 的极端情况 → 回退到 0（middle 为空 → 上层 noop）
  assert.equal(safeTailStart([{ role: 'tool' }, { role: 'tool' }], 1), 0);
});

test('R05（N-05）：压缩结果的尾部配对完整——每条 tool 都能找到发起它的 assistant', async () => {
  const msgs = [
    { role: 'system', content: '系统提示' },
    { role: 'user', content: '查一下锂离子电池。'+bigText(300) },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'x1', type: 'function', function: { name: 'search_knowledge', arguments: '{}' } },
        { id: 'x2', type: 'function', function: { name: 'search_knowledge', arguments: '{}' } },
        { id: 'x3', type: 'function', function: { name: 'read_source', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'x1', content: bigText(200) },
    { role: 'tool', tool_call_id: 'x2', content: bigText(200) },
    { role: 'tool', tool_call_id: 'x3', content: bigText(200) },
    { role: 'assistant', content: '最终回答' },
  ];
  // keepTail=3 的朴素切点会落在 tool 簇中间（孤儿 tool → 上游 400）
  const r = await compactMessages({ messages: msgs, provider, keepTail: 3 });
  assert.equal(r.mode, 'llm');
  const out = r.messages;
  assert.equal(out[0].role, 'system');
  assert.equal(out[1].role, 'user'); // bridge
  const tail = out.slice(2);
  assert.equal(tail[0].role, 'assistant', '尾部必须以 assistant 开头，不能是孤儿 tool');
  // 配对校验：每条 tool 之前存在携带其 tool_call_id 的 assistant
  const seen = new Set();
  for (const m of tail) {
    if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) seen.add(c.id);
    if (m.role === 'tool') assert.ok(seen.has(m.tool_call_id), `孤儿 tool 消息：${m.tool_call_id}`);
  }
  // 尾部 5 条原文保留（比 keepTail 多 2 条——用多保留换协议合法）
  assert.deepEqual(tail, msgs.slice(-5));
});

test('R05（N-05）：_compacted 等内部标记不会出现在发往上游的请求体里', async () => {
  await streamChat({
    provider,
    messages: [
      { role: 'user', content: '正常消息', _compacted: true, internalNote: 'secret-marker' },
      { role: 'tool', tool_call_id: 'c9', content: '旧工具结果已清理', _compacted: true },
    ],
    temperature: 0.2,
  });
  assert.ok(lastBody.includes('"role":"user"'), '请求体应包含标准字段');
  assert.ok(!lastBody.includes('_compacted'), '内部标记 _compacted 外泄');
  assert.ok(!lastBody.includes('internalNote'), '未知字段外泄');
  assert.ok(!lastBody.includes('secret-marker'));
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
