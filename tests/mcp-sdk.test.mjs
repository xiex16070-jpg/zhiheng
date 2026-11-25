import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lkba-sdk-'));
const corpus = path.join(root, 'papers.jsonl');
await fs.writeFile(corpus, '');
const kbFile = path.join(root, 'kb.json');
await fs.writeFile(kbFile, JSON.stringify({
  docs: ['alice', 'bob'].map((userId) => ({
    id: `${userId}-doc`, userId, name: `${userId}-private-paper`, kind: 'text',
    charCount: 12, chunkCount: 1, text: `${userId} private evidence`, createdAt: new Date().toISOString(),
  })),
  chunks: ['alice', 'bob'].map((userId) => ({
    id: `${userId}-doc_c0`, docId: `${userId}-doc`, userId, idx: 0, heading: '',
    text: `${userId} private evidence`, start: 0, end: 22,
  })),
}));
const env = {
  ...process.env,
  DATA_DIR: root, STORE_FILE: path.join(root, 'store.json'), KB_FILE: kbFile,
  VECTOR_FILE: path.join(root, 'vectors.json'), CORPUS_JSONL: corpus,
  MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '',
  EMBEDDING_PROVIDER: 'local', EMBEDDING_BASE_URL: '', LEARNING_ENABLED: 'false',
  MINERU_ENABLED: 'false', RERANK_ENABLED: 'false', MCP_ENABLED: 'true',
  MCP_SDK_ENABLED: 'true', MCP_TOKEN: '', MCP_TOKENS: 'sdk-alice:alice,sdk-bob:bob', MCP_USER_ID: 'alice',
  AUTH_SECRET: 'sdk-compatibility-tests', HOST: '127.0.0.1',
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
};
const clients = [];
let child;
after(async () => {
  await Promise.allSettled(clients.map((client) => client.close()));
  if (child && child.exitCode === null) {
    const ended = once(child, 'exit');
    child.kill();
    await ended;
  }
  await fs.rm(root, { recursive: true, force: true });
});

async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

test('官方 SDK Streamable HTTP 客户端兼容真实 /mcp 路由并保持租户隔离', async (t) => {
  const port = await freePort();
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (true) {
    try { if ((await (await fetch(`${base}/api/health`)).json()).ready) break; } catch {}
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`SDK server did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const connect = async (token) => {
    const client = new Client({ name: 'sdk-compat-test', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  };
  const [alice, bob] = await Promise.all([connect('sdk-alice'), connect('sdk-bob')]);

  await t.test('initialize / initialized / ping / tools/list 使用 SDK 协商，业务工具清单一致', async () => {
    assert.equal(alice.getServerVersion().name, 'csl-knowledge-mcp');
    assert.ok(alice.getServerCapabilities().tools);
    await alice.ping();
    const list = await alice.listTools();
    assert.deepEqual(list.tools.map((tool) => tool.name), [
      'search_knowledge', 'read_source', 'verify_quote', 'list_documents', 'corpus_stats',
      'qdrant-store', 'qdrant-find', 'kb_retrieve', 'ragflow_retrieve',
    ]);
    assert.deepEqual(list.tools.find((tool) => tool.name === 'verify_quote').inputSchema.required, ['ref', 'quote']);
  });
  await t.test('并发客户端不共享身份，工具参数不能冒充其他用户或通配全部用户', async () => {
    const [a, b] = await Promise.all([
      alice.callTool({ name: 'list_documents', arguments: {} }),
      bob.callTool({ name: 'list_documents', arguments: {} }),
    ]);
    assert.match(JSON.stringify(a), /alice-private-paper/);
    assert.doesNotMatch(JSON.stringify(a), /bob-private-paper/);
    assert.match(JSON.stringify(b), /bob-private-paper/);
    assert.doesNotMatch(JSON.stringify(b), /alice-private-paper/);
    await assert.rejects(alice.callTool({ name: 'list_documents', arguments: { user_id: 'bob' } }), /not authorized/);
    await assert.rejects(alice.callTool({ name: 'list_documents', arguments: { user_id: '*' } }), /not authorized/);
    const foreign = await alice.callTool({ name: 'read_source', arguments: { ref: 'bob-doc_c0' } });
    assert.equal(foreign.isError, true);
    assert.doesNotMatch(JSON.stringify(foreign), /bob private evidence/);
  });
  await t.test('未知工具和不合法参数产生标准 JSON-RPC 错误', async () => {
    await assert.rejects(alice.callTool({ name: 'missing_tool', arguments: {} }), /Unknown tool/);
    await assert.rejects(alice.callTool({ name: 'search_knowledge', arguments: { query: 123 } }), /Invalid tool arguments/);
    await assert.rejects(alice.callTool({ name: 'verify_quote', arguments: { ref: '1' } }), /Invalid tool arguments/);
  });
  await t.test('畸形 JSON 与超限原始请求由 SDK 返回协议错误', async () => {
    const headers = {
      authorization: 'Bearer sdk-alice',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const malformed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: '{' });
    assert.equal(malformed.status, 400);
    const parseError = await malformed.json();
    assert.equal(parseError.jsonrpc, '2.0');
    assert.equal(parseError.error.code, -32700);
    const oversized = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding: 'x'.repeat(1024 * 1024) } }),
    });
    assert.equal(oversized.status, 413);
    const sizeError = await oversized.json();
    assert.equal(sizeError.jsonrpc, '2.0');
    assert.equal(sizeError.error.code, -32000);
    assert.equal((await alice.listTools()).tools.length, 9, '拒绝非法请求后正常客户端仍可使用');
  });
  await t.test('HTTP 每请求鉴权，错误令牌和匿名均拒绝', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong-token' }, { 'x-user-id': 'alice' }]) {
      const response = await fetch(`${base}/mcp`, {
        method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assert.equal(response.status, 401);
    }
  });
  await t.test('无状态 GET/DELETE 返回 405，跨源请求拒绝', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${base}/mcp`, { method, headers: { authorization: 'Bearer sdk-alice' } });
      assert.equal(response.status, 405);
    }
    const response = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { authorization: 'Bearer sdk-alice', origin: 'https://untrusted.example', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  });
});

