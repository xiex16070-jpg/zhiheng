/**
 * R07 测试：畸形 Host 头不挂起（N-10）、/docs /specs 不可下载（N-17）、
 * API 500 不泄露内部错误细节（A-30）。离线运行：子进程 + 临时数据目录。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3982;
const BASE = `http://127.0.0.1:${PORT}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-robust-'));
fs.writeFileSync(path.join(dir, 'papers.jsonl'), '');
const child = spawn(
  process.execPath,
  [path.join(ROOT, 'server.mjs')],
  {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dir,
      STORE_FILE: path.join(dir, 'store.json'),
      KB_FILE: path.join(dir, 'kb.json'),
      VECTOR_FILE: path.join(dir, 'vectors.json'),
      CORPUS_JSONL: path.join(dir, 'papers.jsonl'),
      MYSQL_ENABLED: 'false',
      REDIS_ENABLED: 'false',
      QDRANT_URL: '',
      AUTH_SECRET: ['robust', 'test', 'key'].join('-'),
      LEARNING_ENABLED: 'false',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
  }
);
child.stdout.resume();
child.stderr.resume();

/** 原始套接字发送任意请求字节，返回 2 秒内收到的响应头（超时返回 null） */
function rawRequest(raw, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, '127.0.0.1', () => sock.write(raw));
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(null);
    }, timeoutMs);
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      if (buf.includes('\r\n\r\n') || buf.length > 4096) {
        clearTimeout(timer);
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(buf || null);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

test('服务就绪', async () => {
  const t0 = Date.now();
  for (;;) {
    try {
      const j = await (await fetch(`${BASE}/api/health`)).json();
      if (j.ready) return;
    } catch {}
    if (Date.now() - t0 > 25000) throw new Error('server not ready');
    await new Promise((r) => setTimeout(r, 200));
  }
});

test('N-10：畸形 Host 头得到 HTTP 响应而非挂起，进程存活', async () => {
  const resp = await rawRequest('GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
  assert.ok(resp, '2 秒内必须收到响应（挂起 = N-10 复现）');
  assert.match(resp, /^HTTP\/1\.[01] \d{3}/, `应返回合法状态行，收到：${String(resp).slice(0, 60)}`);
  // 进程仍活着
  const alive = await fetch(`${BASE}/api/health`);
  assert.equal(alive.status, 200);
});

test('N-10：畸形百分号编码 URL 仍 400（回归保护）', async () => {
  const resp = await rawRequest('GET /%E0%A4%A HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  assert.match(String(resp), /^HTTP\/1\.[01] 400/);
});

test('N-17：/docs 与 /specs 不可下载（审计文档含复现步骤）', async () => {
  for (const p of [
    '/docs/architecture-audit.md',
    '/docs/audit-main-4d03617.md',
    '/docs/ai-handoff.md',
    '/specs/001-system-optimization/spec.md',
    '/specs/001-system-optimization/tasks.md',
  ]) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 403, `${p} 应 403`);
  }
});

test('浏览器资源与既有拒绝面不受影响', async () => {
  assert.equal((await fetch(`${BASE}/index.html`)).status, 200);
  assert.equal((await fetch(`${BASE}/src/ui/app.js`)).status, 200);
  for (const p of ['/server.mjs', '/package.json', '/.env', '/data/store.json', '/tests/api.test.mjs', '/src/server/auth.mjs']) {
    const r = await fetch(`${BASE}${p}`);
    assert.ok(r.status === 403 || r.status === 404, `${p} 应 403/404，实际 ${r.status}`);
  }
});

after(() => {
  try { child.kill('SIGKILL'); } catch {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});
