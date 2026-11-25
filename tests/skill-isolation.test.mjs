/**
 * R04（方案 B）测试：技能按用户隔离——A 的学习成果对 B 结构性不可见，
 * _global 种子运行时只读，旧扁平布局启动迁移幂等。（audit N-02 的验收：
 * bob 的文档内容经由技能进入 alice 提示词的路径在新布局下不存在。）
 * 离线运行；DATA_DIR 指向临时目录。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-iso-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['iso', 'test', 'secret'].join('-');

const {
  createSkill,
  patchSkill,
  readSkill,
  listSkills,
  archiveSkill,
  pinSkill,
  skillsFor,
  ensureSeeds,
  migrateSkillsLayout,
  skillsRoot,
} = await import('../src/server/skills.mjs');

const A = 'usera';
const B = 'userb';

test('播种种子（_global）', async () => {
  assert.equal(await ensureSeeds(), 7);
  assert.ok(fs.existsSync(path.join(skillsRoot(), '_global', 'citation-quality', 'SKILL.md')));
});

test('A 的审查产出写入 A 的私有目录', async () => {
  const r = await createSkill({
    name: 'alice-retrieval-trick',
    description: 'A 用户习得的检索技巧',
    body: '# A 的技巧\n\n- 空命中时先换上位词再缩小范围。',
    actor: 'review',
    userId: A,
  });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(skillsRoot(), A, 'alice-retrieval-trick', 'SKILL.md')));
  assert.ok(!fs.existsSync(path.join(skillsRoot(), B, 'alice-retrieval-trick')));
});

test('B 看不到 A 的技能：列表、读取、注入三条路都不可见（N-02 结构性关闭）', async () => {
  const asB = await listSkills({ userId: B });
  assert.ok(!asB.some((s) => s.name === 'alice-retrieval-trick'), 'B 的列表不含 A 的技能');
  assert.ok(asB.some((s) => s.scope === 'global'), 'B 仍能看到全局种子');

  const readAsB = await readSkill('alice-retrieval-trick', { userId: B });
  assert.equal(readAsB, null, 'B 读不到 A 的技能全文');

  const injB = await skillsFor(B, '空命中时怎么换上位词缩小范围');
  assert.ok(!injB.matched.some((m) => m.name === 'alice-retrieval-trick'), 'A 的技能不会注入 B 的提示词');

  const injA = await skillsFor(A, '空命中时怎么换上位词缩小范围');
  assert.ok(injA.matched.some((m) => m.name === 'alice-retrieval-trick'), 'A 自己能注入');
});

test('B 不能改写/归档/pin A 的技能；A 可以管理自己的', async () => {
  const p = await patchSkill({ name: 'alice-retrieval-trick', old_text: '上位词', new_text: '更上位的词', actor: 'review', userId: B });
  assert.equal(p.ok, false, 'B patch A 的技能应失败（不可见即不可改）');
  const arch = await archiveSkill('alice-retrieval-trick', { actor: 'user', userId: B });
  assert.equal(arch.ok, false);
  const pin = await pinSkill('alice-retrieval-trick', true, 'user', { userId: B });
  assert.equal(pin.ok, false);

  const okPatch = await patchSkill({ name: 'alice-retrieval-trick', old_text: '上位词', new_text: '更上位的词', actor: 'review', userId: A });
  assert.equal(okPatch.ok, true);
  const okPin = await pinSkill('alice-retrieval-trick', true, 'user', { userId: A });
  assert.equal(okPin.ok, true);
});

test('_global 种子运行时只读：审查补丁写成用户自己的同名版本；归档/pin 仅管理员', async () => {
  await createSkill({ name: 'seed-cow-check', description: '种子：先核对原文再下结论', body: '# 核对\n\n- 先读原文，再下结论。', actor: 'seed' });
  const p = await patchSkill({ name: 'seed-cow-check', old_text: '先读原文，再下结论。', new_text: '先读原文并核对适用条件，再下结论。', actor: 'review', userId: A });
  assert.equal(p.code, 'overridden');
  assert.match((await readSkill('seed-cow-check', { userId: A })).body, /核对适用条件/);
  assert.doesNotMatch((await readSkill('seed-cow-check', { userId: B })).body, /核对适用条件/, '其他用户仍使用原种子');
  assert.equal((await patchSkill({ name: 'seed-cow-check', old_text: '先读原文', new_text: '先读', actor: 'review' })).code, 'global_readonly', '没有属主的补丁仍拒绝');
  const arch = await archiveSkill('grounded-inference', { actor: 'user', userId: A });
  assert.equal(arch.code, 'forbidden');
  const pin = await pinSkill('grounded-inference', true, 'user', { userId: A });
  assert.equal(pin.code, 'forbidden');
  // 管理员可以策展全局种子
  const okPin = await pinSkill('grounded-inference', true, 'admin', { admin: true });
  assert.equal(okPin.ok, true);
  await pinSkill('grounded-inference', false, 'admin', { admin: true });
});

test('同名技能：用户自有优先于全局种子注入', async () => {
  await createSkill({
    name: 'citation-quality',
    description: 'A 自己的引用纪律扩展版',
    body: '# 引用质量（A 定制）\n\n- 逐字引文必须先校验再输出，这是 A 的强化规则。',
    actor: 'review',
    userId: A,
  });
  const listA = await listSkills({ userId: A });
  const cq = listA.find((s) => s.name === 'citation-quality');
  assert.equal(cq.scope, 'own', '同名时自有覆盖全局');
  const readA = await readSkill('citation-quality', { userId: A });
  assert.match(readA.body, /A 定制/);
  const readB = await readSkill('citation-quality', { userId: B });
  assert.equal(readB.scope, 'global', 'B 仍读到全局种子');
});

test('旧扁平布局迁移：整体进 _global，幂等', async () => {
  // 造一个旧式布局残留：根下直接放技能目录 + 根 .usage.json
  const legacyDir = path.join(skillsRoot(), 'legacy-flat-skill');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'SKILL.md'), '---\nname: legacy-flat-skill\ndescription: 旧布局残留\n---\n\n# 旧\n');
  fs.writeFileSync(path.join(skillsRoot(), '.usage.json'), JSON.stringify({ 'legacy-flat-skill': { use_count: 2 } }));

  const m1 = await migrateSkillsLayout();
  assert.ok(m1.migrated >= 1);
  assert.ok(fs.existsSync(path.join(skillsRoot(), '_global', 'legacy-flat-skill', 'SKILL.md')));
  assert.ok(!fs.existsSync(legacyDir), '根下旧目录应已移走');
  assert.ok(!fs.existsSync(path.join(skillsRoot(), '.usage.json')), '根侧车应已合并移走');
  // 旧遥测并入 _global/.usage.json（冲突键以 _global 现有数据为准）
  const mergedUsage = JSON.parse(fs.readFileSync(path.join(skillsRoot(), '_global', '.usage.json'), 'utf8'));
  assert.equal(mergedUsage['legacy-flat-skill'].use_count, 2);
  // 用户目录不受影响
  assert.ok(fs.existsSync(path.join(skillsRoot(), A, 'alice-retrieval-trick', 'SKILL.md')));

  const m2 = await migrateSkillsLayout();
  assert.equal(m2.migrated, 0, '二次迁移无操作（幂等）');

  const sk = await readSkill('legacy-flat-skill');
  assert.equal(sk.scope, 'global', '迁移后的旧技能对所有人可见（全局只读）');
});

test('管理员可按 scope 查看任意用户目录（排障通道）', async () => {
  const asAdmin = await listSkills({ admin: true, scope: A });
  assert.ok(asAdmin.every((s) => s.scopeId === A));
  assert.ok(asAdmin.some((s) => s.name === 'alice-retrieval-trick'));
  // 普通用户传 scope 无效（回落到自己的可见面）
  const asBHack = await listSkills({ userId: B, scope: A });
  assert.ok(!asBHack.some((s) => s.scopeId === A), '非管理员不得借 scope 窥探他人目录');
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('待处理建议按用户限额：别人的建议挤不掉我的记忆确认', async () => {
  const { pushPending, readPending } = await import('../src/server/skills.mjs');
  await pushPending({ kind: 'memory', target: 'user', userId: B, statement: 'B 偏好表格输出' });
  await pushPending({ kind: 'memory', target: 'user', userId: A, statement: 'A 偏好先给结论' });
  for (let i = 0; i < 60; i++) await pushPending({ kind: 'skill_patch', userId: A, statement: `A 的技能建议 ${i}` });
  const list = await readPending();
  assert.ok(list.some(x => x.userId === B && x.kind === 'memory'), '其他用户的记忆建议保留');
  assert.ok(list.some(x => x.userId === A && x.kind === 'memory'), '自己的记忆建议最后才被挤出');
  assert.ok(list.filter(x => x.userId === A).length <= 50);
});
