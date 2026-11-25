/**
 * 技能库与新增工具（read_document / list_skills / skill_view）测试。
 * 离线：临时 DATA_DIR；技能库读仓库内 skill-library/。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-lib-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['lib', 'test', 'key'].join('-');
process.env.LEARNING_ENABLED = 'true';

const lib = await import('../src/server/skill-library.mjs');
const skills = await import('../src/server/skills.mjs');
const { executeTool, TOOL_SCHEMAS } = await import('../src/server/tools.mjs');
const ws = await import('../src/server/workspace.mjs');

const USER = 'ulibtest01';

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('技能库清单：数量、描述预算、目录名与 name 一致', async () => {
  const list = await lib.listLibrary();
  assert.ok(list.length >= 26, `至少 26 个，实际 ${list.length}`);
  for (const name of ['writing-plans','receiving-code-review','meeting-action-items','weekly-review-planning','session-librarian','llm-wiki','chart-design','kpi-design','metric-diagnostics','monitoring-discipline','lsp-via-mcp']) assert.ok(list.some(s => s.name === name), `缺少 ${name}`);
  for (const s of list) {
    assert.ok(s.description.length > 0 && s.description.length <= 60, `${s.name} 描述 ${s.description.length} 字符`);
    assert.match(s.name, /^[a-z0-9][a-z0-9._-]*$/);
    assert.ok(s.body.length > 100, `${s.name} 正文过短`);
    assert.equal(path.basename(path.dirname(s.file)), s.name);
  }
});

test('幂等播种：首次全量进 _global，二次为 0，内容可读', async () => {
  const n = await lib.ensureSkillLibrary();
  const list = await lib.listLibrary();
  assert.equal(n, list.length);
  assert.equal(await lib.ensureSkillLibrary(), 0);

  const sk = await skills.readSkill('citation-export');
  assert.ok(sk, '应能读到技能');
  assert.equal(sk.scope, 'global');
  assert.match(sk.body, /GB\/T 7714/);
});

test('用户归档过的技能不会在重启后复活', async () => {
  const r = await skills.archiveSkill('table-extraction', { actor: 'user', admin: true, reason: 'manual' });
  assert.equal(r.ok, true);
  assert.equal(await lib.ensureSkillLibrary(), 0, '归档后 ensure 不应再播');
  assert.equal(await skills.readSkill('table-extraction'), null);
});

test('版本化文档查询和工作台界面审查各自匹配对应技能', async () => {
  await lib.ensureSkillLibrary();
  for (const [question, name] of [
    ['用 Context7 查询指定版本 API 的迁移说明', 'context7-docs'],
    ['用 Impeccable 审查聊天、执行步骤和引用证据的键盘操作', 'impeccable-ui-review'],
  ]) {
    const { matched } = await skills.skillsFor(USER, question, { limit: 1, recordUse: false });
    assert.equal(matched[0]?.name, name);
    assert.equal(matched[0].scope, 'global');
  }
});

test('工具：schema 含新三件；list_skills 返回名称与作用域', async () => {
  const names = TOOL_SCHEMAS.map((t) => t.function.name);
  for (const n of ['read_document', 'skill_view', 'list_skills']) assert.ok(names.includes(n), `缺少 ${n}`);

  const ctx = { userId: USER, evidence: new Map(), preferences: {} };
  const r = await executeTool('list_skills', {}, ctx);
  assert.match(r.text, /可用技能 \d+ 个/);
  assert.match(r.text, /citation-export/);
  assert.match(r.text, /内置/);
});

test('工具：skill_view 加载全文，未知名称给出可操作提示', async () => {
  const ctx = { userId: USER, evidence: new Map(), preferences: {} };
  const ok = await executeTool('skill_view', { name: 'quote-verification' }, ctx);
  assert.match(ok.text, /verify_quote/);
  assert.match(ok.text, /内置/);

  const missing = await executeTool('skill_view', { name: 'no-such-skill' }, ctx);
  assert.match(missing.text, /没有找到技能/);
  assert.match(missing.text, /list_skills/);
});

test('工具：read_document 抽取工作区 Markdown/CSV，并拒绝越权与缺失文件', async () => {
  const ctx = { userId: USER, evidence: new Map(), preferences: {} };
  await ws.writeFile(USER, 'reports/摘要.md', '# 标题\n\n这是正文第一段。\n\n第二段。');
  const r = await executeTool('read_document', { path: 'reports/摘要.md' }, ctx);
  assert.match(r.text, /这是正文第一段/);
  assert.match(r.summary, /摘要\.md/);

  const csv = await executeTool('read_document', { path: 'reports/摘要.md', max_chars: 1000 }, ctx);
  assert.match(csv.text, /共 \d+ 字/);

  const trav = await executeTool('read_document', { path: '../../store.json' }, ctx);
  assert.match(trav.text, /路径不合法/);

  const missing = await executeTool('read_document', { path: 'nope.txt' }, ctx);
  assert.match(missing.text, /没有文件/);
});

test('工具：find_files 按 glob 匹配（** 跨目录、* 不跨目录）', async () => {
  const ctx = { userId: USER, evidence: new Map(), preferences: {} };
  await ws.writeFile(USER, 'reports/a.md', '# a');
  await ws.writeFile(USER, 'reports/b.csv', 'x,y');
  await ws.writeFile(USER, 'top.md', '# top');

  const deep = await executeTool('find_files', { pattern: '**/*.md' }, ctx);
  assert.match(deep.text, /reports\/a\.md/);
  assert.match(deep.text, /top\.md/);

  const shallow = await executeTool('find_files', { pattern: '*.md' }, ctx);
  assert.match(shallow.text, /top\.md/);
  assert.ok(!shallow.text.includes('reports/a.md'), '* 不应跨目录');

  const none = await executeTool('find_files', { pattern: '**/*.pdf' }, ctx);
  assert.match(none.text, /没有匹配/);
});

test('工具：current_time 返回可用的当前时间', async () => {
  const ctx = { userId: USER, evidence: new Map(), preferences: {} };
  const r = await executeTool('current_time', {}, ctx);
  assert.match(r.text, /当前时间：/);
  assert.match(r.text, /UTC[+-]\d{2}:\d{2}/);
  assert.match(r.text, /\d{4}/);
});

test('工具：read_document 支持二进制文档（DOCX 头识别，坏文件给可操作错误）', async () => {
  const ctx = { userId: USER, evidence: new Map(), preferences: {} };
  // 最小 docx：一个空 zip；解析失败应返回「无法解析」而不是抛异常打死任务
  const buf = Buffer.from('PK\u0003\u0004' + '\u0000'.repeat(64), 'latin1');
  await fs.promises.mkdir(path.join(dir, 'workspace', USER), { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'workspace', USER, 'broken.docx'), buf);
  const r = await executeTool('read_document', { path: 'broken.docx' }, ctx);
  assert.match(r.text, /无法解析|共 0 字/);
});
