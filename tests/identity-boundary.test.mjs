/**
 * R01 身份边界集成测试：真实启动两个服务实例（默认严格模式 / TRUST_PROXY+legacy 模式），
 * 验证 audit N-03、N-16、N-19 的复现路径全部被封死。
 * 离线运行：文件模式、临时数据目录、固定 AUTH_SECRET。
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
const SECRET = 'boundary…ret';
const legacySign = (data) =>
  crypto.createHmac('sha256', SECRET).update(String(data)).digest('base64url').slice(0, 22);

const children = [];
async function startServer(port, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lkba-idb-${port}-`));
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
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: ROOT,
  });
  children.push({ child, dir });
  child.stdout.resume();
  child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      const j = await r.json();
      if (j.ready) return base;
      if (j.error === 'boot_failed') throw new Error('boot_failed');
    } catch (e) {
      if (e.message === 'boot_failed') throw e;
    }
    if (Date.now() - t0 > 25000) throw new Error(`server ${port} not ready`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const get = (base, p, headers = {}) => fetch(`${base}${p}`, { headers, redirect: 'manual' });

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie()[0] : res.headers.get('set-cookie');
  return raw || '';
}

let STRICT;
let PROXY;

test('启动严格模式与 TRUST_PROXY 模式实例', async () => {
  STRICT = await startServer(3987);
  PROXY = await startServer(3986, { TRUST_PROXY: '1', LEGACY_LOOPBACK_IDENTITY: '1' });
  assert.ok(STRICT && PROXY);
});

test('严格模式：无 Cookie 访问业务 API → 401（N-03 证据2）', async () => {
  const r = await get(STRICT, '/api/kb/docs');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'unauthenticated');
});

test('严格模式：回环 + x-user-id 明文头 → 401（默认不再信任本机自报身份）', async () => {
  const r = await get(STRICT, '/api/kb/docs', { 'x-user-id': 'alice' });
  assert.equal(r.status, 401);
});

test('严格模式：明文 Cookie → 401', async () => {
  const r = await get(STRICT, '/api/kb/docs', { cookie: 'uid=plainuser' });
  assert.equal(r.status, 401);
});

test('bootstrap：签发 HttpOnly Cookie，随后可访问业务 API', async () => {
  const b = await get(STRICT, '/api/bootstrap');
  assert.equal(b.status, 200);
  const sc = cookieFrom(b);
  assert.match(sc, /HttpOnly/i, 'Cookie 必须 HttpOnly（N-03）');
  assert.match(sc, /SameSite=Lax/i);
  const uid = decodeURIComponent(sc.match(/uid=([^;]+)/)[1]);
  assert.equal(uid.split('.').length, 3, '新格式 id.exp.sig');
  const body = await b.json();
  assert.ok(body.user.id);

  const r = await get(STRICT, '/api/kb/docs', { cookie: `uid=${encodeURIComponent(uid)}` });
  assert.equal(r.status, 200);
});

test('两个无 Cookie 客户端获得不同身份（不再共享 anon）', async () => {
  const b1 = await (await get(STRICT, '/api/bootstrap')).json();
  const b2 = await (await get(STRICT, '/api/bootstrap')).json();
  assert.notEqual(b1.user.id, b2.user.id);
});

test('bootstrap：旧格式签名 Cookie 透明重签为新格式（同 id）', async () => {
  const legacy = `olduser.${legacySign('olduser')}`;
  const b = await get(STRICT, '/api/bootstrap', { cookie: `uid=${legacy}` });
  assert.equal(b.status, 200);
  const body = await b.json();
  assert.equal(body.user.id, 'olduser');
  const sc = cookieFrom(b);
  assert.match(sc, /HttpOnly/i);
  const uid = decodeURIComponent(sc.match(/uid=([^;]+)/)[1]);
  assert.equal(uid.split('.').length, 3, '应重签为新格式');
  assert.equal(uid.split('.')[0], 'olduser');
});

test('bootstrap：带签名残片的旧明文 Cookie 不会拼出脏身份（N-19，严格模式下直接换新身份）', async () => {
  const b = await get(STRICT, '/api/bootstrap', { cookie: 'uid=u1.rotatedsig' });
  const body = await b.json();
  assert.notEqual(body.user.id, 'u1.rotatedsig');
  assert.notEqual(body.user.id, 'u1'); // 严格模式不继承明文，签发全新身份
  assert.match(body.user.id, /^[A-Za-z0-9_-]{1,32}$/);
});

test('过期签名 Cookie → 业务 API 401，bootstrap 换新身份', async () => {
  const exp = Math.floor(Date.now() / 1000) - 10;
  const expired = `u9.${exp}.${legacySign(`u9.${exp}`)}`;
  const r = await get(STRICT, '/api/kb/docs', { cookie: `uid=${expired}` });
  assert.equal(r.status, 401);
  const b = await get(STRICT, '/api/bootstrap', { cookie: `uid=${expired}` });
  const body = await b.json();
  assert.notEqual(body.user.id, 'u9');
});

test('TRUST_PROXY：回环 + X-Forwarded-For + 明文头（legacy 开）→ 仍 401（N-16）', async () => {
  const r = await get(PROXY, '/api/kb/docs', {
    'x-forwarded-for': '1.2.3.4',
    'x-user-id': 'attacker',
  });
  assert.equal(r.status, 401);
});

test('TRUST_PROXY：真实回环（无 XFF）+ legacy 开 → 明文身份可用（迁移路径）', async () => {
  const b = await get(PROXY, '/api/bootstrap', { cookie: 'uid=migrateuser' });
  assert.equal(b.status, 200);
  const body = await b.json();
  assert.equal(body.user.id, 'migrateuser', 'legacy 模式下继承旧 uid 完成数据迁移');
  assert.match(cookieFrom(b), /HttpOnly/i, '并重签为签名 Cookie');
});

test('静态与白名单路由不受身份闸门影响', async () => {
  assert.equal((await get(STRICT, '/api/health')).status, 200);
  assert.equal((await get(STRICT, '/index.html')).status, 200);
  assert.equal((await get(STRICT, '/mcp')).status, 200);
});

after(() => {
  for (const { child, dir } of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});
