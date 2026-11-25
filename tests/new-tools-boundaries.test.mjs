import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('disabled skills are absent from model tools and cannot read stored bodies', () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { TOOL_SCHEMAS, executeTool } from './src/server/tools.mjs';
    for (const name of ['list_skills', 'skill_view']) {
      assert.ok(!TOOL_SCHEMAS.some(tool => tool.function.name === name));
      const result = await executeTool(name, name === 'skill_view' ? {name:'quote-verification'} : {}, {});
      assert.equal(result.summary, '技能未启用');
    }
  `], { cwd: process.cwd(), env: { ...process.env, LEARNING_ENABLED: 'false' }, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr);
});

test('新增工具遵守私人分区、取消和工作区文件名边界', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-new-tool-boundaries-'));
  Object.assign(process.env, { DATA_DIR: root, MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { executeTool } = await import('../src/server/tools.mjs');
  const { writeFile } = await import('../src/server/workspace.mjs');
  const owner = 'new-tool-owner';
  const ctx = { userId: owner, preferences: {}, evidence: new Map() };
  let requests = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { requests++; throw new Error('must_not_fetch'); };
  try {
    for (const name of ['scholar_search', 'search_history']) {
      const privateCtx = { ...ctx, preferences: { discipline: 'kb:00000000-0000-0000-0000-000000000000' } };
      const r = await executeTool(name, { query: 'private document phrase' }, privateCtx);
      assert.equal(r.summary, '来源超出分区');
      assert.deepEqual(r.evidence, []);
    }
  } finally { global.fetch = realFetch; }
  assert.equal(requests, 0);
  const abort = new AbortController();
  abort.abort(new Error('user_cancelled'));
  await assert.rejects(executeTool('current_time', {}, { ...ctx, signal: abort.signal }), /user_cancelled/);
  for (const file of ['a.md', 'beta.md', 'nested/a.md', 'nested/beta.md']) await writeFile(owner, file, '# file');
  const found = await executeTool('find_files', { pattern: '**/a.md' }, ctx);
  assert.match(found.text, /nested\/a\.md/);
  assert.match(found.text, /- a\.md/);
  assert.doesNotMatch(found.text, /beta\.md/);
  const other = await executeTool('find_files', { pattern: '**/a.md' }, { ...ctx, userId: 'another-owner' });
  assert.equal(other.summary, '无匹配文件');
  const read = await executeTool('read_document', { path: 'a.md', max_chars: 1000 }, ctx);
  assert.match(read.text, /# file/);
  const oversized = await executeTool('read_document', { path: 'a.md', max_chars: 100000000 }, ctx);
  assert.equal(oversized.summary, '工具参数无效');

  const { createSkill } = await import('../src/server/skills.mjs');
  for (const record of [
    { name: 'shared-procedure', body: 'GLOBAL_PUBLIC_BODY' },
    { name: 'shared-procedure', userId: owner, body: 'OWNER_OVERRIDE_BODY' },
    { name: 'owner-procedure', userId: owner, body: 'OWNER_PRIVATE_BODY' },
    { name: 'other-procedure', userId: 'another-owner', body: 'OTHER_PRIVATE_BODY' },
  ]) {
    const created = await createSkill({ ...record, description: record.body, actor: record.userId ? 'user' : 'seed' });
    assert.equal(created.ok, true, created.message);
  }
  const privateCtx = { ...ctx, preferences: { discipline: 'kb:00000000-0000-0000-0000-000000000000' } };
  const index = await executeTool('list_skills', {}, privateCtx);
  assert.match(index.text, /GLOBAL_PUBLIC_BODY/);
  assert.doesNotMatch(index.text, /OWNER_OVERRIDE_BODY|OWNER_PRIVATE_BODY|OTHER_PRIVATE_BODY/);
  const shared = await executeTool('skill_view', { name: 'shared-procedure' }, privateCtx);
  assert.match(shared.text, /GLOBAL_PUBLIC_BODY/);
  assert.doesNotMatch(shared.text, /OWNER_OVERRIDE_BODY/);
  for (const name of ['owner-procedure', 'other-procedure']) {
    const hidden = await executeTool('skill_view', { name }, privateCtx);
    assert.equal(hidden.summary, '技能不存在');
  }
  const ordinary = await executeTool('skill_view', { name: 'shared-procedure' }, ctx);
  assert.match(ordinary.text, /OWNER_OVERRIDE_BODY/);
  const own = await executeTool('skill_view', { name: 'owner-procedure' }, ctx);
  assert.match(own.text, /OWNER_PRIVATE_BODY/);
  const otherSkill = await executeTool('skill_view', { name: 'owner-procedure' }, { ...ctx, userId: 'another-owner' });
  assert.equal(otherSkill.summary, '技能不存在');
});

test('关闭外部文献服务时不向模型声明该工具', () => {
  const source = "import assert from 'node:assert/strict'; import {TOOL_SCHEMAS} from './src/server/tools.mjs'; assert.ok(!TOOL_SCHEMAS.some(t=>t.function.name==='scholar_search'));";
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, SCHOLAR_SEARCH: '0' },
    windowsHide: true, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
});
