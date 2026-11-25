/**
 * R03 测试：学习接口授权（N-01）与台账回滚修正（N-04）。
 * 单元层：临时 DATA_DIR 直接调 skills/review/memory 模块验证归属过滤与回滚授权；
 * HTTP 层：子进程启动服务（ADMIN_TOKEN 配置），验证 403/200 边界与 anonymous 目录不再出现。
 * 离线运行，不依赖 MySQL/Redis/真实模型。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SECRET = ['learn', 'authz', 'test'].join('-');
const ADMIN = 'admin' + '-tok-learn';

/* ---------------- 单元层 ---------------- */
const unitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-authz-unit-'));
process.env.DATA_DIR = unitDir;
process.env.STORE_FILE = path.join(unitDir, 'store.json');
process.env.KB_FILE = path.join(unitDir, 'kb.json');
process.env.VECTOR_FILE = path.join(unitDir, 'vectors.json');
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.QDRANT_URL = '';
process.env.AUTH_SECRET = SECRET;
process.env.LEARNING_ENABLED = 'true';

const { applyOps } = await import('../src/server/memory.mjs');
const { ledgerAppend, ledgerTail, restoreFromLedger, pushPending, readPending } =
  await import('../src/server/skills.mjs');
const { learnStatus, restorePendingItem: reviewRestore } = await import('../src/server/review.mjs');

const memFile = (uid) => path.join(unitDir, 'memory', uid, 'memory.md');

test('单元：非管理员台账只见自己的记忆条目', async () => {
  const r = await applyOps('alice', 'memory', [{ action: 'add', content: 'alice 的独占事实' }], { actor: 'user', channel: 'user' });
  assert.ok(r.ok);
  await ledgerAppend({ actor: 'review', action: 'patch', kind: 'skill', name: 'some-skill', userId: 'bob', before: 'a', after: 'b' });

  const asBob = await ledgerTail(50, { userId: 'bob' });
  assert.ok(asBob.every((o) => o.kind === 'memory' && o.userId === 'bob'), 'bob 不应看到 alice 的记忆或任何技能条目');
  const asAlice = await ledgerTail(50, { userId: 'alice' });
  assert.ok(asAlice.some((o) => o.kind === 'memory' && o.userId === 'alice'));
  assert.ok(!asAlice.some((o) => o.kind === 'skill'), '技能条目对非管理员不可见');
  const asAdmin = await ledgerTail(50, { userId: 'root', admin: true });
  assert.ok(asAdmin.some((o) => o.kind === 'skill'), '管理员可见全部');
});

test('单元：回滚他人记忆 → forbidden；属主可回滚；技能条目仅管理员', async () => {
  const tail = await ledgerTail(50, { userId: 'alice', admin: true });
  const memEntry = tail.find((o) => o.kind === 'memory' && o.userId === 'alice');
  const skillEntry = tail.find((o) => o.kind === 'skill');

  const byBob = await restoreFromLedger(memEntry.id, { userId: 'bob' });
  assert.equal(byBob.ok, false);
  assert.equal(byBob.code, 'forbidden');

  const byAlice = await restoreFromLedger(memEntry.id, { userId: 'alice' });
  assert.ok(byAlice.ok, byAlice.message);
  assert.equal(fs.readFileSync(memFile('alice'), 'utf8'), '', '回滚后 alice 记忆应还原为空');

  const skillByAlice = await restoreFromLedger(skillEntry.id, { userId: 'alice' });
  assert.equal(skillByAlice.code, 'forbidden', '技能台账回滚仅限管理员');
});

test('单元 N-04：restore 条目带归属，二次回滚不落 anonymous', async () => {
  const tail = await ledgerTail(50, { userId: 'alice', admin: true });
  const restoreEntry = tail.find((o) => o.action === 'restore' && o.kind === 'memory');
  assert.ok(restoreEntry, '应存在 restore 台账');
  assert.equal(restoreEntry.userId, 'alice', 'restore 台账必须带原归属（N-04）');

  const again = await restoreFromLedger(restoreEntry.id, { userId: 'alice' });
  assert.ok(again.ok, again.message);
  assert.ok(fs.readFileSync(memFile('alice'), 'utf8').includes('alice 的独占事实'), '二次回滚应还原内容');
  assert.ok(!fs.existsSync(path.join(unitDir, 'memory', 'anonymous')), 'anonymous 目录不得出现（N-04）');
});

