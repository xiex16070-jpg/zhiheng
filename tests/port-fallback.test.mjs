/**
 * 端口自愈回归测试。
 *
 * 场景（真实踩过）：本机其他工具占住 127.0.0.1:PORT，Windows 仍允许我们 bind 0.0.0.0:PORT，
 * 监听"成功"但 localhost 请求全被别的程序接走 → 浏览器看到别人的 401 JSON。
 * 期望：服务端回探发现不是自己 → 顺延端口 → data/.server-port 记录真实端口。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_PORT = 3961;

// 霸占 BASE_PORT 的“别的程序”：故意回 **200 {ok:true}**（模拟同项目的旧实例），
// 只有 boot id 比对才能识别它不是本次进程——直接回 401 反而太容易识别。
const squatter = http.createServer((req, res) => {
  const body = JSON.stringify({ ok: true, ready: true, retcode: 1401, wording: 'stale instance' });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
});
await new Promise((r) => squatter.listen(BASE_PORT, '127.0.0.1', r));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-port-'));
fs.writeFileSync(path.join(dir, 'papers.jsonl'), '');

const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(BASE_PORT), HOST: '0.0.0.0', DATA_DIR: dir,
    STORE_FILE: path.join(dir, 'store.json'), KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'),
    CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '',
    AUTH_SECRET: ['port', 'test', 'key'].join('-'),
    LEARNING_ENABLED: 'false',
    HTTP_PROXY: '', HTTPS_PROXY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT,
});
child.stdout.resume();
child.stderr.resume();

after(async () => {
  // The server can still be writing boot files or draining traces after SIGTERM.
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  await new Promise((resolve) => squatter.close(resolve));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function health(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500, headers: { connection: 'close' } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

test('端口被别的程序以 127.0.0.1 独占时，服务自动顺延并在 .server-port 记录真实端口', async () => {
  const portFile = path.join(dir, '.server-port');
  let port = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      port = Number(fs.readFileSync(portFile, 'utf8').trim()) || 0;
    } catch {
      port = 0;
    }
    if (port) break;
  }
  assert.ok(port, '应写出 data/.server-port');
  assert.notEqual(port, BASE_PORT, '不应停留在被抢占的端口');
  assert.ok(port > BASE_PORT && port <= BASE_PORT + 10, `顺延范围合理，实际 ${port}`);

  const h = await health(port);
  assert.ok(h && h.ok === true, '真实端口上的 /api/health 应来自本服务');
  assert.ok(h.ready === true || h.ready === false);

  // 被抢占的端口仍然回别人的 JSON（证明我们确实没占用它）；它同样回 ok:true，
  // 但缺少本进程的 x-kb-boot，自检必须识破。
  const squatted = await health(BASE_PORT);
  assert.equal(squatted?.retcode, 1401);
});
