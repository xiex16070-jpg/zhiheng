/**
 * 外部文献检索测试（全部离线：注入 fetchImpl，不触网）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const { searchEuropePmc, searchArxiv, parseArxivAtom, searchScholar, fetchScholarBody, clearScholarCache } = await import('../src/server/scholar.mjs');

const okJson = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
const okText = (t) => ({ ok: true, status: 200, json: async () => ({}), text: async () => t });

test('学术请求缓存按凭据隔离，429 遵守 Retry-After，503 只重试一次', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return Response.json({ results: [] }); };
    const url = 'https://api.openalex.org/works?search=fixture';
    const get = headers => fetchScholarBody(url, globalThis.fetch, undefined, 'application/json', headers);
    await get({ authorization: 'Bearer synthetic-a' });
    await get({ authorization: 'Bearer synthetic-a' });
    assert.equal(calls, 1);
    await get({ authorization: 'Bearer synthetic-b' }); assert.equal(calls, 2);
    clearScholarCache(); calls = 0;
    globalThis.fetch = async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '120' } }); };
    await assert.rejects(get({}), e => e.status === 429 && e.retryAfter === 120);
    await assert.rejects(get({}), e => e.status === 429 && e.retryAfter >= 119);
    assert.equal(calls, 1, 'cooldown avoids issuing another upstream request');
    clearScholarCache(); calls = 0;
    globalThis.fetch = async () => { calls++; return calls === 1 ? new Response('', { status: 503 }) : Response.json({ results: [] }); };
    await get({}); assert.equal(calls, 2);
  } finally { clearScholarCache(); globalThis.fetch = original; }
});

test('Europe PMC 超时明确归类，不能误报为密钥未配置', async () => {
  const r = await searchEuropePmc('logic', { fetchImpl: async () => { throw new DOMException('fixture timeout', 'AbortError'); } });
  assert.equal(r.error, 'timeout'); assert.match(r.reason, /超时/);
});

test('Europe PMC：字段映射（标题/作者/期刊/年份/DOI/链接/摘要）', async () => {
  const payload = {
    resultList: {
      result: [
        {
          title: 'High-nickel layered cathodes: degradation and mitigation',
          authorString: 'Zhang S, Li Y, Wang H.',
          journalTitle: 'Nature Energy',
          pubYear: '2024',
          doi: '10.1038/s41560-024-00001-x',
          pmid: '39000001',
          pubType: 'review',
          abstractText: 'This review summarizes degradation modes of Ni-rich cathodes and mitigation strategies.',
        },
        { title: '', authorString: 'Nobody' },
      ],
    },
  };
  let called = '';
  const r = await searchEuropePmc('nickel cathode', {
    limit: 5,
    fetchImpl: async (url) => { called = url; return okJson(payload); },
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'europepmc');
  assert.equal(r.results.length, 1, '空标题应被过滤');
  assert.equal(r.results[0].venue, 'Nature Energy');
  assert.equal(r.results[0].year, '2024');
  assert.equal(r.results[0].url, 'https://doi.org/10.1038/s41560-024-00001-x');
  assert.match(r.results[0].abstract, /degradation modes/);
  assert.match(called, /pageSize=5/);
  assert.match(called, /query=nickel%20cathode/);
});

test('Europe PMC：HTTP 失败返回可读原因，不抛异常', async () => {
  const r = await searchEuropePmc('x', { fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 503/);
});

test('arXiv：Atom 解析（实体解码、作者截断、预印本标记）', () => {
  const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <id>http://arxiv.org/abs/2401.01234v1</id>
      <published>2024-01-02T10:00:00Z</published>
      <title>Scaling Laws for
        Retrieval-Augmented Agents</title>
      <summary>We study &lt;scaling&gt; &amp; retrieval.</summary>
      <author><name>Alice Zhang</name></author>
      <author><name>Bob Li</name></author>
    </entry>
    <entry>
      <id>http://arxiv.org/abs/2402.05678v2</id>
      <published>2024-02-03T10:00:00Z</published>
      <title>Second Paper</title>
      <summary>Abstract two.</summary>
      <author><name>Carol Wu</name></author>
    </entry>
  </feed>`;
  const rows = parseArxivAtom(xml);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Scaling Laws for Retrieval-Augmented Agents');
  assert.equal(rows[0].year, '2024');
  assert.equal(rows[0].url, 'https://arxiv.org/abs/2401.01234v1');
  assert.match(rows[0].abstract, /<scaling> & retrieval/);
  assert.match(rows[0].authors, /Alice Zhang/);
  assert.equal(rows[1].venue, 'arXiv');
  assert.equal(rows[1].type, 'preprint');
});

test('arXiv：检索封装与条数上限', async () => {
  const xml = `<feed><entry><id>http://arxiv.org/abs/1</id><title>T</title><summary>S</summary><published>2023-05-01</published><author><name>A</name></author></entry></feed>`;
  let url = '';
  const r = await searchArxiv('agents', { limit: 99, fetchImpl: async (u) => { url = u; return okText(xml); } });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'arxiv');
  assert.equal(r.results.length, 1);
  assert.match(url, /max_results=10/, '上限 10');
});

test('统一入口：按 source 路由', async () => {
  const fake = async () => okJson({ resultList: { result: [{ title: 'X', pubYear: '2020' }] } });
  const a = await searchScholar('q', { source: 'europepmc', fetchImpl: fake });
  assert.equal(a.source, 'europepmc');
  const b = await searchScholar('q', { source: 'arxiv', fetchImpl: async () => okText('<feed></feed>') });
  assert.equal(b.ok, true);
  assert.equal(b.results.length, 0);
});

test('真实 core 元数据和上游超量结果遵守请求限制', async () => {
  let options;
  const r = await searchEuropePmc('formal logic', { limit: 1, fetchImpl: async (url, opts) => {
    options = opts;
    return okJson({ resultList: { result: [
      { title: 'Core record', journalInfo: { journal: { title: 'Computer Science Review' } }, pubTypeList: { pubType: ['review'] }, doi: '10.1234/test#part' },
      { title: 'Unexpected extra record' },
    ] } });
  } });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].venue, 'Computer Science Review');
  assert.equal(r.results[0].type, 'review');
  assert.equal(r.results[0].url, 'https://doi.org/10.1234/test%23part');
  assert.equal(options.redirect, 'error');
});

test('取消信号提前或中途到达时不降级成普通检索失败', async () => {
  const pre = new AbortController();
  pre.abort(new Error('user_cancelled'));
  let requests = 0;
  const fetchImpl = async () => { requests++; return okText('<feed></feed>'); };
  for (const search of [searchEuropePmc, searchArxiv, searchScholar]) {
    await assert.rejects(search('logic', { signal: pre.signal, fetchImpl }), /user_cancelled/);
  }
  assert.equal(requests, 0);
  const live = new AbortController();
  let start;
  const started = new Promise(resolve => { start = resolve; });
  const pending = searchArxiv('logic', { signal: live.signal, fetchImpl: async (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      start();
    }) });
  await started;
  live.abort(new Error('user_cancelled'));
  await assert.rejects(pending, /user_cancelled/);
});

test('流式响应在超过字节上限时立即取消读取', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  const r = await searchArxiv('logic', { fetchImpl: async () => new Response(stream) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /超过 2 MiB/);
  assert.equal(cancelled, true);
  let calls = 0;
  const long = await searchScholar('x'.repeat(501), { fetchImpl: async () => { calls++; } });
  assert.equal(long.ok, false);
  assert.equal(calls, 0);
});

test('arXiv 的 Atom 错误条目不会冒充正常论文', async () => {
  const xml = '<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title><summary>Invalid query</summary></entry></feed>';
  const r = await searchArxiv('invalid', { fetchImpl: async () => okText(xml) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /查询无效/);
  assert.ok(!r.results);
});

test('Europe PMC core 的 MED id、PMCID 与 source/id 详情链接分别映射', async () => {
  const records = [
    { title: 'PubMed core record', source: 'MED', id: '39000001' },
    { title: 'PMC core record', source: 'PMC', id: 'PMC7561308' },
    { title: 'Explicit PMCID', pmcid: 'PMC7561308' },
    { title: 'Preprint record', source: 'PPR', id: 'PPR123456' },
    { title: 'Non-PubMed numeric id', source: 'AGR', id: '39000001' },
    { title: 'Unsafe record id', source: 'MED', id: '../outside' },
    { title: 'Unsafe source', source: '../MED', id: '39000001' },
    { title: 'Absent identity' },
  ];
  const r = await searchEuropePmc('literature metadata', { limit: 10,
    fetchImpl: async () => okJson({ resultList: { result: records } }) });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].pmid, '39000001');
  assert.equal(r.results[0].url, 'https://pubmed.ncbi.nlm.nih.gov/39000001/');
  assert.equal(r.results[1].pmcid, 'PMC7561308');
  assert.equal(r.results[1].url, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7561308/');
  assert.equal(r.results[2].url, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC7561308/');
  assert.equal(r.results[3].url, 'https://europepmc.org/article/PPR/PPR123456');
  assert.equal(r.results[4].pmid, '');
  assert.equal(r.results[4].url, 'https://europepmc.org/article/AGR/39000001');
  for (const row of r.results.slice(5)) assert.equal(row.url, '');
});
