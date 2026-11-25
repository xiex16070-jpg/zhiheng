import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { acquireRuntimeLock, inspectRuntime } from '../src/server/runtime-lock.mjs';
import { probeRuntime, runtimeUrl, browserUrl } from '../scripts/runtime-client.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('browser navigation preserves the localhost origin while health probes use the verified address', () => {
  for (const host of ['0.0.0.0', '127.0.0.1', '::', '::1', 'localhost']) {
    assert.equal(browserUrl({ host, port: 3000 }), 'http://localhost:3000');
  }
  assert.equal(runtimeUrl({ host: '::1', port: 3000 }), 'http://[::1]:3000');
  assert.equal(runtimeUrl({ host: '0.0.0.0', port: 3000 }), 'http://127.0.0.1:3000');
  assert.equal(browserUrl({ host: '192.0.2.5', port: 3010 }), 'http://192.0.2.5:3010');
});

async function until(check, message, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(40);
  }
  throw new Error(message);
}

function childProcess(args, env) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output = (output + bytes).slice(-16000); });
  // Attach the exit listener immediately: a failed CLI may exit before the caller awaits it.
  const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal, output }));
  return { child, exited, output: () => output };
}

async function killChild(proc) {
  if (proc.child.exitCode === null && !proc.child.signalCode) proc.child.kill();
  await proc.exited;
}