test('SDK stdio 与原有 stdio 都可由官方客户端初始化并调用工具', async () => {
  for (const enabled of ['false', 'true']) {
    const storeFile = path.join(root, 'stdio-prefs-' + enabled + '.json');
    const kbSnapshot = path.join(root, 'stdio-kb-' + enabled + '.json');
    const fixture = JSON.parse(await fs.readFile(kbFile, 'utf8'));
    const discipline = 'kb:da52da0d-6d69-4c73-8429-d3a002b907d2';
    fixture.sections = [{ id: discipline, userId: 'alice', name: '本地分区', summary: '', docIds: ['alice-doc'] }];
    await fs.writeFile(kbSnapshot, JSON.stringify(fixture));
    const client = new Client({ name: 'stdio-compat-test', version: '1.0.0' });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath, args: [path.join(ROOT, 'mcp-server.mjs')],
      cwd: ROOT, env: { ...env, MCP_SDK_ENABLED: enabled, STORE_FILE: storeFile, KB_FILE: kbSnapshot }, stderr: 'pipe',
    });
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === 'list_documents'));
    const result = await client.callTool({ name: 'list_documents', arguments: {} });
    assert.match(JSON.stringify(result), /alice-private-paper/);
    assert.doesNotMatch(JSON.stringify(result), /bob-private-paper/);
    const prefs = JSON.stringify({ preferences: { alice: { discipline } } });
    await fs.writeFile(storeFile, prefs);
    assert.match(JSON.stringify(await client.callTool({ name: 'read_source', arguments: { ref: 'alice-doc_c0' } })), /alice private evidence/);
    fixture.sections[0].docIds = [];
    await fs.writeFile(kbSnapshot, JSON.stringify(fixture));
    const excluded = await client.callTool({ name: 'read_source', arguments: { ref: 'alice-doc_c0' } });
    assert.equal(excluded.isError, true);
    assert.doesNotMatch(JSON.stringify(excluded), /alice private evidence/);
    await client.close();
    assert.equal(await fs.readFile(storeFile, 'utf8'), prefs);
  }
});
