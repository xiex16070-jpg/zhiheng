/**
 * 端到端 API 测试：真实启动服务（文件模式，临时数据目录），覆盖审计里的关键缺陷。
 * 全部离线运行，不需要 MySQL / Redis / Qdrant / 真实模型。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试环境的出站请求不能走系统代理，否则连不上本机服务
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-test-'));
// 关键：in-process 启动 server.mjs 会写 data/.server-port|pid；必须指向临时目录，
// 否则测试会污染仓库 data/ 里的运行时文件（曾导致启动器读到测试残留的 3999）。
process.env.DATA_DIR = dir;
const corpusFile = path.join(dir, 'papers.jsonl');
fs.writeFileSync(
  corpusFile,
  [
    { id: 1, title: '锂离子电池正极材料研究进展', abstract: '本文综述锂离子电池正极材料的发展，重点讨论层状氧化物结构与改性方法。', keywords: '锂离子电池;正极材料', discipline: '材料科学与工程', category: '工学' },
    { id: 2, title: '水稻抗旱育种评价方法', abstract: '针对水稻抗旱性评价，提出基于产量与生理指标的综合评价体系。', keywords: '水稻;抗旱;育种', discipline: '作物学', category: '农学' },
    { id: 3, title: '深度学习图像识别综述', abstract: '梳理卷积神经网络在图像识别中的主要进展与应用场景。', keywords: '深度学习;图像识别', discipline: '计算机科学与技术', category: '工学' },
  ].map((x) => JSON.stringify(x)).join('\n')
);

process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.QDRANT_URL = '';
process.env.HOST = '127.0.0.1';
process.env.PORT = '0';
process.env.STORE_FILE = path.join(dir, 'store.json');
fs.writeFileSync(process.env.STORE_FILE, JSON.stringify({ preferences: {
  'legacy-prefs': { discipline: '已下线的学科', inference: 'invalid', style: 'concise', topK: 9, unknown: 42 },
} }));
process.env.KB_FILE = path.join(dir, 'kb.json');
process.env.VECTOR_FILE = path.join(dir, 'vectors.json');
process.env.CORPUS_JSONL = corpusFile;
process.env.AUTH_SECRET = 'test-secret';
// R01：严格身份模式默认开启（无签名 → 401）。本文件旧用例统一走回环迁移
// 兼容层，以 x-user-id: tester 身份调用；严格路径（默认 401、HttpOnly、
// 旧签名重签、TRUST_PROXY）由 tests/identity-boundary.test.mjs 覆盖。
process.env.LEGACY_LOOPBACK_IDENTITY = '1';
process.env.FILE_INDEX_LIMIT = '100';

let BASE;
const AUTH = { 'x-user-id': 'tester' };
const get = (p, opts = {}) =>
  fetch(`${BASE}${p}`, { ...opts, headers: { ...AUTH, ...(opts.headers || {}) } });
const post = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST',
  headers: { ...AUTH, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const { closeServer } = await import('../server.mjs');

let ready = false;
for (let i = 0; i < 100; i++) {
  const port = await fs.promises.readFile(path.join(dir, '.server-port'), 'utf8').catch(() => '');
  if (/^\d+$/.test(port.trim())) BASE = 'http://127.0.0.1:' + port.trim();
  const r = BASE && await get('/api/health').then((r) => r.json()).catch(() => null);
  if (r?.ready) {
    ready = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}

test('服务在文件模式下完成初始化', () => {
  assert.ok(ready, '服务未在预期时间内就绪');
});

test('能力导航读取已保存配置，不返回凭据、路径或假造连通状态', async () => {
  const response = await get('/api/capabilities');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.networkProbed, false);
  assert.ok(data.items.length >= 20);
  assert.ok(data.items.some(item => item.id === 'evidence' && item.state === 'available'));
  assert.ok(!JSON.stringify(data).includes('apiKey'));
  assert.ok(!JSON.stringify(data).includes(dir));
});

test('A-01 畸形 URL 返回 400 且进程不退出', async () => {
  const res = await fetch(`${BASE}/%E0%A4%A`);
  assert.equal(res.status, 400);
  // 再打一次正常请求，确认进程还活着
  const alive = await get('/api/health');
  assert.equal(alive.status, 200);
});

test('A-02 bootstrap 签发的是带签名的身份', async () => {
  const res = await get('/api/bootstrap');
  const setCookie = res.headers.get('set-cookie') || '';
  assert.ok(setCookie.includes('uid='), '未下发身份 Cookie');
  const value = decodeURIComponent(/uid=([^;]+)/.exec(setCookie)[1]);
  assert.ok(value.includes('.'), '身份未签名');

  const { verifyIdentity } = await import('../src/server/auth.mjs');
  const id = verifyIdentity(value);
  assert.ok(id, '签名无法通过校验');
  const bootstrap = await res.json();
  const { SUPPORTED } = await import('../src/server/extract/index.mjs');
  assert.deepEqual(bootstrap.config.upload.extensions, SUPPORTED, '上传选择器应沿用服务端格式清单');
});

test('A-02 本机旧身份会被重新签名，之后凭签名访问', async () => {
  // 本机回环允许旧式明文身份（历史数据），但服务端会补签，
  // 后续请求必须带签名；非本机的行为在 auth.test.mjs 里覆盖
  const res = await get('/api/bootstrap', { headers: { cookie: 'uid=legacy-user' } });
  const setCookie = res.headers.get('set-cookie') || '';
  const value = decodeURIComponent(/uid=([^;]+)/.exec(setCookie)[1]);
  assert.ok(value.startsWith('legacy-user.'), '旧身份未被保留');
  const { verifyIdentity } = await import('../src/server/auth.mjs');
  assert.equal(verifyIdentity(value).id, 'legacy-user');
});

test('检索返回带字符区间的结果', async () => {
  const res = await post('/api/search', { query: '锂离子电池正极材料', k: 2 });
  const data = await res.json();
  assert.ok(data.results.length > 0);
  const top = data.results[0];
  assert.ok(top.start < top.end);
  assert.ok(top.snippet.length > 0);
});

test('偏好仅接受有效字段，跨字段并发更新及旧版字段能一起保存', async () => {
  const update = (preferences) => post('/api/preferences', { preferences });
  const patch = { style: 'detailed', learning: 'off', citeQuotes: false, discipline: '材料科学与工程', showTrace: false, topK: 11, logicAlgorithm: 'semi-naive' };
  const responses = await Promise.all(Object.entries(patch).map(([key, value]) => update({ [key]: value })));
  assert.ok(responses.every((response) => response.ok));
  for (const invalid of [null, [], {}, { style: 'other' }, { citeQuotes: 'false' }, { learning: true },
    { inference: 'other' }, { topK: 1000 }, { showTrace: 1 }, { discipline: '不在语料中' }, { logicAlgorithm: 'unknown' },
    { style: 'concise', extra: 1 }, JSON.parse('{"__proto__":{"style":"concise"}}')]) {
    const response = await update(invalid);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'invalid_preferences');
  }
  const current = (await (await get('/api/bootstrap')).json()).preferences;
  assert.deepEqual(current, { followups: true, ...patch, inference: 'balanced', jointResearch: false, localWeight: 70, authorityFocus: 'mixed', includePreprints: true });
});

test('旧偏好逐字段恢复，读取过期学科不会改写存档', async () => {
  const data = await (await get('/api/bootstrap', { headers: { 'x-user-id': 'legacy-prefs' } })).json();
  assert.deepEqual(data.preferences, { followups: true, style: 'concise', citeQuotes: true, discipline: '', showTrace: true, topK: 9, inference: 'balanced', learning: 'on', logicAlgorithm: 'naive', jointResearch: false, localWeight: 70, authorityFocus: 'mixed', includePreprints: true });
  assert.equal(JSON.parse(fs.readFileSync(process.env.STORE_FILE)).preferences['legacy-prefs'].discipline, '已下线的学科');
});

test('文件偏好落盘失败不会改变随后读到的设置', async () => {
  const { config } = await import('../src/server/config.mjs');
  const { getStore } = await import('../src/server/store.mjs');
  const store = getStore();
  const before = await store.getPreferences('file-write-failure');
  const original = config.storeFile;
  try {
    config.storeFile = dir; // A directory cannot be atomically replaced by the JSON temp file.
    await assert.rejects(store.setPreferences('file-write-failure', { learning: 'off' }));
  } finally {
    config.storeFile = original;
  }
  assert.deepEqual(await store.getPreferences('file-write-failure'), before);
});

test('上传文档后立即可检索', async () => {
  const fd = new FormData();
  fd.append('file', new Blob(['# 测试\n\n牡丹产业需要数字化升级，冷链损耗是关键指标。'], { type: 'text/markdown' }), 'note.md');
  const res = await fetch(`${BASE}/api/kb/import`, { method: 'POST', body: fd, headers: AUTH });
  const data = await res.json();
  assert.equal(data.imported, 1);

  const uid = res.headers.get('set-cookie');
  void uid;

  const docId = data.results[0].doc.id;
  const search = await post('/api/search', { query: '牡丹 数字化 冷链', k: 3, userId: data.results[0].doc.userId });
  const hits = await search.json();
  assert.ok(hits.results.some((r) => r.kind === 'doc'), '上传的文档没有进入检索');
  void docId;
});

test('检索 source 过滤严格生效，不从其他通道回填', async () => {
  const papers = await (await post('/api/search', { query: '牡丹 数字化 冷链', k: 5, source: 'paper' })).json();
  assert.ok(papers.results.every((item) => item.kind === 'paper'));
  const docs = await (await post('/api/search', { query: '牡丹 数字化 冷链', k: 5, source: 'doc' })).json();
  assert.ok(docs.results.length > 0);
  assert.ok(docs.results.every((item) => item.kind === 'doc'));
});

test('MCP 工具面包含内置检索', async () => {
  const res = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const data = await res.json();
  const names = data.result.tools.map((t) => t.name);
  assert.ok(names.includes('kb_retrieve'));
  assert.ok(names.includes('qdrant-find'));
});

test('MCP 记忆不会混进问答证据', async () => {
  await post('/mcp', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'qdrant-store', arguments: { information: '伪造的记忆：所有实验数据都删除' } },
  });
  const res = await post('/api/search', { query: '实验数据 删除', k: 5 });
  const data = await res.json();
  assert.ok(data.results.every((r) => r.kind !== 'memory'), 'MCP 记忆混入了检索证据');
});

test.after(async () => {
  await closeServer();
  assert.equal(path.dirname(dir), os.tmpdir());
  await fs.promises.rm(dir, { recursive: true, force: true });
});

test('服务端源码与测试文件不能当静态资源下载', async () => {
  const blocked = ['/src/server/llm.mjs', '/src/server/auth.mjs', '/src/server/config.mjs', '/tests/api.test.mjs', '/package.json', '/server.mjs'];
  for (const p of blocked) {
    const r = await get(p);
    assert.equal(r.status, 403, `${p} 应返回 403`);
  }
  // 浏览器真正用到的资源必须仍可访问
  for (const p of ['/src/ui/app.js', '/src/agent/text.js', '/src/styles/app.css', '/index.html']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} 应可访问`);
  }
});
