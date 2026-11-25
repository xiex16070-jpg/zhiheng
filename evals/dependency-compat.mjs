/** Run with the independent eval package, outside the application's test discovery.
 * EVAL_DEPENDENCY_ROOT can point to the model-lab package to check its same lock.
 */
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AgentProvider from './provider.mjs';

const dependencyRoot = path.resolve(process.env.EVAL_DEPENDENCY_ROOT || path.dirname(fileURLToPath(import.meta.url)));
const requireDependency = createRequire(path.join(dependencyRoot, 'package.json'));
const load = (name) => import(pathToFileURL(requireDependency.resolve(name)).href);
const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'zhiheng-dependency-compat-'));
process.env.PROMPTFOO_CONFIG_DIR = path.join(temporary, 'promptfoo');
process.env.PROMPTFOO_DISABLE_TELEMETRY = '1';
process.env.PROMPTFOO_DISABLE_UPDATE = '1';
process.env.PROMPTFOO_DISABLE_REMOTE_GENERATION = 'true';

after(async () => {
  // Only remove the unique system-temp directory created by this test process.
  if (path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('zhiheng-dependency-compat-')) {
    await fsp.rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
async function textOf(stream) {
  let result = '';
  for await (const chunk of stream) result += chunk.toString();
  return result;
}
async function request(url, agent) {
  const response = await new Promise((resolve, reject) => {
    const req = http.get(url, { agent, signal: AbortSignal.timeout(5000) }, resolve);
    req.once('error', reject);
  });
  assert.equal(response.statusCode, 200);
  return textOf(response);
}

test('security overrides retain the pinned Promptfoo release', async () => {
  const manifest = JSON.parse(await fsp.readFile(path.join(dependencyRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies.promptfoo, '0.125.1');
  for (const [name, version] of Object.entries({ 'basic-ftp': '6.2.6', glob: '14.0.2', minimatch: '11.0.1' })) {
    assert.equal(manifest.overrides[name], version);
    const installed = JSON.parse(await fsp.readFile(path.join(dependencyRoot, 'node_modules', name, 'package.json'), 'utf8'));
    assert.equal(installed.version, version);
  }
});

test('glob ESM/CJS exports preserve Unicode, escaped paths, braces and ignores', async () => {
  const folder = path.join(temporary, '研究 [1]');
  await fsp.mkdir(path.join(folder, 'nested'), { recursive: true });
  await fsp.writeFile(path.join(folder, '证据.md'), 'source');
  await fsp.writeFile(path.join(folder, 'nested', 'case.json'), '{}');
  await fsp.writeFile(path.join(folder, 'nested', 'ignored.json'), '{}');
  const esm = await import(pathToFileURL(path.join(dependencyRoot, 'node_modules/glob/dist/esm/index.min.js')).href);
  for (const api of [esm, requireDependency('glob')]) {
    assert.equal(api.hasMagic('**/*.{md,json}'), true);
    assert.deepEqual(api.globSync('**/*.{md,json}', { cwd: folder, ignore: '**/ignored.json', nodir: true }).map((file) => file.replaceAll('\\', '/')).sort(), ['nested/case.json', '证据.md']);
    const escaped = api.escape(folder.replaceAll('\\', '/'), { windowsPathsNoEscape: true });
    assert.equal(api.globSync(`${escaped}/证据.md`, { windowsPathsNoEscape: true }).length, 1);
  }
});

test('glob cancellation stops traversal after its first directory read', async () => {
  const { glob } = await load('glob');
  const folder = path.join(temporary, 'cancel');
  for (let i = 0; i < 12; i++) await fsp.mkdir(path.join(folder, `child-${i}`, 'grandchild'), { recursive: true });
  const controller = new AbortController();
  let reads = 0;
  const instrumentedFs = {
    readdir: (dir, options, callback) => {
      reads++;
      fs.readdir(dir, options, (error, entries) => {
        controller.abort(new Error('compatibility-cancel'));
        callback(error, entries);
      });
    },
  };
  await assert.rejects(glob('**/*', { cwd: folder, fs: instrumentedFs, signal: controller.signal }), /compatibility-cancel/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reads, 1, 'aborted traversal must not read child directories');
});

test('minimatch preserves common patterns and bounds globparts amplification', async () => {
  const { minimatch, Minimatch } = await load('minimatch');
  assert.equal(minimatch('docs/证据.md', '**/*.{md,txt}'), true);
  assert.equal(minimatch('docs/private/证据.md', '**/private/**'), true);
  assert.equal(minimatch('docs/.hidden', '**/*', { dot: true }), true);
  assert.equal(minimatch('docs/证据.pdf', '**/*.{md,txt}'), false);
  assert.equal(minimatch('C:/研究/证据.md', 'C:\\研究\\*.md', { windowsPathsNoEscape: true }), true);
  const bounded = new Minimatch(`${'**/../a/b/'.repeat(8)}file`, { optimizationLevel: 2, braceExpandMax: 8 });
  assert.ok(bounded.globParts.length <= 8, 'pattern preprocessing must honor its configured budget');
});

test('Promptfoo evaluate uses the real AgentProvider against an isolated HTTP fixture', { timeout: 30000 }, async () => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    calls.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/bootstrap') {
      res.setHeader('set-cookie', 'compat-session=fixture; HttpOnly');
      res.end('{}');
    } else if (req.headers.cookie !== 'compat-session=fixture') {
      res.writeHead(401).end('{}');
    } else if (req.url === '/api/preferences') {
      const body = JSON.parse(await textOf(req));
      res.end(JSON.stringify(body));
    } else if (req.url === '/api/search') {
      const body = JSON.parse(await textOf(req));
      assert.equal(body.query, '如何验证规则？');
      res.end(JSON.stringify({ results: [{ ref: 'fixture-1', snippet: '规则验证需要证据。' }] }));
    } else res.writeHead(404).end('{}');
  });
  const port = await listen(server);
  try {
    const { evaluate } = await load('promptfoo');
    const record = await evaluate({ providers: [new AgentProvider({ config: { mode: 'retrieval', baseUrl: `http://127.0.0.1:${port}` } })],
      prompts: ['{{question}}'], writeLatestResults: false,
      tests: [{ vars: { question: '如何验证规则？', case: { id: 'compat-fixture' } }, assert: [{ type: 'javascript', value: (output) => JSON.parse(output).retrieval.results[0].ref === 'fixture-1' }] }],
    }, { cache: false, maxConcurrency: 1, progressBar: false });
    const summary = await record.toEvaluateSummary();
    assert.equal(summary.stats.successes, 1);
    assert.equal(summary.stats.failures + summary.stats.errors, 0);
    assert.deepEqual(calls, ['/api/bootstrap', '/api/preferences', '/api/search']);
  } finally { await close(server); }
});

test('model-lab LocalModelProvider remains compatible when checking the lab lock', { timeout: 30000 }, async (t) => {
  const manifest = JSON.parse(await fsp.readFile(path.join(dependencyRoot, 'package.json'), 'utf8'));
  if (manifest.name !== 'zhiheng-model-lab') return t.skip('only applicable to the model-lab package');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push(JSON.parse(await textOf(req)));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: 'fixture-answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
  });
  const port = await listen(server);
  try {
    const { default: Provider } = await import(pathToFileURL(path.join(dependencyRoot, 'evals/provider.mjs')).href);
    const provider = new Provider({ baseUrl: `http://127.0.0.1:${port}/v1`, variant: 'base', model: 'fixture-only', maxTokens: 16, timeoutMs: 5000 });
    const { evaluate } = await load('promptfoo');
    const record = await evaluate({ providers: [provider], prompts: ['{{question}}'], writeLatestResults: false,
      tests: [{ vars: { question: 'fixture', case: { id: 'compat-lab', category: 'logic', question: 'fixture' } }, assert: [{ type: 'equals', value: 'fixture-answer' }] }],
    }, { cache: false, maxConcurrency: 1, progressBar: false });
    assert.equal((await record.toEvaluateSummary()).stats.successes, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].chat_template_kwargs.enable_thinking, false);
    assert.equal(provider.calls[0].requestCompleted, true);
  } finally { await close(server); }
});

