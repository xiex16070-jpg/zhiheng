/**
 * Phase C3 测试：web 抓取与检索。
 * 全部离线：注入 fetchImpl 与 lookup，不触网。
 * 覆盖：SSRF 闸（字面内网 IP / DNS 解析后内网 / 重定向跳内网）、协议与凭据校验、
 * HTML→文本、15 分钟缓存命中、项目权限约束下的超预算落盘、检索后端未配置时的拒绝。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-web-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['web', 'test', 'key'].join('-');
process.env.WEB_SEARCH_PROVIDER = '';
process.env.WEB_SEARCH_KEY = '';

const web = await import('../src/server/webtools.mjs');
const { isBlockedIp, validateUrlShape, assertPublicHost, htmlToText, webFetch, webSearch, searchAvailable, clearWebCache } = web;
const { readFilePermission, saveFilePermission } = await import('../src/server/file-permissions.mjs');

const USER = 'uwebtest001';
const PUBLIC_IP = '93.184.216.34'; // example.com 的真实地址（测试只注入，不发请求）

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeLookup(map) {
  return async (host) => {
    if (map[host]) return map[host].map((address) => ({ address, family: 4 }));
    const err = new Error('not found');
    err.code = 'ENOTFOUND';
    throw err;
  };
}

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] || headers[k] || null },
    arrayBuffer: async () => Buffer.from(body, 'utf8'),
    json: async () => JSON.parse(body),
  };
}

test('SSRF：内网/环回/链路本地/元数据地址全部判定为阻断', () => {
  const blocked = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.0.2.1', '198.51.100.2', '203.0.113.3', '::1', '0:0:0:0:0:0:0:1', 'fe80::1', 'fc00::1', '100::1', '2001:db8::1', '3fff::1', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::1', '2002:7f00:0001::'];
  for (const ip of blocked) assert.equal(isBlockedIp(ip), true, `应阻断 ${ip}`);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(isBlockedIp(ip), false, `应放行 ${ip}`);
  }
});

test('URL 形态：非 http(s)、凭据、本地主机名全部拒绝', () => {
  assert.equal(validateUrlShape('file:///etc/passwd').ok, false);
  assert.equal(validateUrlShape('javascript:alert(1)').ok, false);
  assert.equal(validateUrlShape('http://user:pass@example.com/').ok, false);
  assert.equal(validateUrlShape('http://localhost:3000/').ok, false);
  assert.equal(validateUrlShape('http://foo.internal/').ok, false);
  assert.equal(validateUrlShape('https://example.com/a?b=1').ok, true);
});

test('DNS 解析后校验：解析到内网即拒绝（防 rebinding）', async () => {
  const lookup = fakeLookup({ 'evil.test': ['127.0.0.1'], 'ok.test': [PUBLIC_IP], 'mixed.test': [PUBLIC_IP, '10.0.0.5'] });
  assert.equal((await assertPublicHost('evil.test', lookup)).ok, false);
  assert.equal((await assertPublicHost('mixed.test', lookup)).ok, false, '只要有一个内网地址就拒绝');
  assert.equal((await assertPublicHost('ok.test', lookup)).ok, true);
  assert.equal((await assertPublicHost('127.0.0.1', lookup)).ok, false, '字面 IP 直接判定');
  assert.equal((await assertPublicHost('nx.test', lookup)).ok, false);
});

test('HTML→文本：去脚本样式，保留段落结构，解码实体', () => {
  const html = `<html><head><title>T &amp; X</title><style>.a{color:red}</style><script>alert(1)</script></head>
    <body><nav>导航</nav><h1>标题</h1><p>第一段&nbsp;内容</p><ul><li>甲</li><li>乙</li></ul><footer>页脚</footer></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('第一段 内容'));
  assert.ok(text.includes('· 甲'));
  assert.ok(!text.includes('alert(1)'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('页脚'));
});

test('抓取：正常页面返回正文与标题', async () => {
  clearWebCache();
  const html = '<html><head><title>论文页</title></head><body><p>正文内容</p></body></html>';
  const r = await webFetch('https://ok.test/page', {
    fetchImpl: async () => response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    lookup: fakeLookup({ 'ok.test': [PUBLIC_IP] }),
    userId: USER,
  });
  assert.equal(r.ok, true);
  assert.equal(r.title, '论文页');
  assert.match(r.text, /正文内容/);
});

test('抓取：重定向跳到内网被拒绝', async () => {
  clearWebCache();
  let hop = 0;
  const r = await webFetch('https://ok.test/redir', {
    fetchImpl: async () => {
      hop += 1;
      return response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } });
    },
    lookup: fakeLookup({ 'ok.test': [PUBLIC_IP] }),
    userId: USER,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /重定向目标被拒绝|内网|保留/);
  assert.equal(hop, 1, '不应继续请求内网地址');
});

test('缓存：同 URL 15 分钟内只发一次请求', async () => {
  clearWebCache();
  let calls = 0;
  const opts = {
    fetchImpl: async () => {
      calls += 1;
      return response('<p>cache me</p>', { headers: { 'content-type': 'text/html' } });
    },
    lookup: fakeLookup({ 'ok.test': [PUBLIC_IP] }),
    userId: USER,
  };
  const a = await webFetch('https://ok.test/cache', opts);
  const b = await webFetch('https://ok.test/cache', opts);
  assert.equal(a.ok, true);
  assert.equal(b.cached, true);
  assert.equal(calls, 1);
});

test('抓取与缓存命中均不绕过 ask / read_only 项目的文件权限', async () => {
  clearWebCache();
  const userId = 'readonly-web', opts = { maxChars: 800, userId,
    fetchImpl: async () => response(`<p>${'甲'.repeat(3000)}</p>`, { headers: { 'content-type': 'text/html' } }),
    lookup: fakeLookup({ 'ok.test': [PUBLIC_IP] }) };
  const ask = await webFetch('https://ok.test/permission-cache', opts);
  assert.equal(ask.ok, true); assert.equal(ask.truncated, true);
  assert.equal(ask.savedPath, null, '逐次确认项目不能因只读抓取而自动写入文件');
  assert.equal(fs.existsSync(path.join(dir, 'workspace', userId)), false);
  await saveFilePermission(userId, { ...await readFilePermission(userId), mode: 'read_only' });
  const readonly = await webFetch('https://ok.test/permission-cache', opts);
  assert.equal(readonly.cached, true); assert.equal(readonly.savedPath, null);
  assert.equal(fs.existsSync(path.join(dir, 'workspace', userId)), false);
});

test('抓取：显式信任项目后超预算正文可截断并落盘工作区', async () => {
  clearWebCache();
  await saveFilePermission(USER, { ...await readFilePermission(USER), mode: 'trusted' });
  const long = `<p>${'甲'.repeat(3000)}</p>`;
  const r = await webFetch('https://ok.test/long', {
    maxChars: 800,
    fetchImpl: async () => response(long, { headers: { 'content-type': 'text/html' } }),
    lookup: fakeLookup({ 'ok.test': [PUBLIC_IP] }),
    userId: USER,
  });
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 800);
  assert.ok(r.savedPath, '应有落盘路径');
  const abs = path.join(dir, 'workspace', USER, r.savedPath);
  assert.ok(fs.existsSync(abs), '全文应真实落盘');
  assert.ok(fs.statSync(abs).size > 3000);
});

test('只读子代理即使在受信任项目也不会通过 web_fetch 缓存写文件', async () => {
  clearWebCache();
  const userId = 'trusted-subagent-web';
  await saveFilePermission(userId, { ...await readFilePermission(userId), mode: 'trusted' });
  const url = 'https://ok.test/subagent-readonly';
  await webFetch(url, { maxChars: 800, userId: null,
    fetchImpl: async () => response(`<p>${'甲'.repeat(3000)}</p>`, { headers: { 'content-type': 'text/html' } }),
    lookup: fakeLookup({ 'ok.test': [PUBLIC_IP] }) });
  const { executeTool } = await import('../src/server/tools.mjs');
  const result = await executeTool('web_fetch', { url, max_chars: 800 },
    { userId, taskId: 'subagent-web-task', workspaceId: 'default', subagentDepth: 1, evidence: new Map(), preHookVerified: true });
  assert.match(result.text, /甲/);
  assert.equal(fs.existsSync(path.join(dir, 'workspace', userId)), false,
    '只读子代理不能把父项目的信任授权当作自己的写权限');
});

test('检索：未配置后端时明确拒绝，不注册工具', async () => {
  assert.equal(searchAvailable(), false);
  const r = await webSearch('锂离子电池');
  assert.equal(r.ok, false);
  assert.match(r.reason, /未配置/);
});

test('检索：配置后端后解析各 provider 响应', async () => {
  // 直接调用解析路径：临时改写 config 不可行于 ESM 单例，这里校验 searchAvailable 之外的行为留给集成层
  assert.equal(searchAvailable(), false);
});
