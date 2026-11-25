import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapabilityCatalog } from '../src/server/capability-catalog.mjs';
import { resolveConfigurationSection } from '../src/ui/configuration-sections.js';

const schemas = (...names) => names.map(name => ({ function: { name } }));
test('能力导航区分已接入、未配置和关闭，不把配置视为实测成功', () => {
  const result = buildCapabilityCatalog({ schemas: schemas('search_knowledge','create_document','view_image','web_search'), browser: false, learning: false });
  const items = Object.fromEntries(result.items.map(i => [i.id,i]));
  assert.equal(items.evidence.state, 'available');
  assert.equal(items.office.state, 'available');
  assert.equal(items.pdf.state, 'needs_setup');
  assert.equal(items.vision.state, 'configured');
  assert.equal(items.image.state, 'needs_setup');
  assert.equal(items.learning.state, 'disabled');
  assert.equal(items.commands.state, 'disabled');
  assert.equal(result.networkProbed, false);
  assert.ok(result.items.every(i => i.tools.every(n => ['search_knowledge','create_document','view_image','web_search'].includes(n))));
  assert.equal(Object.values(result.counts).reduce((a,b) => a+b,0), result.items.length);
});
test('能力目录不会泄露插件目标和凭据；不可读配置不能标记已配置', () => {
  const result = buildCapabilityCatalog({ schemas: schemas('generate_image','zotero_search'), settingsReadable: false,
    extensions: [{ enabled: true, name: 'private-name', target: 'http://private-host', token: 'synthetic-private-secret' }] });
  assert.equal(result.items.find(i => i.id === 'mcp').state, 'configured');
  assert.equal(result.items.find(i => i.id === 'image').state, 'needs_setup');
  const text = JSON.stringify(result);
  for (const hidden of ['private-name','private-host','synthetic-private-secret']) assert.ok(!text.includes(hidden));
});
test('安装浏览器不等于启用 Agent 浏览器工具', () => {
  const capability = options => buildCapabilityCatalog(options).items.find(i => i.id === 'browser');
  assert.equal(capability({ browser: true }).state, 'needs_setup');
  assert.equal(capability({ browser: true, extensions: [{ enabled: true, kind: 'browser', tools: [] }] }).state, 'needs_setup');
  assert.equal(capability({ browser: true, extensions: [{ enabled: true, kind: 'browser', tools: [{ allowed: true }] }] }).state, 'available');
});
test('自动学习开关不冒充历史检索与待确认记忆的总开关', () => {
  const options = { schemas: schemas('remember','search_history'), learning: false };
  const row = buildCapabilityCatalog(options).items.find(i => i.id === 'learning');
  assert.equal(row.state, 'available'); assert.match(row.note, /自动审查已关闭/);
  const optedOut = buildCapabilityCatalog({ ...options, learning: true, automaticLearning: false }).items.find(i => i.id === 'learning');
  assert.match(optedOut.note, /自动学习审查已关闭/);
});

test('能力的配置动作全部解析到真实分区，命令和数学排版具有独立落点', () => {
  const rows = buildCapabilityCatalog().items;
  for (const row of rows.filter(item => item.action.startsWith('settings-'))) {
    assert.ok(resolveConfigurationSection(row.action.slice(9)), `${row.id} has no settings destination`);
  }
  const destinations = Object.fromEntries(rows.map(row => [row.id, resolveConfigurationSection(row.action.slice(9))]));
  assert.equal(destinations.commands.selector, '[data-runtime="execEnabled"]');
  assert.equal(destinations.latex.selector, '#runtime-math');
  assert.equal(destinations.desktop.selector, '[data-runtime="desktopEnabled"]');
  assert.equal(destinations.image.panel, 'image');
  assert.equal(destinations.zotero.panel, 'zotero');
  assert.equal(destinations.delegate.section, 'teams');
  assert.ok(!rows.some(row => row.action === 'monitor'));
});

test('验证结论仅提供回源入口，不能将历史总结或模型复查标成事实证明', () => {
  const row = buildCapabilityCatalog({ schemas: schemas('search_knowledge'), learning: false }).items.find(item => item.id === 'conclusions');
  assert.equal(row.action, 'knowledge-conclusions');
  assert.deepEqual(row.tools, ['search_knowledge']);
  assert.match(row.note, /人工确认/);
  assert.match(row.note, /不是事实证明/);
  assert.equal(buildCapabilityCatalog().items.find(item => item.id === 'conclusions').state, 'disabled');
});