test('单元：includes 子串误匹配已消除（id 前缀不命中）', async () => {
  const tail = await ledgerTail(5, { userId: 'alice', admin: true });
  const realId = tail[0].id;
  const r = await restoreFromLedger(realId.slice(0, 6), { userId: 'alice', admin: true });
  assert.equal(r.ok, false, 'id 前缀不应命中（精确匹配）');
});

test('单元：pending 恢复——记忆仅属主，技能仅管理员', async () => {
  await pushPending({ kind: 'memory', userId: 'alice', target: 'memory', statement: 'alice 待确认事实', reason: 'needs_user_confirm' });
  await pushPending({ kind: 'skill_create', userId: 'alice', proposed: { name: 'authz-test-skill', description: '授权测试技能', body: '# 正文' }, reason: 'needs_admin_approval' });
  const list = await readPending();
  const fp1 = list.find((x) => x.statement === 'alice 待确认事实')?.fp;
  const fp2 = list.find((x) => x.proposed?.name === 'authz-test-skill')?.fp;
  assert.ok(fp1 && fp2, 'pending 应包含两条');

  const memByBob = await reviewRestore(fp1, { userId: 'bob' });
  assert.equal(memByBob.code, 'forbidden');
  const memByAlice = await reviewRestore(fp1, { userId: 'alice' });
  assert.ok(memByAlice.ok, memByAlice.message);
  assert.ok(fs.readFileSync(memFile('alice'), 'utf8').includes('alice 待确认事实'));

  const skillByAlice = await reviewRestore(fp2, { userId: 'alice' });
  assert.equal(skillByAlice.code, 'forbidden', '技能类 pending 仅管理员');
  const skillByAdmin = await reviewRestore(fp2, { userId: 'root', admin: true });
  assert.ok(skillByAdmin.ok, skillByAdmin.message);
  // R04（方案 B）：管理员批准后写入提出者（alice）的私有目录
  assert.ok(fs.existsSync(path.join(unitDir, 'skills', 'alice', 'authz-test-skill', 'SKILL.md')));
});

test('单元：learnStatus 按调用者过滤 pending/queued，并回报 admin 标志', async () => {
  await pushPending({ kind: 'memory', userId: 'carol', target: 'memory', statement: 'carol 的待确认', reason: 'needs_user_confirm' });
  const asBob = await learnStatus({ userId: 'bob' });
  assert.equal(asBob.admin, false);
  assert.ok(asBob.pending.head.every((x) => x.userId === 'bob'), 'bob 看不到 carol 的 pending');
  assert.deepEqual(asBob.queued, []);
  const asAdmin = await learnStatus({ userId: 'root', admin: true });
  assert.equal(asAdmin.admin, true);
  assert.ok(asAdmin.pending.count >= 1);
});

/* ---------------- HTTP 层 ---------------- */
function cookieFor(id) {
  const exp = Math.floor(Date.now() / 1000) + 365 * 86400;
  const sig = crypto.createHmac('sha256', SECRET).update(`${id}.${exp}`).digest('base64url').slice(0, 22);
  return `uid=${id}.${exp}.${sig}`;
}

const children = [];
let BASE;
let httpDir;

test('HTTP：启动带 ADMIN_TOKEN 的服务并准备两个用户的数据', async () => {
  httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-authz-http-'));
  fs.writeFileSync(path.join(httpDir, 'papers.jsonl'), '');
  const env = {
    ...process.env,
    PORT: '3983',
    HOST: '127.0.0.1',
    DATA_DIR: httpDir,
    STORE_FILE: path.join(httpDir, 'store.json'),
    KB_FILE: path.join(httpDir, 'kb.json'),
    VECTOR_FILE: path.join(httpDir, 'vectors.json'),
    CORPUS_JSONL: path.join(httpDir, 'papers.jsonl'),
    ADMIN_TOKEN: ADMIN,
    LEARNING_ENABLED: 'true',
  };
  delete env.MCP_TOKENS;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  children.push(child);
  child.stdout.resume();
  child.stderr.resume();
  BASE = 'http://127.0.0.1:3983';
  const t0 = Date.now();
  for (;;) {
    try {
      const j = await (await fetch(`${BASE}/api/health`)).json();
      if (j.ready) break;
    } catch {}
    if (Date.now() - t0 > 25000) throw new Error('server not ready');
    await new Promise((r) => setTimeout(r, 200));
  }
  const r = await fetch(`${BASE}/api/memory`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieFor('alice') },
    body: JSON.stringify({ target: 'memory', operations: [{ action: 'add', content: 'alice 的 HTTP 层事实' }] }),
  });
  assert.equal(r.status, 200);
});

