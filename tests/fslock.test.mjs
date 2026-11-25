/**
 * R08 测试：并发互斥（N-11）与损坏隔离（A-12 残留）。
 * 离线运行；DATA_DIR 指向临时目录。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-fslock-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['fslock', 'test', 'key'].join('-');

const { applyOps, readEntries } = await import('../src/server/memory.mjs');
const { withFileLock, readJsonOrQuarantine } = await import('../src/server/fsutil.mjs');
const { pushPending, readPending, createSkill, listSkills, skillsFor, skillsRoot, learnState, saveLearnState } =
  await import('../src/server/skills.mjs');

test('并发 20 路 applyOps add：全部落盘，一条不丢', async () => {
  const ops = Array.from({ length: 20 }, (_, i) =>
    applyOps('concuser', 'memory', [{ action: 'add', content: `并发条目 ${i} 内容各不相同` }], { actor: 'user', channel: 'user' })
  );
  const results = await Promise.all(ops);
  assert.ok(results.every((r) => r.ok), results.filter((r) => !r.ok).map((r) => r.message).join('; '));
  const entries = await readEntries('concuser', 'memory');
  assert.equal(entries.length, 20, `应恰好 20 条，实际 ${entries.length}`);
  for (let i = 0; i < 20; i++) {
    assert.ok(entries.some((e) => e.includes(`并发条目 ${i} `)), `丢失条目 ${i}`);
  }
});

test('并发 30 路 pushPending：队列不丢条目（上限 50 内）', async () => {
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      pushPending({ kind: 'memory', userId: 'concuser', target: 'memory', statement: `并发候选 ${i} 号`, reason: 'needs_user_confirm' })
    )
  );
  const list = await readPending();
  assert.equal(list.length, 30, `应恰好 30 条，实际 ${list.length}`);
});

test('withFileLock：并发读改写不丢更新（计数 50 次 +1 → 50）', async () => {
  const file = path.join(dir, 'counter.json');
  fs.writeFileSync(file, JSON.stringify({ n: 0 }));
  await Promise.all(
    Array.from({ length: 50 }, () =>
      withFileLock(file, async () => {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        await new Promise((r) => setTimeout(r, Math.random() * 3)); // 放大竞态窗口
        v.n += 1;
        fs.writeFileSync(file, JSON.stringify(v));
      })
    )
  );
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).n, 50);
});

test('损坏的 .usage.json：隔离留证而不是当空表覆盖，listSkills 不抛错', async () => {
  const U = 'corruptuser';
  const r = await createSkill({ name: 'corrupt-scope-skill', description: '损坏侧车测试', body: '# x\n\n- 规则', actor: 'review', userId: U });
  assert.equal(r.ok, true);
  const usageFile = path.join(skillsRoot(), U, '.usage.json');
  fs.writeFileSync(usageFile, '{{{ 这不是 JSON');
  const list = await listSkills({ userId: U });
  assert.ok(list.some((s) => s.name === 'corrupt-scope-skill'), '技能本身仍应可见（侧车缺失只影响遥测）');
  assert.ok(!fs.existsSync(usageFile), '损坏文件应被移走');
  const quarantined = fs.readdirSync(path.join(skillsRoot(), U)).filter((f) => f.startsWith('.usage.json.corrupt-'));
  assert.equal(quarantined.length, 1, '应留下 .corrupt- 隔离件');
  // 隔离后写入恢复正常
  await skillsFor(U, '损坏侧车测试规则');
  const fresh = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  assert.ok(fresh['corrupt-scope-skill'], '新侧车应重建');
});

test('损坏的 pending.json 与 state.json：隔离留证，返回空态', async () => {
  const pendFile = path.join(dir, 'learn', 'pending.json');
  fs.writeFileSync(pendFile, '[broken');
  const list = await readPending();
  assert.deepEqual(list, []);
  assert.ok(fs.readdirSync(path.join(dir, 'learn')).some((f) => f.startsWith('pending.json.corrupt-')));

  const stateFile = path.join(dir, 'learn', 'state.json');
  fs.mkdirSync(path.join(dir, 'learn'), { recursive: true });
  fs.writeFileSync(stateFile, 'oops');
  const st = await learnState();
  assert.deepEqual(st, {});
  assert.ok(fs.readdirSync(path.join(dir, 'learn')).some((f) => f.startsWith('state.json.corrupt-')));
  // 隔离后 saveLearnState 正常
  const saved = await saveLearnState({ x: 1 });
  assert.equal(saved.x, 1);
});

test('readJsonOrQuarantine：ENOENT 返回 fallback 且不产生隔离件', async () => {
  const missing = path.join(dir, 'nope.json');
  const v = await readJsonOrQuarantine(missing, { dflt: true });
  assert.deepEqual(v, { dflt: true });
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('corrupt')));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
