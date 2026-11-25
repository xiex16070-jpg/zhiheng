/**
 * R02 集成测试：MCP 令牌绑定身份 + 前端不再发送明文身份头。
 * 离线运行：子进程启动服务（MCP_TOKENS 双令牌）、临时数据目录、固定 AUTH_SECRET。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = 'mcp-unit-secret';

/** 直接构造合法的新格式签名 Cookie（`id.exp.sig`），模拟已登录用户 */
function cookieFor(id) {
  const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
  const sig = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url').slice(0, 22);
  return `uid=${id}.${exp}.${sig}`;
}

const children = [];
async function startServer(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lkba-mcp-${port}-`));
  fs.writeFileSync(path.join(dir, 'papers.jsonl'), '');
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dir,
    STORE_FILE: path.join(dir, 'store.json'),
    KB_FILE: path.join(dir, 'kb.json'),
    VECTOR_FILE: path.join(dir, 'vectors.json'),
    CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false',
    REDIS_ENABLED: 'false',
    QDRANT_URL: '',
    AUTH_SECRET: SECRET,
    LEARNING_ENABLED: 'false',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost,::1',
    ...extraEnv,
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  children.push({ child, dir });
  child.stdout.resume();
  child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      const j = await (await fetch(`${base}/api/health`)).json();
      if (j.ready) return base;
    } catch {}
    if (Date.now() - t0 > 25000) throw new Error(`server ${port} not ready`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const rpc = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } });

let BASE;
let PROXYBASE;

test('启动带双令牌的 MCP 服务与 TRUST_PROXY 服务', async () => {
  BASE = await startServer(3985, { MCP_TOKENS: 't1alice:alice,t2bob:bob' });
  PROXYBASE = await startServer(3984, { TRUST_PROXY: '1' });

  // 以 alice / bob 的签名身份各导入一篇文档（文件名带 MARKER，list_documents 返回文件名）
  for (const [uid, marker] of [['alice', 'ALICE-DOC-MARKER 量子点荧光光谱'], ['bob', 'BOB-DOC-MARKER 钛合金疲劳裂纹']]) {
    const fd = new FormData();
    fd.append('file', new Blob([`# ${marker}\n\n${marker} 的正文内容，用于归属校验。`], { type: 'text/markdown' }), `${marker.split(' ')[0]}.md`);
    const r = await fetch(`${BASE}/api/kb/import`, { method: 'POST', body: fd, headers: { cookie: cookieFor(uid) } });
    assert.equal(r.status, 200, `${uid} 导入失败`);
  }
});

test('前端源码不再出现明文身份头', () => {
  const dir = path.join(ROOT, 'src', 'ui');
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(js|mjs)$/.test(f)) continue;
    const txt = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!txt.includes('x-user-id'), `${f} 仍包含 x-user-id`);
  }
});

test('配置令牌后：匿名 / 错令牌 / 缺 Scheme 一律 401（含 GET 清单）', async () => {
  const post = (body, headers = {}) =>
    fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post(rpc('tools/list'))).status, 401);
  assert.equal((await post(rpc('tools/list'), { authorization: 'Bea' + 'rer wrong-token' })).status, 401);
  assert.equal((await post(rpc('tools/list'), { authorization: 't1alice' })).status, 401); // 缺 Scheme
  assert.equal((await fetch(`${BASE}/mcp`)).status, 401, 'GET 清单未授权应 401');
  assert.equal((await fetch(`${BASE}/mcp`, { headers: { authorization: 'Bea' + 'rer t1alice' } })).status, 200);
});

test('令牌绑定身份：alice 令牌只看到 alice 的文档，bob 同理', async () => {
  const call = async (token) => {
    const r = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: rpc('list_documents'),
    });
    assert.equal(r.status, 200);
    return JSON.stringify(await r.json());
  };
  const asAlice = await call('t1alice');
  assert.ok(asAlice.includes('ALICE-DOC-MARKER'), 'alice 应看到自己的文档');
  assert.ok(!asAlice.includes('BOB-DOC-MARKER'), 'alice 不应看到 bob 的文档（N-03）');

  const asBob = await call('t2bob');
  assert.ok(asBob.includes('BOB-DOC-MARKER'));
  assert.ok(!asBob.includes('ALICE-DOC-MARKER'));
});

test('TRUST_PROXY：带 X-Forwarded-For 的“回环”请求无令牌 → 401；真实回环无令牌 → 放行', async () => {
  const body = rpc('list_documents');
  const withXff = await fetch(`${PROXYBASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4' },
    body,
  });
  assert.equal(withXff.status, 401, '反代转发的外部请求不得享受回环豁免');
  const loopback = await fetch(`${PROXYBASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  assert.equal(loopback.status, 200, '未配令牌时真实回环仍可用（Claude Desktop 单机场景）');
});

after(() => {
  for (const { child, dir } of children) {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
