/**
 * R09（N-12）测试：辅助 LLM 调用护栏与透明化。
 * - AUX_LLM_MAX_CALLS=0 时压缩/审核/兜底全部跳过且轨迹如实标注 aux_budget；
 * - done 事件回报 llmCalls 且与 mock 实际收到的请求数一致；
 * - 偏好 learning:'off' 的用户任务结束后不入审查队列（不消耗其 Key）。
 * 离线运行：内联 mock 模型 + 子进程服务 + 临时数据目录。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/* ---------------- 单元层：manageContext 的 aux 闸门 ---------------- */
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-aux-unit-'));
process.env.DATA_DIR = unitDir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['aux', 'test', 'key'].join('-');
const { manageContext } = await import('../src/server/context.mjs');

const bigMsgs = () => {
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: 'user', content: `问题${i}${'汉字'.repeat(60)}` });
    msgs.push({ role: 'assistant', content: `回答${i}${'汉字'.repeat(60)}` });
  }
  return msgs;
};

test('单元：aux.allowed=false → 压缩跳过（skipped=aux_budget），零模型调用', async () => {
  let used = 0;
  const tracking = { refills: 0, lastCompactRound: 0, tripped: false, compacts: 0 };
  const r = await manageContext({
    messages: bigMsgs(),
    round: 5,
    provider: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'unreachable' },
    tracking,
    budget: 100, // 必然超阈
    aux: { allowed: false, use: () => { used += 1; } },
  });
  assert.equal(r.compacted, false);
  assert.equal(r.skipped, 'aux_budget');
  assert.equal(used, 0, '预算耗尽时不得发起辅助调用');
});

test('单元：aux.allowed=true → 正常压缩并计数一次', async () => {
  let used = 0;
  const tracking = { refills: 0, lastCompactRound: 0, tripped: false, compacts: 0 };
  const r = await manageContext({
    messages: bigMsgs(),
    round: 5,
    provider: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'x', model: 'unreachable' },
    tracking,
    budget: 100,
    aux: { allowed: true, use: () => { used += 1; } },
  });
  assert.equal(used, 1);
  assert.equal(r.compacted, true);
  assert.equal(r.detail.mode, 'fallback'); // 不可达 provider → 确定性兜底（不产生额外成本）
});

/* ---------------- HTTP 层 ---------------- */
const chunk = (delta, finish = null) => ({
  id: 'mock',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: finish }],
});
let mode = 'empty'; // empty=首轮工具调用、次轮空正文（触发兜底） | answer=直接给正文
let mockHits = 0;
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const hasTool = (body.messages || []).some((m) => m.role === 'tool');
  const isReview = /学习审查器/.test(JSON.stringify((body.messages || [])[0] || ''));
  mockHits += 1;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  if (isReview) {
    send(chunk({ content: '本次没有值得记录的内容。' })); // 非 JSON → review_parse_failed，无害
  } else if (mode === 'empty' && !hasTool) {
    send(chunk({ tool_calls: [{ index: 0, id: `c${mockHits}`, type: 'function', function: { name: 'search_knowledge', arguments: JSON.stringify({ query: '测试', top_k: 3 }) } }] }));
    send(chunk({}, 'tool_calls'));
  } else if (mode === 'empty') {
    // 工具结果轮：只出工具调用不出正文的模型 → 空正文，逼出兜底作答路径
  } else {
    send(chunk({ content: '结论：这是测试回答。' }));
  }
  send(chunk({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const provider = { baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, apiKey: 'mock-key', model: 'mock' };

const PORT = 3979;
const BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-aux-http-'));
fs.writeFileSync(path.join(dir, 'papers.jsonl'), '');
const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    STORE_FILE: path.join(dir, 'store.json'),
    KB_FILE: path.join(dir, 'kb.json'),
    VECTOR_FILE: path.join(dir, 'vectors.json'),
    CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false',
    REDIS_ENABLED: 'false',
    QDRANT_URL: '',
    AUTH_SECRET: ['aux', 'test', 'key'].join('-'),
    LEARNING_ENABLED: 'true',
    REVIEW_EVERY_TASKS: '1',
    REVIEW_SETTLE_MS: '3000', // 让 queued 槽位停留足够久供断言
    AUX_LLM_MAX_CALLS: '0',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost,::1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: ROOT,
});
child.stdout.resume();
child.stderr.resume();

function jar() {
  let cookie = '';
  return {
    get uid() {
      const m = /uid=([^.]+)/.exec(cookie || '');
      return m ? m[1] : null;
    },
    async call(p, opts = {}) {
      const r = await fetch(`${BASE}${p}`, {
        ...opts,
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
      });
      const sc = r.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      return r;
    },
  };
}

test('HTTP：AUX_LLM_MAX_CALLS=0 → 空正文明确失败，llmCalls 与实际请求数一致', async () => {
  const t0 = Date.now();
  for (;;) {
    try {
      const j = await (await fetch(`${BASE}/api/health`)).json();
      if (j.ready) break;
    } catch {}
    if (Date.now() - t0 > 25000) throw new Error('server not ready');
    await new Promise((r) => setTimeout(r, 200));
  }

  const alice = jar();
  await alice.call('/api/bootstrap');
  mode = 'empty';
  const before = mockHits;
  const sse = await (await alice.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '触发兜底的问题' }) })).text();
  const hits = mockHits - before;

  assert.match(sse, /"name":"finalize"[^}]*"status":"skipped"/, '兜底作答应被跳过并如实记录');
  assert.ok(sse.includes('aux_budget'), '轨迹应标注跳过原因');
  const errorEv = JSON.parse(/data: (\{"type":"error".*\})\n/.exec(sse + '\n')?.[1] || '{}');
  assert.match(errorEv.message || '', /incomplete_no_answer/, '空正文不得伪装成成功');
  assert.ok(errorEv.llmCalls, 'error 事件应携带 llmCalls');
  assert.equal(errorEv.llmCalls.aux, 0);
  assert.equal(errorEv.llmCalls.main + errorEv.llmCalls.aux, hits, 'llmCalls 必须等于 mock 实际收到的请求数');
});

test('HTTP：learning 默认 on → 任务后进入审查队列', async () => {
  const bob = jar();
  await bob.call('/api/bootstrap');
  mode = 'answer';
  await (await bob.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '正常问题' }) })).text();
  let queued = false;
  for (let i = 0; i < 20; i++) {
    const st = await (await bob.call('/api/learn/status')).json();
    if ((st.queued || []).includes(bob.uid)) { queued = true; break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(queued, `默认 learning:on 应入审查队列（uid=${bob.uid}）`);
});

test('HTTP：learning off → 任务后不入审查队列（不消耗用户 Key）', async () => {
  const carol = jar();
  await carol.call('/api/bootstrap');
  const pref = await (await carol.call('/api/preferences', { method: 'POST', body: JSON.stringify({ preferences: { learning: 'off' } }) })).json();
  assert.equal(pref.preferences?.learning, 'off');
  mode = 'answer';
  await (await carol.call('/api/chat', { method: 'POST', body: JSON.stringify({ provider, message: '正常问题 2' }) })).text();
  await new Promise((r) => setTimeout(r, 800)); // 给足入队时间
  const st = await (await carol.call('/api/learn/status')).json();
  assert.ok(!(st.queued || []).includes(carol.uid), 'learning:off 用户不得入审查队列');
});

after(() => {
  try { child.kill('SIGKILL'); } catch {}
  try { mock.close(); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(unitDir, { recursive: true, force: true }); } catch {}
});