async function command(script, env, timeoutMs = 25000) {
  const proc = childProcess(Array.isArray(script) ? script : [script], env);
  let timer;
  try {
    return await Promise.race([
      proc.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('CLI timed out: ' + script + '\n' + proc.output())), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    await killChild(proc);
  }
}

async function sandbox(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-runtime-launcher-'));
  await fs.writeFile(path.join(directory, 'papers.jsonl'), JSON.stringify({ id: 1, title: 'Runtime fixture', abstract: 'Explicit rules establish a reproducible result.', discipline: '计算机' }) + '\n');
  const env = {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: directory, KB_NO_OPEN: '1',
    STORE_FILE: path.join(directory, 'store.json'), KB_FILE: path.join(directory, 'kb.json'),
    VECTOR_FILE: path.join(directory, 'vectors.json'), CORPUS_JSONL: path.join(directory, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', EMBEDDING_PROVIDER: 'off', EMBEDDING_BASE_URL: '',
    QDRANT_URL: '', RAGFLOW_BASE_URL: '', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false',
    LEARNING_ENABLED: 'false', TRAJECTORY_CAPTURE: 'false', LANGFUSE_ENABLED: 'false', INFERENCE_AUDIT: 'false',
    AUX_LLM_MAX_CALLS: '0', SUGGEST_MODE: 'rules', WEB_SEARCH_PROVIDER: '', WEB_SEARCH_KEY: '', SCHOLAR_SEARCH: 'false',
    OPENALEX_API_KEY: '', AUTH_SECRET: 'runtime-launcher-isolated-test', HTTP_PROXY: '', HTTPS_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost,::1',
  };
  t.after(async () => {
    // This owner must belong to this freshly created temporary DATA_DIR. Never inspect or stop the user's DATA_DIR.
    const runtime = await inspectRuntime(directory);
    if (runtime.info && runtime.info.pid !== process.pid) {
      try { process.kill(runtime.info.pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await until(async () => !(await inspectRuntime(directory)).running, 'Isolated server did not release its lock');
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('zh-runtime-launcher-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, env };
}

async function readyRuntime(directory) {
  return until(async () => {
    const runtime = await inspectRuntime(directory);
    if (!runtime.info?.ready || !runtime.info.port) return null;
    try {
      const res = await fetch('http://127.0.0.1:' + runtime.info.port + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && res.headers.get('x-kb-boot') === runtime.info.bootId && (await res.json()).ready === true) return runtime.info;
    } catch {}
    return null;
  }, 'Isolated server never became ready');
}

async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

test('desktop uses a one-use reply, stops only the verified boot and removes its control files', async t => {
  const { directory, env } = await sandbox(t);
  const nonce = randomUUID().replaceAll('-', '');
  const reply = path.join(os.tmpdir(), 'zhiheng-reply-' + nonce + '.json');
  t.after(() => fs.rm(reply, { force: true }));
  const desktop = { ...env, ZHIHENG_DESKTOP: '1' };
  const launch = await command(['scripts/launch.mjs', '--json'], { ...desktop, ZHIHENG_DESKTOP_REPLY: nonce });
  assert.equal(launch.code, 0, launch.output);
  const result = JSON.parse(await fs.readFile(reply, 'utf8'));
  const owner = await readyRuntime(directory);
  assert.equal(owner.desktop, true);
  assert.deepEqual(result, { ok: true, result: { pid: owner.pid, bootId: owner.bootId, url: runtimeUrl(owner) } });
  const skipped = await command(['scripts/stop.mjs', '--boot-id', randomUUID()], desktop);
  assert.equal(skipped.code, 0, skipped.output);
  assert.equal((await inspectRuntime(directory)).info.bootId, owner.bootId);
  const stop = await command(['scripts/stop.mjs', '--boot-id', owner.bootId], desktop);
  assert.equal(stop.code, 0, stop.output);
  assert.equal((await inspectRuntime(directory)).running, false);
  assert.equal(await readOptional(path.join(directory, '.server-pid')), null);
  assert.equal(await readOptional(path.join(directory, '.server-port')), null);
  assert.equal(await readOptional(path.join(directory, '.desktop-stop-' + owner.bootId)), null);
});

test('health probes require HTTP 200, the owning boot identity and actual readiness', async t => {
  const bootId = 'probe-owner-identity';
  let response;
  const fake = http.createServer((req, res) => {
    if (response.hang) return;
    res.writeHead(response.status ?? 200, { 'content-type': 'application/json', ...(response.bootId ? { 'x-kb-boot': response.bootId } : {}) });
    res.end(typeof response.body === 'string' ? response.body : JSON.stringify(response.body));
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(async () => { fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve)); });
  const info = { port: fake.address().port, host: '127.0.0.1', bootId };
  const cases = [
    { name: 'verified ready owner', bootId, body: { ok: true, ready: true }, expected: true },
    { name: 'boot identity differs', bootId: 'another-process', body: { ok: true, ready: true }, expected: false },
    { name: 'boot header missing', body: { ok: true, ready: true }, expected: false },
    { name: 'initializing', bootId, body: { ok: true, ready: false }, expected: false },
    { name: 'readiness missing', bootId, body: { ok: true }, expected: false },
    { name: 'HTTP error', bootId, status: 503, body: { ok: true, ready: true }, expected: false },
    { name: 'failed status', bootId, body: { ok: false, ready: true }, expected: false },
    { name: 'malformed health response', bootId, body: '{', expected: false },
    { name: 'oversized response', bootId, body: { ok: true, ready: true, excess: 'x'.repeat(70000) }, expected: false },
    { name: 'unresponsive owner', hang: true, expected: false },
  ];
  for (const row of cases) {
    response = row;
    assert.equal(await probeRuntime(info, { timeoutMs: 100 }), row.expected, row.name);
  }
});

test('runtime discovery distinguishes absent, legacy and identified owners without trusting PID files', async t => {
  const { directory } = await sandbox(t);
  assert.deepEqual(await inspectRuntime(directory), { running: false, info: null });
  let release = await acquireRuntimeLock(directory);
  t.after(() => release());
  assert.deepEqual(await inspectRuntime(directory), { running: true, info: null });
  await release();
  release = await acquireRuntimeLock(directory, { describe: () => ({ bootId: 'fixture-boot-id', port: 12345, host: '127.0.0.1', ready: false, failed: false, pid: 1, protocol: 'spoof' }) });
  const info = (await inspectRuntime(path.join(directory, '.'))).info;
  assert.equal(info.pid, process.pid, 'The lock holder, not describe(), supplies the owning PID');
  assert.equal(info.protocol, 'zhiheng-runtime/v1');
  assert.equal(info.bootId, 'fixture-boot-id');
  assert.equal(info.ready, false);
  await release();
});

test('launch reuses the actual custom-DATA_DIR server after both metadata files disappear; stop ignores a poisoned PID', async t => {
  const { directory, env } = await sandbox(t);
  const server = childProcess(['server.mjs'], env);
  t.after(() => killChild(server));
  const original = await readyRuntime(directory);
  assert.equal(original.pid, server.child.pid);
  assert.ok(original.port > 0, 'PORT=0 chooses a real ephemeral port');
  await Promise.all(['.server-pid', '.server-port'].map(name => fs.rm(path.join(directory, name), { force: true })));
  const logBefore = await readOptional(path.join(directory, 'server.log'));
  const reused = await command('scripts/launch.mjs', env);
  assert.equal(reused.code, 0, reused.output);
  assert.equal((await readyRuntime(directory)).pid, original.pid);
  assert.equal(await readOptional(path.join(directory, 'server.log')), logBefore, 'Reuse must not spawn another server or append a launch attempt');
  assert.match(reused.output, new RegExp(':' + original.port + '(?:\\D|$)'));

  const unrelated = childProcess(['-e', 'setInterval(() => {}, 1000)'], env);
  t.after(() => killChild(unrelated));
  await fs.writeFile(path.join(directory, '.server-pid'), String(unrelated.child.pid));
  const stopped = await command('scripts/stop.mjs', env);
  assert.equal(stopped.code, 0, stopped.output);
  await until(() => server.child.exitCode !== null || !!server.child.signalCode, 'stop did not terminate the verified owner', 5000);
  await server.exited;
  assert.equal(unrelated.child.exitCode, null, 'A stale or tampered PID file must never choose the process to terminate');
  assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0));
  assert.equal((await inspectRuntime(directory)).running, false);
});

test('stop with no runtime owner does not signal a stale or negative PID', async t => {
  const { directory, env } = await sandbox(t);
  const unrelated = childProcess(['-e', 'setInterval(() => {}, 1000)'], env);
  t.after(() => killChild(unrelated));
  // Never use -1 here: a regression on POSIX could signal every permitted process.
  for (const value of [String(unrelated.child.pid), '-2147483647']) {
    await fs.writeFile(path.join(directory, '.server-pid'), value);
    const stopped = await command('scripts/stop.mjs', env);
    assert.equal(stopped.code, 0, stopped.output);
    assert.equal(unrelated.child.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0));
    assert.equal((await inspectRuntime(directory)).running, false);
  }
});

test('legacy lock owners fail safely instead of starting competitors or trusting a PID file', async t => {
  const { directory, env } = await sandbox(t);
  const release = await acquireRuntimeLock(directory);
  t.after(() => release());
  const unrelated = childProcess(['-e', 'setInterval(() => {}, 1000)'], env);
  t.after(() => killChild(unrelated));
  await fs.writeFile(path.join(directory, '.server-pid'), String(unrelated.child.pid));
  for (const script of ['scripts/launch.mjs', 'scripts/stop.mjs']) {
    const result = await command(script, env);
    assert.notEqual(result.code, 0, 'Legacy owners cannot be identified safely: ' + result.output);
    assert.equal(unrelated.child.exitCode, null);
    assert.doesNotThrow(() => process.kill(unrelated.child.pid, 0));
  }
  assert.equal(await readOptional(path.join(directory, 'server.log')), null, 'A live legacy owner must prevent a second launch');
  assert.equal((await inspectRuntime(directory)).running, true);
  await release();
});

test('concurrent launchers converge on one ready server and another DATA_DIR stays independent', async t => {
  const first = await sandbox(t);
  const launches = await Promise.all([command('scripts/launch.mjs', first.env), command('scripts/launch.mjs', first.env)]);
  for (const result of launches) assert.equal(result.code, 0, result.output);
  const owner = await readyRuntime(first.directory);
  for (const result of launches) assert.match(result.output, new RegExp(':' + owner.port + '(?:\\D|$)'));
  const log = await fs.readFile(path.join(first.directory, 'server.log'), 'utf8');
  assert.equal((log.match(/\[boot\] 初始化完成/g) || []).length, 1, log);
  const second = await sandbox(t);
  const otherLaunch = await command('scripts/launch.mjs', second.env);
  assert.equal(otherLaunch.code, 0, otherLaunch.output);
  const other = await readyRuntime(second.directory);
  assert.notEqual(other.pid, owner.pid);
  assert.notEqual(other.port, owner.port);
});

test('an unrelated HTTP ok service in stale runtime files is not reused', async t => {
  const { directory, env } = await sandbox(t);
  let requests = 0;
  const fake = http.createServer((req, res) => { requests++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, ready: true })); });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(async () => { fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve)); });
  const fakePort = fake.address().port;
  await fs.writeFile(path.join(directory, '.server-port'), String(fakePort));
  await fs.writeFile(path.join(directory, '.server-pid'), String(process.pid));
  const launched = await command('scripts/launch.mjs', env);
  assert.equal(launched.code, 0, launched.output);
  const owner = await readyRuntime(directory);
  assert.notEqual(owner.pid, process.pid);
  assert.notEqual(owner.port, fakePort);
  assert.equal(requests, 0, 'Unbound metadata must not direct probes to an arbitrary server');
});

