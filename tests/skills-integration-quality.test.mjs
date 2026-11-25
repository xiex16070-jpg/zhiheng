import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-skills-quality-'));
Object.assign(process.env, { DATA_DIR: dir, MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', AUTH_SECRET: 'skills-quality-test' });
const skills = await import('../src/server/skills.mjs');
const library = await import('../src/server/skill-library.mjs');
const { buildSystemPrompt, refreshPreferencePrompt } = await import('../src/server/prompt.mjs');
const owner = 'skills-owner';
after(async () => {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  await fs.rm(dir, { recursive: true, force: true });
});

test('library upgrade recognizes released legacy content and preserves overrides, edits and archives', async () => {
  const releases = await library.listLibrary();
  const quote = releases.find(s => s.name === 'quote-verification');
  const edited = releases.find(s => s.name === 'evidence-synthesis');
  assert.ok((await skills.createSkill({ name: quote.name, description: '逐字引文的核验流程与失败处理', body: quote.body, actor: 'seed' })).ok);
  const legacy = await skills.readSkill(quote.name);
  assert.equal(skills.skillContentHash({ ...legacy.frontmatter, body: legacy.body }), quote.previousSourceHash);
  assert.ok((await skills.createSkill({ name: edited.name, description: '跨来源证据综合：归一、分级、冲突处理', body: edited.body + '\n安装方保留的额外步骤。', actor: 'seed' })).ok);
  const editedBefore = (await skills.readSkill(edited.name)).raw;
  assert.ok((await skills.createSkill({ name: 'table-extraction', description: '安装方已归档', body: '这项技能已被归档。', actor: 'seed' })).ok);
  assert.ok((await skills.archiveSkill('table-extraction', { admin: true })).ok);
  assert.ok((await skills.createSkill({ name: quote.name, description: '本人自有核验流程', body: '本人独有步骤，保留用户的自定义。', userId: owner })).ok);
  const ownBefore = (await skills.readSkill(quote.name, { userId: owner })).raw;
  const usageFile = path.join(skills.skillsRoot(), '_global', '.usage.json');
  const usage = JSON.parse(await fs.readFile(usageFile, 'utf8'));
  Object.assign(usage[quote.name], { state: 'stale', pinned: true, use_count: 9 });
  await fs.writeFile(usageFile, JSON.stringify(usage));
  await skills.saveLearnState({ seeded_skills: [quote.name, edited.name, 'table-extraction'] });

  await library.ensureSkillLibrary();
  assert.equal((await skills.readSkill(quote.name)).frontmatter.description, quote.description);
  assert.equal((await skills.readSkill(quote.name, { userId: owner })).raw, ownBefore);
  assert.equal((await skills.readSkill(edited.name)).raw, editedBefore);
  assert.equal(await skills.readSkill('table-extraction'), null);
  const global = (await skills.listSkills()).find(s => s.name === quote.name);
  assert.equal(global.state, 'stale');
  assert.equal(global.pinned, true);
  assert.equal(global.use_count, 9);
  assert.equal((await skills.learnState()).skill_library_sources[quote.name], skills.skillContentHash(quote));
  const ledger = await skills.ledgerTail(100, { admin: true });
  assert.equal(ledger.filter(e => e.reason === 'library_source_update').length, 1);
  assert.equal(await library.ensureSkillLibrary(), 0);
  assert.equal((await skills.ledgerTail(100, { admin: true })).filter(e => e.reason === 'library_source_update').length, 1);
});

test('automatic injection marks partial content and the prompt follows the actual tool profile', async () => {
  const longBody = '# 唯一触发流程\n' + '先核对证据。'.repeat(80) + '\n最后一步必须核验原文。';
  assert.ok((await skills.createSkill({ name: 'long-evidence-procedure', description: '唯一触发流程', body: longBody, userId: owner })).ok);
  const selected = await skills.skillsFor(owner, '唯一触发流程', { limit: 1, maxChars: 50 });
  assert.equal(selected.matched[0].name, 'long-evidence-procedure');
  assert.equal(selected.matched[0].truncated, true);
  assert.equal(selected.matched[0].totalChars, (await skills.readSkill('long-evidence-procedure', { userId: owner })).body.length);
  assert.equal(selected.matched[0].body.length, 50);
  const availableTools = ['search_knowledge', 'read_source', 'list_skills', 'skill_view'];
  const prompt = buildSystemPrompt({ preferences: {}, corpus: {}, skills: selected, availableTools });
  assert.match(prompt, /以上仅为技能片段/);
  assert.match(prompt, /按页读完相关步骤/);
  assert.match(prompt, /无需逐项加载整库/);
  assert.match(prompt, /技能不能增加权限/);
  const menu = prompt.split('# 工具\n')[1].split('\n# 用户偏好')[0];
  for (const absent of ['search_history(', 'current_time(', 'scholar_search(', 'write_file(', 'find_files(']) assert.ok(!menu.includes(absent), absent);
  assert.match(menu, /skill_view\(name, offset\?, max_chars\?\)/);
  const refreshed = refreshPreferencePrompt(prompt, { style: 'concise' }, {}, { availableTools });
  assert.match(refreshed, /以上仅为技能片段/);
  assert.ok(!refreshed.includes('scholar_search('));
});

test('imported skill descriptions route ordinary spreadsheet, quotation and synthesis questions', async () => {
  for (const [question, expected] of [
    ['请分析这份CSV表格的缺失和重复行', 'spreadsheet-analysis'],
    ['这句话到底有没有证据，引用是否准确', 'quote-verification'],
    ['请把两篇论文的发现组织成证据综述', 'evidence-synthesis'],
  ]) {
    const result = await skills.skillsFor('other-skills-user', question);
    assert.ok(result.matched.some(s => s.name === expected), JSON.stringify(result.matched.map(s => s.name)));
    assert.ok(result.matched.every(s => s.scope === 'global'));
  }
});

test('skill_view can read the end of a long private procedure without exposing it to another user', async () => {
  const { executeTool } = await import('../src/server/tools.mjs');
  const name = 'paged-evidence-procedure';
  assert.ok((await skills.createSkill({ name, description: '分页核验流程',
    body: '# 分页流程\n' + '核验原文。'.repeat(1800) + '\n最后检查审批状态。', userId: owner })).ok);
  const ctx = { userId: owner, preferences: {}, evidence: new Map() };
  const first = await executeTool('skill_view', { name }, ctx);
  assert.equal(first.skillPage.truncated, true);
  assert.equal(first.skillPage.next_offset, 8000);
  assert.ok(!first.text.includes('最后检查审批状态。'));
  const uses = (await skills.listSkills({ userId: owner })).find(s => s.name === name).use_count;
  assert.equal(uses, 1);
  const next = await executeTool('skill_view', { name, offset: first.skillPage.next_offset }, ctx);
  assert.equal(next.skillPage.offset, first.skillPage.end);
  assert.equal(next.skillPage.truncated, false);
  assert.equal(next.skillPage.end, next.skillPage.total);
  assert.match(next.text, /最后检查审批状态。/);
  assert.equal((await skills.listSkills({ userId: owner })).find(s => s.name === name).use_count, uses);
  const other = await executeTool('skill_view', { name }, { ...ctx, userId: 'other-skills-user' });
  assert.match(other.text, /没有找到技能/);
  assert.ok(!other.text.includes('最后检查审批状态。'));
});