const jpost = (p, body, headers = {}) =>
  fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const jget = (p, headers = {}) => fetch(`${BASE}${p}`, { headers });

test('HTTP：技能 pin/归档仅管理员（N-01）', async () => {
  const { skills } = await (await jget('/api/skills', { cookie: cookieFor('bob') })).json();
  assert.ok(skills.length > 0, '种子技能应已播种');
  const name = skills[0].name;
  const byBob = await jpost(`/api/skills/${name}`, { action: 'archive' }, { cookie: cookieFor('bob') });
  assert.equal(byBob.status, 403);
  assert.equal((await byBob.json()).error, 'admin_required');
  const byAdmin = await jpost(`/api/skills/${name}`, { action: 'archive' }, { cookie: cookieFor('bob'), 'x-admin-token': ADMIN });
  assert.equal(byAdmin.status, 200);
});

test('HTTP：learn/status 台账按调用者过滤，admin 标志正确', async () => {
  const asAlice = await (await jget('/api/learn/status', { cookie: cookieFor('alice') })).json();
  assert.equal(asAlice.admin, false);
  assert.ok(asAlice.ledger.some((o) => o.userId === 'alice' && o.kind === 'memory'), 'alice 看得到自己的记忆台账');
  const asBob = await (await jget('/api/learn/status', { cookie: cookieFor('bob') })).json();
  assert.ok(!asBob.ledger.some((o) => o.userId === 'alice'), 'bob 看不到 alice 的台账（N-01）');
  const asAdmin = await (await jget('/api/learn/status', { cookie: cookieFor('bob'), 'x-admin-token': ADMIN })).json();
  assert.equal(asAdmin.admin, true);
  assert.ok(asAdmin.ledger.some((o) => o.userId === 'alice'));
});

test('HTTP：bob 回滚 alice 的台账 → 403；属主/管理员 → 200 且不产生 anonymous（N-04）', async () => {
  const asAdmin = await (await jget('/api/learn/status', { cookie: cookieFor('bob'), 'x-admin-token': ADMIN })).json();
  const entry = asAdmin.ledger.find((o) => o.kind === 'memory' && o.userId === 'alice' && o.action === 'memory_batch');
  assert.ok(entry, '应找到 alice 的记忆写入台账');

  const byBob = await jpost('/api/learn/ledger/restore', { id: entry.id }, { cookie: cookieFor('bob') });
  assert.equal(byBob.status, 403);
  assert.equal((await byBob.json()).code, 'forbidden');

  const byAlice = await jpost('/api/learn/ledger/restore', { id: entry.id }, { cookie: cookieFor('alice') });
  assert.equal(byAlice.status, 200, '属主可以回滚自己的条目');

  const st = await (await jget('/api/learn/status', { cookie: cookieFor('alice'), 'x-admin-token': ADMIN })).json();
  const restoreEntry = st.ledger.find((o) => o.action === 'restore' && o.kind === 'memory');
  assert.ok(restoreEntry && restoreEntry.userId === 'alice', 'restore 台账带归属');
  const again = await jpost('/api/learn/ledger/restore', { id: restoreEntry.id }, { cookie: cookieFor('alice') });
  assert.equal(again.status, 200, '二次回滚（回滚 restore 条目）应成功');
  assert.ok(!fs.existsSync(path.join(httpDir, 'memory', 'anonymous')), 'anonymous 目录不得出现（N-04 复现失败）');
  const mem = await fsp.readFile(path.join(httpDir, 'memory', 'alice', 'memory.md'), 'utf8');
  assert.ok(mem.includes('alice 的 HTTP 层事实'), '二次回滚后 alice 记忆内容还原');
});

after(() => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch {}
  }
  for (const d of [unitDir, httpDir]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});