test('an occupied requested port advances to a free port and subsequent launches reuse that actual port', async t => {
  const { directory, env } = await sandbox(t);
  const occupied = http.createServer((req, res) => { res.writeHead(200); res.end('unrelated application'); });
  let wantedPort;
  // Leave room for the bounded fallback range, even on hosts whose ephemeral range reaches 65535.
  do {
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve));
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    wantedPort = occupied.address().port;
  } while (wantedPort > 65525);
  t.after(async () => { occupied.closeAllConnections(); await new Promise(resolve => occupied.close(resolve)); });
  const launchEnv = { ...env, PORT: String(wantedPort) };
  const launched = await command('scripts/launch.mjs', launchEnv);
  assert.equal(launched.code, 0, launched.output);
  const original = await readyRuntime(directory);
  assert.ok(original.port > wantedPort && original.port <= wantedPort + 9, 'The initial port plus nine fallbacks are allowed');
  assert.match(launched.output, new RegExp(':' + original.port + '(?:\\D|$)'));
  const log = await fs.readFile(path.join(directory, 'server.log'), 'utf8');
  const reused = await command('scripts/launch.mjs', launchEnv);
  assert.equal(reused.code, 0, reused.output);
  assert.equal((await readyRuntime(directory)).pid, original.pid);
  assert.equal(await fs.readFile(path.join(directory, 'server.log'), 'utf8'), log, 'The configured port is only a preference when the DATA_DIR owner already has a verified address');
  assert.match(reused.output, new RegExp(':' + original.port + '(?:\\D|$)'));
});