// Small loopback FTP fixture exercises get-uri's MDTM -> client.list fallback and download.
async function ftpFixture(content, { unix = false } = {}) {
  const sockets = new Set();
  const passiveServers = new Set();
  const commands = [];
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // Clients close data/control sockets after each download; Windows may report
    // that peer shutdown as a reset on this fixture's server-side socket.
    socket.on('error', (error) => { if (error.code !== 'ECONNRESET') throw error; });
    return socket;
  };
  const server = net.createServer((raw) => {
    const control = track(raw);
    let pending = '';
    let dataConnection;
    control.write('220 compatibility fixture\r\n');
    control.on('data', (data) => {
      pending += data.toString();
      let end;
      while ((end = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, end); pending = pending.slice(end + 2);
        const verb = line.split(' ')[0]; commands.push(verb);
        if (verb === 'EPSV') {
          const dataServer = net.createServer(); passiveServers.add(dataServer);
          dataConnection = once(dataServer, 'connection').then(([socket]) => { dataServer.close(); return track(socket); });
          dataServer.listen(0, '127.0.0.1', () => control.write(`229 (|||${dataServer.address().port}|)\r\n`));
        } else if (verb === 'LIST' || verb === 'MLSD' || verb === 'RETR') {
          control.write('150 data follows\r\n');
          void dataConnection.then((socket) => {
            const payload = verb === 'RETR' ? content : unix
              ? '-rw-r--r-- 1 owner group 64 Jan 1 2025 fixture.pac\r\n'
              : 'type=file;size=64;modify=20250101000000; fixture.pac\r\n';
            socket.end(payload, () => { if (!control.destroyed) control.write('226 transfer complete\r\n'); });
          });
        } else if (verb === 'USER') control.write('331 password required\r\n');
        else if (verb === 'PASS') control.write('230 logged in\r\n');
        else if (verb === 'FEAT') control.write(unix ? '211 no extensions\r\n' : '211-Features\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
        else if (verb === 'MDTM') control.write('502 MDTM not supported\r\n');
        else if (verb === 'QUIT') control.end('221 goodbye\r\n');
        else control.write('200 OK\r\n');
      }
    });
  });
  const port = await listen(server);
  return { url: `ftp://127.0.0.1:${port}/fixture.pac`, commands, close: async () => {
    for (const socket of sockets) socket.destroy();
    for (const passive of passiveServers) await close(passive);
    await close(server);
  } };
}

