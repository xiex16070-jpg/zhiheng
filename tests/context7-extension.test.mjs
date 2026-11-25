import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const hosted = 'https://mcp.context7.com/mcp';
const marker = 'synthetic-context-fixture';
const inputSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: { libraryId: { type: 'string' }, query: { type: 'string' }, language: { type: 'string' } },
  required: ['libraryId', 'query'],
};
const tool = name => ({ name, inputSchema, annotations: { readOnlyHint: true } });

test('Context7 preset uses fixed transport, separate permissions and private replaceable credentials', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-context7-'));
  process.env.DATA_DIR = directory;
  const { createExtensions } = await import('../src/server/extensions.mjs');
  const { mcpFetch } = await import('../src/server/extension-network.mjs');
  const seen = [];
  let status = 200, catalog = ['resolve-library-id', 'query-docs', 'other-tool'];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ method: msg.method, auth: req.headers.authorization, params: msg.params });
    if (status !== 200) { res.writeHead(status); res.end('upstream private detail ' + marker); return; }
    if (msg.id === undefined) { res.writeHead(202); res.end(); return; }
    const result = msg.method === 'initialize' ? {
      protocolVersion: msg.params.protocolVersion, serverInfo: { name: 'fixture', version: '1' },
      capabilities: { tools: {}, resources: {} },
    } : msg.method === 'tools/list' ? { tools: catalog.map(tool) }
      : { content: [{ type: 'text', text: 'Versioned documentation ' + marker }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, 'extensions.json');
  const loopback = 'http://127.0.0.1:' + server.address().port + '/mcp';
  // The preset computes the production URL. The test redirects its HTTP transport
  // to a local protocol fixture, keeping Bearer construction and SDK behavior real.
  const httpFetch = (url, token, signal) => {
    assert.equal(url, hosted);
    const request = mcpFetch(loopback, token, signal);
    return (target, options) => { assert.equal(String(target), hosted); return request(loopback, options); };
  };
  const gateway = createExtensions({ file, httpFetch });
  await gateway.init();
  const state = () => gateway.status('alice');
  const save = input => gateway.save('alice', { revision: state().revision, ...input });
  assert.deepEqual(state().entries, []);
  assert.equal(seen.length, 0);
  for (const input of [{ url: loopback }, { enabled: true }, { clearToken: true, token: marker }]) {
    await assert.rejects(save({ preset: 'context7', ...input }), { code: 'invalid_settings' });
  }
  assert.equal(seen.length, 0);
  const first = (await save({ preset: 'context7', token: marker })).entries[0];
  assert.equal(first.preset, 'context7');
  assert.equal(first.kind, 'http');
  assert.equal(first.target, 'mcp.context7.com');
  assert.equal(first.tokenConfigured, true);
  assert.equal(first.enabled, false);
  assert.equal(first.serverCapabilities.resources, false);
  assert.deepEqual(first.tools.map(t => [t.name, t.allowed]), [['resolve-library-id', false], ['query-docs', false]]);
  assert.ok(seen.every(row => row.auth === 'Bearer ' + marker));
  assert.ok(!JSON.stringify(state()).includes(marker));
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(marker));
  assert.deepEqual(gateway.status('bob').entries, []);
  await assert.rejects(save({ id: first.id, url: loopback }), { code: 'invalid_settings' });
  await assert.rejects(save({ id: first.id, allowedTools: ['other-tool'] }), { code: 'invalid_settings' });
  await assert.rejects(save({ id: first.id, readOnlyTools: ['query-docs'] }), { code: 'invalid_settings' });
  await assert.rejects(save({ id: first.id, resourcesEnabled: true }), { code: 'invalid_settings' });
  const enabled = (await save({ id: first.id, enabled: true, allowedTools: ['query-docs'] })).entries[0];
  const args = { extension: first.id, revision: enabled.revision, tool: 'query-docs', arguments: {
    libraryId: '/example/library/v1', query: 'What is the public API?' } };
  assert.equal(gateway.isReadOnly('alice', 'call_extension', args), false);
  assert.equal(gateway.list('alice')[0].preset, 'context7');
  assert.match(gateway.approvalReason('alice', 'call_extension', args), /mcp\.context7\.com/);
  const count = seen.length;
  await assert.rejects(gateway.call('alice', args, { taskId: 'check' }), { code: 'approval_required' });
  await assert.rejects(gateway.call('bob', args, { taskId: 'check', approved: true }), { code: 'extension_changed' });
  await assert.rejects(gateway.call('alice', { ...args, arguments: { ...args.arguments, history: [] } },
    { taskId: 'check', approved: true }), { code: 'invalid_arguments' });
  await assert.rejects(gateway.call('alice', { ...args, arguments: { libraryId: 1 } },
    { taskId: 'check', approved: true }), { code: 'invalid_arguments' });
  assert.equal(seen.length, count);
  const reply = await gateway.call('alice', args, { taskId: 'check', approved: true });
  assert.match(reply.text, /Versioned documentation/);
  assert.ok(!reply.text.includes(marker));
  assert.deepEqual(seen.find(row => row.method === 'tools/call').params.arguments, args.arguments);
  const restored = createExtensions({ file, httpFetch });
  await restored.init();
  assert.equal(restored.status('alice').entries[0].tokenConfigured, true);
  for (const [code, reason] of [[401, 'context7_auth'], [403, 'context7_auth'], [429, 'context7_rate_limit'], [503, 'context7_unavailable']]) {
    status = code;
    await assert.rejects(save({ preset: 'context7', token: 'replacement-fixture' }),
      e => e.code === reason && !e.message.includes(marker));
    assert.equal(state().revision, enabled.revision);
  }
  status = 200;
  catalog = ['other-tool'];
  await assert.rejects(save({ preset: 'context7' }), { code: 'context7_tools_missing' });
  assert.equal(state().revision, enabled.revision);
  catalog = ['resolve-library-id', 'query-docs'];
  await save({ preset: 'context7', token: '' });
  assert.equal(seen.at(-1).auth, 'Bearer ' + marker);
  await save({ preset: 'context7', token: 'replacement-fixture' });
  assert.equal(seen.at(-1).auth, 'Bearer replacement-fixture');
  const cleared = (await save({ preset: 'context7', clearToken: true })).entries[0];
  assert.equal(cleared.tokenConfigured, false);
  assert.equal(cleared.id, first.id);
  assert.equal(seen.at(-1).auth, undefined);
  assert.equal(cleared.tools.filter(t => t.allowed).length, 1);
  await assert.rejects(gateway.call('alice', args, { taskId: 'check', approved: true }), { code: 'extension_changed' });
  const removed = await gateway.save('alice', { id: first.id, revision: state().revision }, { remove: true });
  assert.deepEqual(removed.entries, []);
});
