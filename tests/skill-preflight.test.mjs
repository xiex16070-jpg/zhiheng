import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'logic-kb-preflight-'));
process.env.DATA_DIR = temp;
const { preflightSkillPack } = await import('../src/server/skill-preflight.mjs');
after(() => fs.rm(temp, { recursive: true, force: true }));

const skill = (name, description = 'Short description', body = 'Inspect the example.') =>
  ['---', 'name: ' + name, 'description: ' + description, '---', '', body].join('\n');
const codes = diagnostics => diagnostics.map(i => i.code);
const inWorkspace = (user, file) => path.join(temp, 'workspace', user, file);
async function write(user, file, bytes) {
  const target = inWorkspace(user, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

test('standalone preflight inventories attachments and long descriptions without returning their contents or installing', async () => {
  const user = 'reader';
  const description = '长'.repeat(80);
  const raw = ['---', 'name: long-skill', 'description: ' + description, 'allowed-tools: Bash', '---',
    'PRIVATE-BODY [reference](reference/design.md) [missing](assets/missing.png) [guide](GUIDE.md)'].join('\n');
  await write(user, 'long-skill/SKILL.md', raw);
  await write(user, 'long-skill/reference/design.md', 'PRIVATE-ATTACHMENT');
  await write(user, 'long-skill/GUIDE.md', 'PRIVATE-GUIDE');
  await write(user, 'long-skill/scripts/preview.mjs', 'throw new Error("PRIVATE-SCRIPT")');
  await write(user, 'long-skill/agents/worker.yaml', 'PRIVATE-AGENT');
  await write(user, 'long-skill/unrelated/private-name.txt', 'PRIVATE-UNRELATED');
  const before = await fs.readdir(temp);
  const report = await preflightSkillPack(user, 'long-skill');
  assert.equal(report.kind, 'skill');
  assert.ok(codes(report.issues).includes('standalone_skill'));
  const [item] = report.skills;
  assert.equal(item.name, 'long-skill');
  assert.equal(item.descriptionLength, 80);
  assert.equal(item.standardValid, true);
  for (const expected of ['local_description_limit', 'scripts_not_executed', 'tools_not_granted', 'missing_resources',
    'agent_configs_inactive', 'resources_not_imported']) assert.ok(codes(item.issues).includes(expected), expected);
  assert.deepEqual(Object.fromEntries(item.resources.map(r => [r.directory, r.count])), { reference: 1, scripts: 1, agents: 1, '.': 1 });
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE-|private-name|长长长/);
  assert.deepEqual(await fs.readdir(temp), before);
  assert.equal(await fs.readFile(inWorkspace(user, 'long-skill/SKILL.md'), 'utf8'), raw);
});

test('plugin preflight reuses manifest validation, reports each entry and redacts MCP drafts', async () => {
  const user = 'pack';
  const m = { name: 'pack', version: '1.0.0', description: 'Example', skills: ['one/SKILL.md', 'missing/SKILL.md'],
    mcpServers: [{ name: 'SECRET-NAME', kind: 'http', url: 'https://example.invalid/server', token: 'SYNTHETIC-NOT-A-KEY' }] };
  await write(user, 'plugin.json', JSON.stringify(m));
  await write(user, 'SKILL.md', skill('pack'));
  await write(user, 'one/SKILL.md', skill('one'));
  const r = await preflightSkillPack(user, '.');
  assert.equal(r.kind, 'plugin');
  assert.deepEqual(r.skills.map(s => [s.name, s.standardValid]), [['one', true], [null, false]]);
  assert.ok(codes(r.issues).includes('mcp_not_connected'));
  assert.ok(codes(r.skills[1].issues).includes('preflight_not_found'));
  assert.doesNotMatch(JSON.stringify(r), /SECRET-NAME|example\.invalid|SYNTHETIC/);
  assert.equal((await preflightSkillPack(user, 'SKILL.md')).kind, 'skill');
  await write(user, 'plugin.json', JSON.stringify({ ...m, scripts: ['SECRET-UNSUPPORTED'] }));
  await assert.rejects(preflightSkillPack(user, 'plugin.json'), { code: 'invalid_preflight_manifest' });
});

test('only the active user workspace is visible, including on missing and linked paths', async () => {
  const user = 'isolated';
  await write(user, 'safe/SKILL.md', skill('safe', 'Scope check', '[outside](../private/name.md)'));
  await write('neighbor', 'secret/SKILL.md', skill('secret'));
  const resourceDir = inWorkspace(user, 'safe/scripts');
  await fs.mkdir(resourceDir);
  await fs.symlink(inWorkspace('neighbor', 'secret'), path.join(resourceDir, 'neighbor'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(inWorkspace('neighbor', 'secret/SKILL.md'), path.join(resourceDir, 'private.md'));
  const r = await preflightSkillPack(user, 'safe/SKILL.md');
  assert.ok(codes(r.skills[0].issues).includes('resource_path_skipped'));
  assert.equal(r.skills[0].resources[0].count, 0);
  assert.doesNotMatch(JSON.stringify(r), /neighbor|private\.md|name\.md/);
  for (const invalid of ['../neighbor/secret', inWorkspace('neighbor', 'secret'), 'safe/scripts/neighbor', 'safe/scripts/private.md']) {
    await assert.rejects(preflightSkillPack(user, invalid), { code: 'preflight_path_rejected' });
  }
  await assert.rejects(preflightSkillPack(user, 'secret'), { code: 'preflight_not_found' });
  await assert.rejects(preflightSkillPack('_global', 'safe'), { code: 'invalid_user' });
});

test('entry byte limit and bounded directory depth are reported explicitly', async () => {
  await write('limits', 'oversize/SKILL.md', 'a'.repeat(512 * 1024 + 1));
  const big = await preflightSkillPack('limits', 'oversize');
  assert.deepEqual(codes(big.skills[0].issues), ['preflight_unreadable']);
  await write('limits', 'unicode/SKILL.md', skill('unicode', '长篇正文', '字'.repeat(60000)));
  const portable = await preflightSkillPack('limits', 'unicode');
  assert.equal(portable.skills[0].standardValid, true);
  assert.ok(codes(portable.skills[0].issues).includes('local_size_limit'));
  await write('limits', 'deep/SKILL.md', skill('deep'));
  await write('limits', 'deep/assets/one/two/three/four/hidden.svg', 'private');
  const r = await preflightSkillPack('limits', 'deep/SKILL.md');
  assert.ok(codes(r.skills[0].issues).includes('inventory_limit'));
  assert.equal(r.skills[0].resources[0].truncated, true);
  assert.doesNotMatch(JSON.stringify(r), /hidden\.svg/);
});
