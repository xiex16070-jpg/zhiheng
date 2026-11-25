import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'csl-corpus-isolation-'));
const safeEnv = {
  ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  CORPUS_JSONL: '', CORPUS_PROFILE: '', CORPUS_MANIFEST: '',
  MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '',
  EMBEDDING_PROVIDER: 'local', EMBEDDING_BASE_URL: '', RAGFLOW_BASE_URL: '', RERANK_ENABLED: 'false',
  DATA_DIR: temp, STORE_FILE: path.join(temp, 'store.json'), KB_FILE: path.join(temp, 'kb.json'), VECTOR_FILE: path.join(temp, 'vectors.json'),
  FILE_INDEX_LIMIT: '10000', LEARNING_ENABLED: 'false', AUTH_SECRET: 'corpus-isolation-test',
};
Object.assign(process.env, safeEnv);
const { config } = await import('../src/server/config.mjs');
const { initRag, getPaper, searchPapers, ragStatus, sourceMetadata } = await import('../src/server/rag.mjs');
const { initVector, upsertVectors } = await import('../src/server/vector.mjs');
const { retrieveAll } = await import('../src/server/retrieve.mjs');

test.after(async () => {
  const target = path.resolve(temp);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.match(path.basename(target), /^csl-corpus-isolation-/);
  await fs.rm(target, { recursive: true, force: true });
});

const record = (id = 900000004) => ({
  id, title: '合取定义', abstract: '  命题合取要求两个命题都成立。\n  蕴含的方向不能随意倒置。',
  keywords: '只用于索引的编辑标签', discipline: '形式逻辑', category: '教材',
  recordType: 'textbook-section', sourceUrl: 'https://example.test/source.v#L12-L18',
  canonicalUrl: 'https://example.test/source.html', sourcePath: 'lf-current/Logic.v',
  sourceTitle: '逻辑基础', sourceRevision: 'a'.repeat(40), sourceStartLine: 12, sourceEndLine: 18,
  authors: ['Example Author'], translators: 'Example Translators', license: 'MIT', language: 'zh-CN',
  sourceEdition: 'Logical Foundations 5.7', sourceEditionDate: '2022-03-14', volumeVersion: '5.7',
  containsCode: false, translationStatus: 'alpha', proofStatus: 'source-text-not-rechecked',
});

async function corpusFixture(t, records, { manifest = 'valid', crlf = false } = {}) {
  const dir = await fs.mkdtemp(path.join(temp, 'case-'));
  const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const digest = crypto.createHash('sha256').update(jsonl).digest('hex');
  const file = path.join(dir, 'papers.jsonl');
  const manifestFile = path.join(dir, 'manifest.json');
  await fs.writeFile(file, crlf ? jsonl.replace(/\n/g, '\r\n') : jsonl);
  await fs.writeFile(manifestFile, JSON.stringify(manifest === 'valid' ? { profile: 'formal', name: 'Fixture', sectionCount: records.length, contentSha256: digest } : manifest));
  const previous = config.corpus;
  config.corpus = { profile: 'formal', jsonl: file, manifest: manifestFile };
  t.after(() => { config.corpus = previous; });
  return { file, manifestFile, digest };
}

test('默认专业库即使 mysqlReady=true 也不尝试查询旧 papers 表', async () => {
  assert.equal(config.corpus.profile, 'formal');
  const warnings = [];
  const previousWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const status = await initRag({ mysqlReady: true });
    assert.equal(status.engine, 'file-bm25');
    assert.ok(status.papers > 300);
    assert.equal(status.profile, 'formal');
    assert.deepEqual(warnings, [], 'mysql_not_ready would reveal an attempted legacy query');
    assert.equal(await getPaper(1), null, 'old CSL numeric IDs must not resolve');
  } finally { console.warn = previousWarn; }
});

