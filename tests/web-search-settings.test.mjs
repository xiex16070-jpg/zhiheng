import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.AUTH_SECRET = 'web-settings-unit-secret';
const { createWebSearchSettings } = await import('../src/server/web-search-settings.mjs');
const { sealWebSearchKey, openWebSearchKey } = await import('../src/server/auth.mjs');
const { config } = await import('../src/server/config.mjs');
const { getToolSchemas, toolArgumentError } = await import('../src/server/tools.mjs');
const { webSearch } = await import('../src/server/webtools.mjs');
const { probeWebSearch } = await import('../src/server/web-search-probe.mjs');
const EMPTY = { searchProvider: '', searchKey: '', fetchEnabled: true };
const syntheticKey = 'tvly-fixture-valid-search-secret';

test('本机密钥采用随机nonce的认证加密，篡改无法解密', () => {
  const a = sealWebSearchKey(syntheticKey), b = sealWebSearchKey(syntheticKey);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(openWebSearchKey(a), syntheticKey);
  assert.ok(!JSON.stringify(a).includes(syntheticKey));
  assert.throws(() => openWebSearchKey({ ...a, tag: b.tag }));
  assert.throws(() => openWebSearchKey({ iv: 'bad' }));
});

test('保存/空白保留/禁用/移除/重启，原子写失败保持旧配置，冲突拒绝', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-search-settings-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.web-search.json');
  let live;
  const settings = createWebSearchSettings({ file, initial: EMPTY, onChange: value => { live = value; } });
  assert.equal((await settings.init()).configured, false);
  await assert.rejects(settings.save({ provider: 'tavily', apiKey: syntheticKey, enabled: true, fetchEnabled: true }), /其他窗口/);
  const patch = { revision: 0, provider: 'tavily', apiKey: syntheticKey, enabled: true, fetchEnabled: true };
  const saved = await settings.save(patch);
  assert.equal(saved.revision, 1);
  assert.equal(live.searchKey, syntheticKey);
  assert.equal(live.searchProvider, 'tavily');
  assert.ok(!JSON.stringify(saved).includes(syntheticKey));
  const raw = await fs.readFile(file, 'utf8');
  assert.ok(!raw.includes(syntheticKey));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(settings.save(patch), err => err.code === 'settings_conflict');
  await settings.save({ ...patch, revision: 1, apiKey: '', enabled: false });
  assert.equal(settings.credentials().apiKey, syntheticKey);
  assert.equal(live.searchProvider, '');
  const restarted = createWebSearchSettings({ file, initial: { ...EMPTY, searchProvider: 'serper', searchKey: 'environment-key-for-old-provider' } });
  assert.equal((await restarted.init()).enabled, false);
  assert.equal(restarted.credentials().apiKey, syntheticKey);
  await restarted.save({ revision: 2 }, { remove: true });
  const removed = createWebSearchSettings({ file, initial: { ...EMPTY, searchProvider: 'tavily', searchKey: syntheticKey } });
  assert.equal((await removed.init()).configured, false);
  await assert.rejects(removed.save({ ...patch, revision: 3, provider: 'http://evil.test' }), err => err.code === 'invalid_provider');
  const failing = createWebSearchSettings({ file, initial: EMPTY, write: async () => { throw new Error(syntheticKey); } });
  await failing.init();
  const before = failing.status();
  await assert.rejects(failing.save({ ...patch, revision: 3 }), err => err.code === 'settings_save_failed' && !err.message.includes(syntheticKey));
  assert.deepEqual(failing.status(), before);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['.credential-key', '.web-search.json']);
});

test('损坏或无法解密的保存记录会关闭搜索，不能恢复旧环境密钥', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-search-bad-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.web-search.json');
  await fs.writeFile(file, '{bad json');
  const settings = createWebSearchSettings({ file, initial: { ...EMPTY, searchProvider: 'tavily', searchKey: syntheticKey } });
  const state = await settings.init();
  assert.equal(state.unreadable, true);
  assert.equal(state.enabled, false);
  assert.equal(state.configured, false);
  assert.throws(() => settings.credentials(), err => err.code === 'missing_key');
});

test('实时工具目录更新并保留参数校验，草稿连接不修改全局配置', async () => {
  const previous = { ...config.web };
  try {
    Object.assign(config.web, EMPTY);
    assert.ok(!getToolSchemas().some(s => s.function.name === 'web_search'));
    assert.ok(toolArgumentError('web_search', { query: 42 }));
    const response = await webSearch('test', { connection: { provider: 'tavily', apiKey: syntheticKey }, fetchImpl: async (url, opts) => {
      assert.equal(url, 'https://api.tavily.com/search');
      assert.equal(opts.headers.authorization, 'Bearer ' + syntheticKey);
      assert.ok(!opts.body.includes(syntheticKey));
      return Response.json({ results: [{ title: 'NIST', url: 'https://nist.gov/report' }] });
    } });
    assert.equal(response.ok, true);
    assert.equal(config.web.searchKey, '');
    Object.assign(config.web, { searchProvider: 'tavily', searchKey: syntheticKey });
    assert.ok(getToolSchemas().some(s => s.function.name === 'web_search'));
    const error = await webSearch('test', { fetchImpl: async () => { throw new Error(syntheticKey); } });
    assert.ok(!JSON.stringify(error).includes(syntheticKey));
  } finally { Object.assign(config.web, previous); }
});

