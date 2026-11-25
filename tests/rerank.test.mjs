import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-rerank-'));
process.env.DATA_DIR = dir;
process.env.CORPUS_JSONL = path.join(dir, 'papers.jsonl');
process.env.KB_FILE = path.join(dir, 'kb.json');
process.env.MYSQL_ENABLED = 'false';
process.env.RERANK_ENABLED = '0';
fs.writeFileSync(process.env.CORPUS_JSONL, [
  { id: 1, title: 'graph network alpha', abstract: 'A graph network for source alpha.', discipline: 'computer', keywords: 'graph network' },
  { id: 2, title: 'graph network beta', abstract: 'A graph network for source beta.', discipline: 'computer', keywords: 'graph network' },
  { id: 3, title: 'graph network gamma', abstract: 'A graph network for source gamma.', discipline: 'computer', keywords: 'graph network' },
  { id: 4, title: 'graph network unrelated discipline', abstract: 'A graph network for source delta.', discipline: 'biology', keywords: 'graph network' },
].map((item) => JSON.stringify(item)).join('\n'));

let handler;
let calls = [];
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  calls.push({ body, authorization: req.headers.authorization });
  handler(body, res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/rerank`;
const { rerankCandidates } = await import('../src/server/rerank.mjs');
const { config } = await import('../src/server/config.mjs');
const settings = { enabled: true, url, model: 'mock-bge', apiKey: 'local-test', timeoutMs: 500, maxChars: 128 };
const candidates = [
  { ref: 'first', kind: 'paper', title: '甲', content: '原文甲'.repeat(100), start: 7, end: 10, channels: ['paper'] },
  { ref: 'second', kind: 'doc', title: '乙', content: '原文乙', docId: 'doc-1', start: 42, end: 45, channels: ['kb'] },
  { ref: 'third', kind: 'external', title: '丙', content: '原文丙', start: 0, end: 3, channels: ['external'] },
];
const respond = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rerank 关闭时不出站，保留原候选', async () => {
  const before = calls.length;
  const result = await rerankCandidates('查询', candidates, { settings: { ...settings, enabled: false } });
  assert.equal(result.results, candidates);
  assert.equal(result.reason, 'disabled');
  assert.equal(calls.length, before);
});

test('rerank 只重排已有证据，保留原文/归属/偏移，稳定处理同分', async () => {
  handler = (_body, res) => respond(res, { results: [
    { index: 2, relevance_score: 0.8, ref: 'injected', content: '替换内容' },
    { index: 1, relevance_score: 0.8 },
    { index: 0, relevance_score: 0.1 },
  ] });
  const result = await rerankCandidates('查询', candidates, { settings });
  assert.equal(result.applied, true);
  assert.deepEqual(result.results.map((item) => item.ref), ['second', 'third', 'first']);
  assert.equal(result.results[0].docId, 'doc-1');
  assert.equal(result.results[0].start, 42);
  assert.equal(result.results[1].content, '原文丙');
  assert.equal(candidates[0].rerankScore, undefined, '输入不应被修改');
  assert.equal(calls.at(-1).authorization, 'Bearer local-test');
  assert.equal(calls.at(-1).body.documents[0].length, 128);
  assert.equal(calls.at(-1).body.top_n, 3);
});

test('rerank 缺失、重复、越界索引和非数值分数全部回退', async () => {
  for (const rows of [
    [{ index: 0, relevance_score: 1 }],
    [0, 0, 2].map((index) => ({ index, relevance_score: 1 })),
    [0, 1, 3].map((index) => ({ index, relevance_score: 1 })),
    [0, 1, 2].map((index) => ({ index, relevance_score: '1' })),
  ]) {
    handler = (_body, res) => respond(res, { results: rows });
    const result = await rerankCandidates('查询', candidates, { settings });
    assert.equal(result.applied, false);
    assert.equal(result.results, candidates);
  }
});

test('rerank 服务错误、畸形 JSON 和过大响应都快速回退', async () => {
  for (const responseHandler of [
    (_body, res) => respond(res, { error: 'busy' }, 503),
    (_body, res) => res.end('{bad'),
    (_body, res) => res.end('x'.repeat(150000)),
  ]) {
    handler = responseHandler;
    const result = await rerankCandidates('查询', candidates, { settings });
    assert.equal(result.applied, false);
    assert.equal(result.results, candidates);
  }
});

test('rerank 超时和调用方取消不会无限挂起', async () => {
  handler = () => {};
  const started = Date.now();
  const timedOut = await rerankCandidates('查询', candidates, { settings: { ...settings, timeoutMs: 50 } });
  assert.equal(timedOut.reason, 'timeout');
  assert.ok(Date.now() - started < 1500);
  const controller = new AbortController();
  controller.abort();
  const before = calls.length;
  const cancelled = await rerankCandidates('查询', candidates, { signal: controller.signal, settings });
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(calls.length, before);
});

test('融合后扩大候选再重排，学科与来源过滤仍在服务调用之前执行', async () => {
  const { initRag } = await import('../src/server/rag.mjs');
  const { retrieveAll } = await import('../src/server/retrieve.mjs');
  await initRag({ mysqlReady: false });
  const previous = config.rerank;
  try {
    config.rerank = { ...settings, enabled: false };
    const options = { k: 1, rewrite: false, sourceKind: 'paper', discipline: 'computer', channels: ['paper'] };
    const baseline = await retrieveAll('graph network', options);
    config.rerank = { ...settings, candidateK: 3 };
    handler = (body, res) => respond(res, { results: body.documents.map((document, index) => ({
      index, relevance_score: document.includes('gamma') ? 0.99 : 0.1,
    })) });
    const improved = await retrieveAll('graph network', options);
    assert.equal(improved.results.length, 1);
    assert.equal(improved.results[0].ref, '3');
    assert.equal(improved.rerank.applied, true);
    assert.equal(improved.rerank.candidates, 3);
    assert.equal(calls.at(-1).body.documents.length, 3, '不能先截到最终 topK 再重排');
    assert.ok(calls.at(-1).body.documents.every((doc) => !doc.includes('biology') && !doc.includes('delta')));
    handler = (_body, res) => respond(res, { error: 'unavailable' }, 503);
    const fallback = await retrieveAll('graph network', options);
    assert.deepEqual(fallback.results, baseline.results);
    assert.equal(fallback.rerank.reason, 'http_503');
  } finally {
    config.rerank = previous;
  }
});

test('重排候选预留 RRF 文档多样性，避免单篇文档占满候选后结果欠额', async () => {
  const { initKb } = await import('../src/server/kb.mjs');
  const { retrieveAll } = await import('../src/server/retrieve.mjs');
  const userId = 'rerank-pool-owner';
  const text = 'graph network source evidence';
  const docs = ['A', 'B', 'C'].map((id) => ({ id, userId, name: id, text }));
  const chunks = [['A', 10], ['B', 3], ['C', 3]].flatMap(([docId, count]) =>
    Array.from({ length: count }, (_, idx) => ({
      id: `${docId}_${idx}`, docId, userId, idx, heading: '', text, start: 0, end: text.length,
    })));
  fs.writeFileSync(config.kbFile, JSON.stringify({ docs, chunks }));
  await initKb({ mysqlReady: false });
  const previous = config.rerank;
  const previousChunkTopK = config.retrieval.chunkTopK;
  try {
    config.retrieval.chunkTopK = 16;
    config.rerank = { ...settings, enabled: false };
    const options = { userId, k: 8, rewrite: false, sourceKind: 'doc', channels: ['kb'] };
    const baseline = await retrieveAll('graph network', options);
    assert.deepEqual(baseline.results.map((item) => item.docId), ['A', 'A', 'A', 'B', 'B', 'B', 'C', 'C']);
    for (const candidateK of [8, 12]) {
      config.rerank = { ...settings, candidateK };
      // Prefer the deepest added A matches; every returned candidate is scored.
      handler = (body, res) => respond(res, { results: body.documents.map((_document, index) => ({
        index, relevance_score: index,
      })) });
      const result = await retrieveAll('graph network', options);
      assert.equal(result.rerank.applied, true);
      assert.equal(result.results.length, 8, `candidateK=${candidateK} must preserve enough distinct documents`);
      assert.equal(calls.at(-1).body.documents.length, candidateK);
      assert.equal(result.rerank.candidates, candidateK);
      assert.equal(new Set(result.results.map((item) => item.ref)).size, 8);
      for (const docId of ['A', 'B', 'C']) {
        assert.ok(result.results.filter((item) => item.docId === docId).length <= 3);
      }
      assert.ok(result.results.every((item) => Number.isFinite(item.rerankScore)), '不能用未评分候选补位');
      if (candidateK === 8) {
        assert.deepEqual(result.results.map((item) => item.ref).sort(), baseline.results.map((item) => item.ref).sort());
      }
      handler = (_body, res) => respond(res, { error: 'unavailable' }, 503);
      const fallback = await retrieveAll('graph network', options);
      assert.deepEqual(fallback.results, baseline.results);
    }
  } finally {
    config.rerank = previous;
    config.retrieval.chunkTopK = previousChunkTopK;
  }
});