test('HOST=localhost advertises the actual bound address for health, reuse and stop', async t => {
  const { directory, env } = await sandbox(t);
  const launchEnv = { ...env, HOST: 'localhost' };
  const launched = await command('scripts/launch.mjs', launchEnv);
  assert.equal(launched.code, 0, launched.output);
  const owner = await until(async () => {
    const current = await inspectRuntime(directory);
    return current.info?.ready && await probeRuntime(current.info) ? current.info : null;
  }, 'localhost server did not advertise a reachable address');
  assert.ok(['127.0.0.1', '::1'].includes(owner.host), 'IPC must report the actual IPv4 or IPv6 listener, not assume localhost resolves to IPv4');
  const base = runtimeUrl(owner);
  const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(1500) });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('x-kb-boot'), owner.bootId);
  assert.equal((await health.json()).ready, true);
  assert.ok(launched.output.includes(browserUrl(owner)), launched.output);
  const reused = await command('scripts/launch.mjs', launchEnv);
  assert.equal(reused.code, 0, reused.output);
  assert.equal((await inspectRuntime(directory)).info.pid, owner.pid);
  assert.ok(reused.output.includes(browserUrl(owner)), reused.output);
  const stopped = await command('scripts/stop.mjs', launchEnv);
  assert.equal(stopped.code, 0, stopped.output);
  assert.equal((await inspectRuntime(directory)).running, false);
});

test('an identified booting owner is awaited without spawning a competing server', async t => {
  const { directory, env } = await sandbox(t);
  let ready = false;
  const bootId = 'fixture-boot-wait';
  const fake = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'x-kb-boot': bootId }); res.end(JSON.stringify({ ok: true, ready })); });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const release = await acquireRuntimeLock(directory, { describe: () => ({ bootId, port: fake.address().port, host: '127.0.0.1', ready, failed: false }) });
  t.after(async () => { await release(); fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve)); });
  const started = Date.now();
  const pending = command('scripts/launch.mjs', env);
  await delay(500);
  ready = true;
  const launched = await pending;
  assert.equal(launched.code, 0, launched.output);
  assert.ok(Date.now() - started >= 500, 'ok:true alone must not open a booting application');
  assert.equal(await readOptional(path.join(directory, 'server.log')), null);
  await release();
});

test('a connected but temporarily stalled IPC owner is retried rather than treated as legacy or killed', async t => {
  const { directory, env } = await sandbox(t);
  const runtimeModule = new URL('../src/server/runtime-lock.mjs', import.meta.url).href;
  const code = `
    import http from 'node:http';
    import { acquireRuntimeLock } from ${JSON.stringify(runtimeModule)};
    const bootId = 'delayed-fixture-boot';
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-kb-boot': bootId });
      res.end(JSON.stringify({ ok: true, ready: true }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let firstConnection = true;
    await acquireRuntimeLock(process.env.DATA_DIR, { describe: () => {
      if (firstConnection) {
        firstConnection = false;
        // Stall only after the socket was accepted. This spans two 1.5s probes
        // without a CPU spin or delaying the parent test's event loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3500);
      }
      return { bootId, port: server.address().port, host: '127.0.0.1', ready: true, failed: false };
    }});
    console.log('fixture-ready');
  `;
  const fixture = childProcess(['--input-type=module', '-e', code], env);
  t.after(() => killChild(fixture));
  await until(() => fixture.output().includes('fixture-ready'), 'Delayed owner fixture did not start');
  const launched = await command('scripts/launch.mjs', env);
  assert.equal(launched.code, 0, launched.output);
  assert.equal(fixture.child.exitCode, null, 'Slow IPC must not cause the owner to be killed');
  assert.equal((await readyRuntime(directory)).pid, fixture.child.pid);
  assert.equal(await readOptional(path.join(directory, 'server.log')), null, 'A connected owner must prevent a second server launch');
});