test('连接测试仅返回状态和数量，失败不会转发上游错误文本', async () => {
  const connection = { provider: 'tavily', apiKey: syntheticKey };
  const ok = await probeWebSearch(connection, { search: async (q, opts) => {
    assert.equal(q, 'NIST AI Risk Management Framework');
    assert.deepEqual(opts.domains, ['nist.gov']);
    assert.equal(opts.count, 1);
    assert.equal(opts.connection, connection);
    return { ok: true, results: [{ snippet: syntheticKey }] };
  } });
  assert.equal(ok.resultCount, 1);
  assert.ok(!JSON.stringify(ok).includes(syntheticKey));
  const denied = await probeWebSearch(connection, { search: async () => ({ ok: false, status: 401, reason: syntheticKey }) });
  assert.equal(denied.code, 'authentication_failed');
  assert.ok(!JSON.stringify(denied).includes(syntheticKey));
});

test('多引擎和学术配置各自持久化，切换/删除不会覆盖其他密钥', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-search-multi-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  let live, scholar;
  const make = () => createWebSearchSettings({ file, initial: EMPTY, onChange: c => { live = c; }, onScholarChange: c => { scholar = c; } });
  const settings = make(); await settings.init();
  const patch = { enabled: true, fetchEnabled: true };
  await settings.save({ ...patch, provider: 'tavily', apiKey: syntheticKey, revision: 0 });
  await settings.save({ ...patch, provider: 'serper', apiKey: 'synthetic-serper-secret', revision: 1 });
  await settings.save({ ...patch, provider: 'openalex', apiKey: 'synthetic-openalex-secret', revision: 2 });
  assert.equal(live.searchConnections.length, 2);
  assert.equal(scholar.openAlexKey, 'synthetic-openalex-secret');
  const reloaded = make(); await reloaded.init();
  assert.equal(reloaded.credentials({ provider: 'tavily' }).apiKey, syntheticKey);
  assert.equal(reloaded.credentials({ provider: 'serper' }).apiKey, 'synthetic-serper-secret');
  await reloaded.save({ provider: 'serper', revision: 3 }, { remove: true });
  assert.equal(live.searchConnections.length, 1); assert.equal(live.searchConnections[0].provider, 'tavily');
  assert.equal(scholar.openAlexKey, 'synthetic-openalex-secret');
  await reloaded.save({ ...patch, provider: 'europepmc', enabled: false, revision: 4 });
  assert.equal(scholar.europePmcEnabled, false);
});

test('旧 v1 密钥自动迁移到独立凭据密钥，登录 secret 轮换不破坏 v2', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-search-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, revision: 7, provider: 'tavily', enabled: true, fetchEnabled: true, sealedKey: sealWebSearchKey(syntheticKey) }));
  const s = createWebSearchSettings({ file, initial: EMPTY }); await s.init();
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).version, 2);
  const old = config.auth.secret; config.auth.secret = 'rotated-login-secret';
  try {
    const next = createWebSearchSettings({ file, initial: EMPTY }); await next.init();
    assert.equal(next.credentials().apiKey, syntheticKey); assert.equal(next.status().revision, 7);
  } finally { config.auth.secret = old; }
});

test('两引擎并行合并去重，一个失败不会丢掉另一引擎结果', async () => {
  const previous = config.web.searchConnections;
  config.web.searchConnections = [{ provider: 'tavily', apiKey: syntheticKey }, { provider: 'serper', apiKey: 'synthetic-serper-secret' }];
  try {
    const r = await webSearch('formal verification', { fetchImpl: async url => url.includes('tavily')
      ? Response.json({ results: [{ title: 'First', url: 'https://nist.gov/a' }] })
      : Response.json({ organic: [{ title: 'Duplicate', link: 'https://nist.gov/a' }, { title: 'Other', link: 'https://nist.gov/b' }] }) });
    assert.equal(r.results.length, 2); assert.equal(r.providers.length, 2);
    const partial = await webSearch('formal verification', { fetchImpl: async url => url.includes('tavily') ? new Response('', { status: 429 }) : Response.json({ organic: [{ title: 'Other', link: 'https://nist.gov/b' }] }) });
    assert.equal(partial.ok, true); assert.equal(partial.results.length, 1);
  } finally { config.web.searchConnections = previous; }
});
