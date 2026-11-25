import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-extensions-test-'));
process.env.DATA_DIR = root;
process.env.AUTH_SECRET = 'parent-auth-must-not-inherit';
const { createExtensions, validateExtensionTools } = await import('../src/server/extensions.mjs');
const { pinnedRequest } = await import('../src/server/extension-network.mjs');
const { resolveSafe } = await import('../src/server/workspace.mjs');
after(() => fs.rm(root, { recursive: true, force: true }));

test('真实 stdio 发现与执行：身份、工具权限、版本、审批、Schema 改变、脱敏和重启', async () => {
  const file = path.join(root, 'extensions.json'), gateway = createExtensions({ file });
  await gateway.init();
  let state = await gateway.save('alice', { id: 'fixture', name: 'Fixture', kind: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('../scripts/fixtures/extension-server.mjs', import.meta.url))], env: { SERVICE_KEY: 'synthetic-plugin-secret' }, revision: 0 });
  assert.equal(state.entries[0].tools.length, 1);
  assert.equal(gateway.list('alice').length, 0);
  assert.equal(gateway.status('bob').entries.length, 0);
  state = await gateway.save('alice', { id: 'fixture', revision: 1, enabled: true, allowedTools: ['write_note'] });
  const args = { extension: 'fixture', revision: state.entries[0].revision, tool: 'write_note', arguments: { text: 'approved content' } };
  const options = { approved: true, taskId: 'task-1' };
  await assert.rejects(gateway.call('alice', args, { taskId: 'task-1' }), e => e.code === 'approval_required');
  await assert.rejects(gateway.call('bob', args, options), e => e.code === 'extension_changed');
  await assert.rejects(gateway.call('alice', { ...args, revision: 1 }, options), e => e.code === 'extension_changed');
  await assert.rejects(gateway.call('alice', { ...args, arguments: { text: 12 } }, options), e => e.code === 'invalid_arguments');
  const output = resolveSafe('alice', 'approved-note.txt').abs;
  await assert.rejects(fs.access(output));
  const result = await gateway.call('alice', args, options);
  assert.equal(await fs.readFile(output, 'utf8'), 'approved content');
  assert.ok(!result.text.includes('synthetic-plugin-secret'));
  assert.match(result.text, /parentAuthPresent\\?":false/);
  const disk = await fs.readFile(file, 'utf8'); assert.ok(!disk.includes('synthetic-plugin-secret'));
  const restored = createExtensions({ file }); await restored.init();
  assert.equal(restored.tools('alice', 'fixture').tools[0].name, 'write_note');
  assert.ok(!JSON.stringify(restored.status('alice')).includes('synthetic-plugin-secret'));
  await assert.rejects(gateway.save('alice', { id: 'leaky', kind: 'stdio', command: process.execPath,
    args: [fileURLToPath(new URL('../scripts/fixtures/extension-server.mjs', import.meta.url))],
    env: { SERVICE_KEY: 'synthetic-plugin-secret', EXPOSE_CATALOG: '1' }, revision: 2 }), e => e.code === 'credential_in_catalog' && !e.message.includes('synthetic-plugin-secret'));
  await fs.writeFile(resolveSafe('alice', 'change-schema').abs, '1');
  await assert.rejects(restored.call('alice', args, options), e => e.code === 'tool_changed');
  await gateway.save('alice', { id: 'fixture', revision: 2, enabled: false });
  await assert.rejects(gateway.call('alice', args, options), e => e.code === 'extension_changed');
});