test('basic-ftp parses ordinary Unix listings with its safer parser', { timeout: 10000 }, async () => {
  const fixture = await ftpFixture('', { unix: true });
  const { Client } = await load('basic-ftp');
  const client = new Client(5000);
  try {
    const url = new URL(fixture.url);
    await client.access({ host: url.hostname, port: Number(url.port) });
    const entries = await client.list('/');
    assert.equal(entries[0].name, 'fixture.pac');
    assert.equal(entries[0].size, 64);
    assert.ok(fixture.commands.includes('LIST'));
  } finally { client.close(); await fixture.close(); }
});

test('get-uri FTP listing fallback and proxy-agent pac+ftp remain functional', { timeout: 15000 }, async () => {
  const ftp = await ftpFixture('function FindProxyForURL() { return "DIRECT"; }');
  const target = http.createServer((_req, res) => res.end('loopback-success'));
  const port = await listen(target);
  let agent;
  try {
    const { getUri } = await load('get-uri');
    assert.match(await textOf(await getUri(ftp.url)), /FindProxyForURL/);
    const { ProxyAgent } = await load('proxy-agent');
    // Override lookup explicitly: never consult or print operator proxy settings.
    agent = new ProxyAgent({ getProxyForUrl: () => `pac+${ftp.url}` });
    assert.equal(await request(`http://127.0.0.1:${port}/fixture`, agent), 'loopback-success');
    assert.equal(ftp.commands.filter((verb) => verb === 'MDTM').length, 2);
    assert.equal(ftp.commands.filter((verb) => verb === 'MLSD').length, 2);
    assert.equal(ftp.commands.filter((verb) => verb === 'RETR').length, 2);
  } finally { agent?.destroy(); await ftp.close(); await close(target); }
});