test('显式 CORPUS_JSONL 优先于 legacy-csl 配置和数据库就绪状态', async () => {
  const file = path.join(temp, 'custom.jsonl');
  await fs.writeFile(file, JSON.stringify(record()) + '\n');
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { config } from './src/server/config.mjs';
    import { initRag, getPaper } from './src/server/rag.mjs';
    const status = await initRag({mysqlReady:true});
    console.log(JSON.stringify({profile:config.corpus.profile,manifest:config.corpus.manifest,status,paper:await getPaper(900000004)}));
  `], { cwd: ROOT, env: { ...safeEnv, CORPUS_PROFILE: 'legacy-csl', CORPUS_JSONL: file }, encoding: 'utf8' });
  const data = JSON.parse(result.trim());
  assert.equal(data.profile, 'custom');
  assert.equal(data.manifest, null);
  assert.equal(data.status.engine, 'file-bm25');
  assert.equal(data.status.papers, 1);
  assert.equal(data.paper.sourceStartLine, 12);
});

test('清单错哈希、缺哈希、错域或错计数均拒绝加载，不留下旧文献、语料标识或出处状态', async (t) => {
  const { manifestFile, digest } = await corpusFixture(t, [record()]);
  await initRag({ mysqlReady: false });
  assert.ok(await getPaper(900000004));
  for (const invalid of [
    { profile: 'formal', sectionCount: 1, contentSha256: '0'.repeat(64) },
    { profile: 'formal', sectionCount: 1 },
    { profile: 'legacy-csl', sectionCount: 1, contentSha256: digest },
    { profile: 'formal', sectionCount: 2, contentSha256: digest },
  ]) {
    await fs.writeFile(manifestFile, JSON.stringify(invalid));
    const status = await initRag({ mysqlReady: true });
    assert.equal(status.engine, 'empty');
    assert.equal(status.papers, 0);
    assert.equal(status.corpusId, null);
    assert.notEqual(status.name, 'Fixture');
    assert.equal(await getPaper(900000004), null);
    assert.deepEqual((await searchPapers('合取')).results, []);
  }
});

test('正式库不能被旧 FILE_INDEX_LIMIT 隐式截断，数值等价的重复 ID 被拒绝', async (t) => {
  const previous = process.env.FILE_INDEX_LIMIT;
  process.env.FILE_INDEX_LIMIT = '1';
  t.after(() => { process.env.FILE_INDEX_LIMIT = previous; });
  const records = [record(900000004), record(900000005)];
  const { file, manifestFile } = await corpusFixture(t, records);
  assert.equal((await initRag({ mysqlReady: false })).papers, 2);
  assert.ok(await getPaper(900000005));
  const duplicate = [record(900000004), record('0900000004')].map(JSON.stringify).join('\n') + '\n';
  await fs.writeFile(file, duplicate);
  await fs.writeFile(manifestFile, JSON.stringify({ profile: 'formal', sectionCount: 2, contentSha256: crypto.createHash('sha256').update(duplicate).digest('hex') }));
  assert.equal((await initRag({ mysqlReady: false })).engine, 'empty');
  assert.equal(await getPaper(900000004), null);
});

test('CRLF语料按LF验证；出处版本和行号贯穿getPaper/search，片段偏移仅指向正文', async (t) => {
  const original = record();
  const { digest } = await corpusFixture(t, [original], { crlf: true });
  const status = await initRag({ mysqlReady: false });
  assert.equal(status.corpusId, digest);
  const paper = await getPaper(original.id);
  assert.equal(paper.sourceStartLine, 12);
  assert.equal(paper.sourceEndLine, 18);
  assert.equal(paper.sourceEditionDate, '2022-03-14');
  assert.equal(sourceMetadata(paper).sourceEditionDate, '2022-03-14');
  const found = await searchPapers('合取', { k: 1 });
  const hit = found.results[0];
  assert.ok(hit.start >= original.title.length + 2);
  assert.equal(hit.content.slice(hit.start, hit.end), hit.snippet);
  assert.equal(hit.sourceStartLine, 12);
  assert.equal(hit.sourceEndLine, 18);
  assert.equal(hit.sourceEditionDate, '2022-03-14');
  assert.equal(hit.containsCode, false);
  assert.ok(!hit.content.includes(original.keywords));
});

test('旧/无版本/已删除paper向量被剔除，当前向量从真实正文重建出处和偏移', async (t) => {
  const records = [record(900000001), record(900000002), record()];
  await corpusFixture(t, records);
  await initRag({ mysqlReady: false });
  await initVector();
  const corpusId = ragStatus().corpusId;
  await upsertVectors([
    { ref: '900000001', text: '命题合取', payload: { kind: 'paper', corpusId: 'legacy-csl:mysql', text: '旧库内容' } },
    { ref: '900000002', text: '命题合取', payload: { kind: 'paper', text: '无版本内容' } },
    { ref: '999999999', text: '命题合取', payload: { kind: 'paper', corpusId, text: '已删除文献' } },
    { ref: '900000004', text: '命题合取', payload: { kind: 'paper', corpusId, text: '伪造摘要', start: 12345, end: 99999 } },
  ]);
  const data = await retrieveAll('命题合取', { channels: ['vector'], sourceKind: 'paper', rewrite: false });
  assert.deepEqual(data.results.map((r) => r.ref), ['900000004']);
  const hit = data.results[0];
  assert.ok(!hit.content.includes('伪造'));
  assert.equal(hit.content.slice(hit.start, hit.end), hit.snippet);
  assert.equal(hit.sourceStartLine, 12);
  assert.equal(hit.sourceEndLine, 18);
  assert.equal(hit.sourceEditionDate, '2022-03-14');
  assert.equal(hit.corpusId, corpusId);
});

test('旧语料向量不能占满topK并挤掉当前语料候选', async (t) => {
  await corpusFixture(t, [record()]);
  await initRag({ mysqlReady: false });
  const oldTopK = config.retrieval.vectorTopK;
  config.retrieval.vectorTopK = 2;
  t.after(() => { config.retrieval.vectorTopK = oldTopK; });
  await initVector();
  await upsertVectors([
    ...Array.from({ length: 5 }, (_, i) => ({ ref: String(100 + i), text: '命题合取', payload: { kind: 'paper', corpusId: 'old', text: '命题合取' } })),
    { ref: '900000004', text: '命题合取以及逻辑证明和规则', payload: { kind: 'paper', corpusId: ragStatus().corpusId } },
  ]);
  const data = await retrieveAll('命题合取', { channels: ['vector'], sourceKind: 'paper', rewrite: false });
  assert.deepEqual(data.results.map((r) => r.ref), ['900000004']);
});

test('真实source HTTP接口保留版本/许可/源行号且不暴露编辑关键词为原文', async (t) => {
  const dir = await fs.mkdtemp(path.join(temp, 'http-'));
  const corpus = path.join(dir, 'papers.jsonl');
  await fs.writeFile(corpus, JSON.stringify(record()) + '\n');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, env: { ...safeEnv, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dir,
      STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'), CORPUS_JSONL: corpus },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
  let base;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`isolated server exited ${child.exitCode}`);
    const port = await fs.readFile(path.join(dir, '.server-port'), 'utf8').catch(() => null);
    if (port) {
      base = `http://127.0.0.1:${port.trim()}`;
      const health = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
      if (health?.ready) { ready = true; break; }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'isolated server did not become ready');
  const boot = await fetch(`${base}/api/bootstrap`);
  const cookie = boot.headers.get('set-cookie').split(';')[0];
  const response = await fetch(`${base}/api/source/900000004`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const source = await response.json();
  for (const key of ['sourceUrl', 'sourcePath', 'sourceRevision', 'sourceTitle', 'sourceStartLine', 'sourceEndLine', 'license', 'sourceEdition', 'sourceEditionDate']) assert.deepEqual(source[key], record()[key], key);
  assert.ok(!source.content.includes(record().keywords));
  assert.equal((await fetch(`${base}/api/source/1`, { headers: { cookie } })).status, 404);
});