test('真实 Streamable HTTP MCP 客户端连通固定端点，禁止跨站重定向', async t => {
  const tool = { name: 'echo', description: 'read fixture value', inputSchema: { type: 'object', additionalProperties: false, properties: {} } };
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
    const server = new Server({ name: 'http-fixture', version: '1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
    server.setRequestHandler(CallToolRequestSchema, async () => { if (req.url === '/error') throw new Error('synthetic-http-secret'); return { content: [{ type: 'text', text: 'HTTP connected' }] }; });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport); await transport.handleRequest(req, res);
  });
  await new Promise(r => httpServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => httpServer.close(r)));
  const url = 'http://127.0.0.1:' + httpServer.address().port;
  const gateway = createExtensions({ file: path.join(root, 'http-extensions.json') }); await gateway.init();
  const saved = await gateway.save('bob', { id: 'http', kind: 'http', url: url + '/mcp', revision: 0, enabled: true, allowedTools: ['echo'] });
  const result = await gateway.call('bob', { extension: 'http', revision: saved.entries[0].revision, tool: 'echo', arguments: {} }, { approved: true, taskId: 'task-http' });
  assert.match(result.text, /HTTP connected/);
  const error = await gateway.save('bob', { id: 'error', kind: 'http', url: url + '/error', token: 'synthetic-http-secret', revision: 1, enabled: true, allowedTools: ['echo'] });
  await assert.rejects(gateway.call('bob', { extension: 'error', revision: error.entries.find(e => e.id === 'error').revision, tool: 'echo', arguments: {} }, { approved: true, taskId: 'task-error' }), e => e.code === 'connection_failed' && !e.message.includes('synthetic-http-secret'));
  await assert.rejects(gateway.save('bob', { id: 'redirect', kind: 'http', url: url + '/redirect', revision: 2 }), e => e.code === 'connection_failed');
});

test('网关拒绝动态 Schema、未经配置的私网以及无审批调用', async () => {
  assert.throws(() => validateExtensionTools([{ name: 'unsafe', inputSchema: { type: 'object', properties: { x: { type: 'string', pattern: '(a+)+$' } } } }]), /Schema/);
  assert.throws(() => validateExtensionTools([{ name: 'unsafe', inputSchema: { type: 'object', $ref: 'https://evil.test' } }]), /Schema/);
  await assert.rejects(pinnedRequest('http://169.254.169.254/latest/meta-data/'), /blocked/);
  await assert.rejects(pinnedRequest('http://127.0.0.1:3000/api/bootstrap'), /blocked/);
});

test('损坏或无法解密的插件库拒绝写入，保留原始字节供恢复', async () => {
  for (const [name, bytes] of [['broken', '{broken'], ['encrypted', JSON.stringify({ version: 1, revision: 0, entries: [{ id: 'old', owner: 'alice', sealed: { broken: true } }] })]]) {
    const file = path.join(root, name + '.json'); await fs.writeFile(file, bytes);
    const gateway = createExtensions({ file }); await gateway.init();
    assert.equal(gateway.status('alice').unreadable, true);
    await assert.rejects(gateway.save('alice', { kind: 'browser', revision: 0 }), e => e.code === 'settings_unreadable');
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
  }
});

