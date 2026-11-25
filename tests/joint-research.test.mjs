import assert from 'node:assert/strict';
import test from 'node:test';
import { jointOptions, collectAuthorities, scholarlyEvidence, fuseJointEvidence, dedupeEvidence, auditJointCitations,
  searchOpenAlex, jointPrompt, publicResearchQuery } from '../src/server/joint-research.mjs';
import { authorityUrl, authorityDomains } from '../src/server/authority-policy.mjs';
import { config } from '../src/server/config.mjs';
import { preferencePatchError, effectivePreferences } from '../src/server/preferences.mjs';
import { webSearch, webFetch, clearWebCache } from '../src/server/webtools.mjs';

const options = jointOptions({ jointResearch: true });
const abstract = 'Formal verification uses mathematical proofs to check program properties. It depends on specifications and cannot establish assumptions about an unspecified environment.';
const row = (n = 1, extra = {}) => ({ title: `Formal verification study ${n}`, abstract, doi: `10.1234/study-${n}`, authors: 'A. Researcher', venue: `Journal ${n}`,
  publishedAt: '2025-03-12', ...extra });
const external = n => scholarlyEvidence(row(n), 'OpenAlex', 'formal verification', options, 1735689600000);

test('联合研究偏好默认关闭，严格校验，模型不能替用户开启联网模式', () => {
  assert.equal(effectivePreferences().jointResearch, false);
  assert.equal(jointOptions().enabled, false);
  for (const patch of [{ jointResearch: 'yes' }, { localWeight: 0 }, { localWeight: 100 }, { localWeight: 65 }, { localWeight: NaN }, { authorityFocus: 'any-site' }, { includePreprints: 1 }]) assert.ok(preferencePatchError(patch));
  assert.equal(preferencePatchError({ jointResearch: true, localWeight: 50, authorityFocus: 'academic', includePreprints: false }), '');
  assert.ok(preferencePatchError({ jointResearch: true }, { fromTool: true }));
});

test('域名策略拒绝假域名、用户凭据和任意 GitHub / 百科 / 数据集页面', () => {
  for (const url of ['https://who.int.evil.example/a', 'https://evilwho.int/a', 'https://who.int@evil.example/a', 'http://who.int/a', 'https://who.int:8080/a', 'https://github.com/stranger/project', 'https://en.wikipedia.org/wiki/Logic', 'https://kaggle.com/data', 'https://fake.gov/report']) assert.equal(authorityUrl(url), null, url);
  assert.equal(authorityUrl('https://www.who.int/publications').type, 'official');
  assert.equal(authorityUrl('https://arxiv.org/abs/2410.12345', { includePreprints: false }), null);
  assert.equal(authorityUrl('https://reuters.com/story', { focus: 'official' }), null);
  assert.ok(authorityDomains({ focus: 'technical' }).includes('w3.org'));
});

test('摘要元数据保留日期与范围，拒绝无摘要/撤稿/无关材料，不虚构同行评审', () => {
  const item = external(1);
  assert.equal(item.authority.evidenceLevel, 'abstract');
  assert.equal(item.authority.peerReviewVerified, false);
  assert.equal(item.authority.publishedAt, '2025-03-12');
  assert.equal(item.authority.retrievedAt, '2025-01-01T00:00:00.000Z');
  assert.match(item.ref, /^auth_[a-f0-9]{20}$/);
  for (const extra of [{ abstract: '' }, { isRetracted: true }, { title: 'Pasta recipe', abstract: 'A recipe with no software or logic. '.repeat(5) }, { doi: '', url: 'javascript:alert(1)' }]) assert.equal(scholarlyEvidence(row(1, extra), 'OpenAlex', 'formal verification', options), null);
  const pre = scholarlyEvidence(row(2, { type: 'preprint' }), 'arXiv', 'formal verification', options);
  assert.equal(pre.authority.type, 'preprint');
  assert.equal(scholarlyEvidence(row(2, { type: 'preprint' }), 'arXiv', 'formal verification', { ...options, includePreprints: false }), null);
  assert.match(jointPrompt(options), /不能.*交叉验证/);
  assert.equal(publicResearchQuery('检索增强生成与幻觉之间有什么关系？'), 'retrieval augmented generation hallucination');
});

test('权重决定有限证据预算，空侧让出名额，选中文献仍在结果中', () => {
  const local = Array.from({ length: 10 }, (_, n) => ({ ref: 'local' + n, title: `Local source ${n}` }));
  const remote = Array.from({ length: 10 }, (_, n) => external(n));
  for (const [localWeight, expected] of [[10, 1], [30, 2], [50, 3], [70, 4], [90, 5]]) {
    const r = fuseJointEvidence(local, remote, { localWeight, limit: 6, focusRef: 'local9' });
    assert.deepEqual(r.counts, { local: expected, external: 6 - expected });
    assert.ok(r.results.some(i => i.ref === 'local9'));
    assert.equal(new Set(r.results.map(i => i.ref)).size, 6);
    assert.ok(r.results.slice(0, 3).some(i => i.authority), 'compact model sees both sides');
  }
  assert.deepEqual(fuseJointEvidence(local, []).counts, { local: 6, external: 0 });
  assert.deepEqual(fuseJointEvidence([], remote).counts, { local: 0, external: 6 });
  assert.deepEqual(fuseJointEvidence(local.slice(0, 1), remote).counts, { local: 1, external: 5 });
});