test('启动拒绝旧版已加密保存的凭据目录，整库失败关闭且保留密文', async () => {
  const { createCredentialCodec } = await import('../src/server/credential-codec.mjs');
  const dir = await fs.mkdtemp(path.join(root, 'legacy-'));
  const file = path.join(dir, 'extensions.json'), codec = createCredentialCodec(dir);
  const token = 'synthetic"legacy\\secret';
  const clean = { id: 'clean', owner: 'alice', name: 'Clean', kind: 'http', url: 'https://example.invalid/mcp', enabled: true, revision: 1,
    token, tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: {} } }], allowedTools: ['echo'] };
  const cleanRow = { id: clean.id, owner: clean.owner, sealed: await codec.seal(JSON.stringify(clean), 'extension:alice:clean') };
  const cleanBytes = JSON.stringify({ version: 1, revision: 1, entries: [cleanRow] });
  await fs.writeFile(file, cleanBytes);
  const gateway = createExtensions({ file }); await gateway.init();
  assert.equal(gateway.list('alice').length, 1);
  for (const leak of ['description', 'schema-key']) {
    const unsafe = structuredClone(clean); unsafe.id = 'legacy';
    if (leak === 'description') unsafe.tools[0].description = token;
    else unsafe.tools[0].inputSchema.properties[token] = { type: 'string' };
    const row = { id: unsafe.id, owner: unsafe.owner, sealed: await codec.seal(JSON.stringify(unsafe), 'extension:alice:legacy') };
    const bytes = JSON.stringify({ version: 1, revision: 2, entries: [cleanRow, row] });
    await fs.writeFile(file, bytes);
    for (const vault of [gateway, createExtensions({ file })]) {
      await vault.init();
      assert.equal(vault.status('alice').unreadable, true, leak);
      assert.deepEqual(vault.status('alice').entries, []);
      assert.deepEqual(vault.list('alice'), []);
      assert.throws(() => vault.tools('alice', 'legacy'), error => error.code === 'extension_unavailable');
      assert.throws(() => vault.tools('alice', 'clean'), error => error.code === 'extension_unavailable');
      await assert.rejects(vault.save('alice', { kind: 'browser', revision: 2 }), error => error.code === 'settings_unreadable');
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
    }
  }
  await fs.writeFile(file, cleanBytes); await gateway.init();
  assert.equal(gateway.status('alice').unreadable, false);
  assert.equal(gateway.tools('alice', 'clean').tools[0].description, 'Echo');
});

test('read-only exemption comes from explicit owner configuration, not MCP hints or model arguments',async t=>{
  const tool={name:'read_value',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{}}};let executed=0;
  const server=http.createServer(async(req,res)=>{const mcp=new Server({name:'readonly-fixture',version:'1'},{capabilities:{tools:{}}});mcp.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[tool]}));mcp.setRequestHandler(CallToolRequestSchema,async()=>{executed++;return {content:[{type:'text',text:'read result'}]};});const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});res.on('close',()=>{transport.close().catch(()=>{});mcp.close().catch(()=>{});});await mcp.connect(transport);await transport.handleRequest(req,res);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const gateway=createExtensions({file:path.join(root,'readonly-grants.json')});await gateway.init();
  let saved=await gateway.save('reader',{id:'read',kind:'http',url:'http://127.0.0.1:'+server.address().port,revision:0,enabled:true,allowedTools:['read_value']});
  let args={extension:'read',revision:saved.entries[0].revision,tool:'read_value',arguments:{}};
  assert.equal(gateway.isReadOnly('reader','call_extension',args),false);await assert.rejects(gateway.call('reader',args,{taskId:'readtask'}),{code:'approval_required'});assert.equal(executed,0);
  saved=await gateway.save('reader',{id:'read',revision:saved.revision,readOnlyTools:['read_value']});args={...args,revision:saved.entries[0].revision};
  assert.equal(gateway.isReadOnly('reader','call_extension',args),true);assert.match((await gateway.call('reader',args,{taskId:'readtask'})).text,/read result/);assert.equal(executed,1);
  assert.equal(gateway.isReadOnly('other','call_extension',args),false);assert.equal(gateway.isReadOnly('reader','call_extension',{...args,revision:1}),false);
  saved=await gateway.save('reader',{id:'browser',kind:'browser',revision:saved.revision,enabled:true});const browser=saved.entries.find(e=>e.id==='browser');
  for(const name of ['browser_snapshot','browser_wait'])assert.equal(gateway.isReadOnly('reader','call_extension',{extension:'browser',revision:browser.revision,tool:name,arguments:{}}),true);
  for(const action of ['new','switch','close'])assert.equal(gateway.isReadOnly('reader','call_extension',{extension:'browser',revision:browser.revision,tool:'browser_tab',arguments:{action}}),false);
  assert.equal(gateway.isReadOnly('reader','call_extension',{extension:'browser',revision:browser.revision,tool:'browser_tab',arguments:{action:'list'}}),true);
});