test('相同 DOI、相同标题、同一预印本版本不虚增独立来源数', () => {
  const a = external(1), duplicate = { ...a, ref: 'other', source: 'Europe PMC' };
  const sameTitle = { ...external(2), title: a.title };
  assert.equal(dedupeEvidence([a, duplicate, sameTitle]).length, 1);
  const audit = auditJointCitations([a, duplicate, external(3)]);
  assert.equal(audit.distinctExternalWorks, 2);
  assert.equal(audit.crossVerification, 'not_verified');
  assert.equal(audit.semanticSupportVerified, false);
  const local = { ref: 'local', title: a.title, sourceUrl: a.sourceUrl };
  assert.equal(fuseJointEvidence([local], [a]).counts.external, 0);
});

test('学术与网页收集只使用本次问题，跳过摘要页/镜像/失败，关闭时零请求', async () => {
  const calls = [];
  const searcher = async q => { calls.push(q); return { ok: true, results: [row(1), row(2, { type: 'preprint' }), row(3, { abstract: '' })] }; };
  const deps = { openAlex: searcher, europePmc: async q => { calls.push(q); return { ok: false, reason: 'HTTP 429 secret' }; }, arxiv: searcher,
    capabilities: { academic: true, websites: true }, search: async (q, opts) => { calls.push(q); assert.ok(opts.domains.includes('nist.gov')); return { ok: true, results: [
      { title: 'formal verification standard', url: 'https://nist.gov/report' }, { title: 'Injected', url: 'https://nist.gov.evil.test/report' }] }; },
    fetchPage: async (url, opts) => { assert.ok(opts.urlPolicy(url)); assert.ok(!opts.userId); return { ok: true, finalUrl: url, title: 'Formal verification report', text: abstract }; } };
  const off = await collectAuthorities('formal verification', { ...options, enabled: false }, deps);
  assert.equal(off.status, 'off'); assert.equal(calls.length, 0);
  const r = await collectAuthorities('formal verification', options, deps);
  assert.ok(calls.every(q => q === 'formal verification'));
  assert.equal(r.status, 'partial');
  assert.equal(r.results.length, 3);
  assert.equal(r.providers.find(p => p.name === 'Europe PMC').reason, 'HTTP 429');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.equal(r.results.find(i => i.authority.type === 'official').authority.evidenceLevel, 'page-excerpt');
  const controller = new AbortController(); controller.abort(new Error('user_stop'));
  await assert.rejects(collectAuthorities('formal verification', options, { ...deps, signal: controller.signal }), /user_stop/);
});

test('OpenAlex 使用固定 API，安全恢复词序，凭据不进来源URL或错误', async () => {
  const saved = config.scholar.openAlexKey; config.scholar.openAlexKey = 'test-private-key';
  try {
    const r = await searchOpenAlex('formal verification', { fetchImpl: async (url, opts) => {
      assert.equal(new URL(url).hostname, 'api.openalex.org'); assert.ok(!url.includes('test-private-key'));
      assert.equal(opts.headers.authorization, 'Bearer test-private-key');
      assert.equal(opts.redirect, 'error');
      return new Response(JSON.stringify({ results: [{ title: 'Formal verification', doi: 'https://doi.org/10.1234/test', publication_date: '2025-01-02',
        abstract_inverted_index: { uses: [2], Formal: [0], verification: [1], garbage: [-1, 10000000] }, primary_location: { source: { type: 'repository', display_name: 'arXiv' } } }] }));
    } });
    assert.equal(r.results[0].abstract, 'Formal verification uses');
    assert.equal(r.results[0].type, 'preprint');
    assert.ok(!JSON.stringify(r).includes('test-private-key'));
  } finally { config.scholar.openAlexKey = saved; }
});

test('网页搜索传递受控域名并再次过滤结果，支持取消与响应大小上限', async () => {
  const old = { ...config.web };
  Object.assign(config.web, { searchProvider: 'tavily', searchKey: 'test-key' });
  try {
    const r = await webSearch('verification', { domains: ['nist.gov'], fetchImpl: async (url, opts) => {
      assert.deepEqual(JSON.parse(opts.body).include_domains, ['nist.gov']);
      assert.equal(opts.redirect, 'error');
      return new Response(JSON.stringify({ results: [{ title: 'valid', url: 'https://www.nist.gov/report' }, { title: 'spoof', url: 'https://nist.gov.evil.test/report' }] }));
    } });
    assert.equal(r.results.length, 1);
    const controller = new AbortController();
    const pending = webSearch('q', { signal: controller.signal, fetchImpl: (url, opts) => new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason))) });
    controller.abort(new Error('user_stop'));
    await assert.rejects(pending, /user_stop/);
    let cancelled = false;
    const huge = await webSearch('q', { fetchImpl: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(config.web.maxBytes + 1)); }, cancel() { cancelled = true; } })) });
    assert.equal(huge.ok, false); assert.ok(cancelled);
  } finally { Object.assign(config.web, old); }
});

test('允许域名重定向到外站和缓存外站都无法绕过来源策略', async () => {
  clearWebCache();
  const old = config.web.fetchEnabled; config.web.fetchEnabled = true;
  try {
    let requests = 0;
    const deps = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], fetchImpl: async () => { requests++; return new Response('', { status: 302, headers: { location: 'https://evil.example/report' } }); }, urlPolicy: u => !!authorityUrl(u) };
    const blocked = await webFetch('https://nist.gov/report', deps);
    assert.equal(blocked.ok, false); assert.equal(requests, 1);
    const badCache = await webFetch('https://nist.gov/cached', { lookup: deps.lookup, fetchImpl: async url => url.includes('nist.gov')
      ? new Response('', { status: 302, headers: { location: 'https://evil.example/report' } })
      : new Response('<p>evil body</p>', { headers: { 'content-type': 'text/html' } }) });
    assert.equal(badCache.ok, true);
    const cached = await webFetch('https://nist.gov/cached', deps);
    assert.equal(cached.ok, false); assert.match(cached.reason, /缓存来源/);
  } finally { config.web.fetchEnabled = old; clearWebCache(); }
});
