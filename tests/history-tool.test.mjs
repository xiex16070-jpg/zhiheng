/**
 * search_history 工具测试：只检索本人历史会话、按关键词命中、隔离其他用户。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-hist-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['hist', 'test', 'key'].join('-');

const { createStore, getStore } = await import('../src/server/store.mjs');
const { executeTool, TOOL_SCHEMAS } = await import('../src/server/tools.mjs');

await createStore(false);
const store = getStore();

const A = 'uhistuser01';
const B = 'uhistuser02';

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('schema 暴露 search_history', () => {
  assert.ok(TOOL_SCHEMAS.some((t) => t.function.name === 'search_history'));
});

test('命中本人历史会话并给出片段；不串到他人会话', async () => {
  const ca = await store.createConversation({ id: 'conv-a1', userId: A, title: '钙钛矿稳定性讨论' });
  await store.addMessage({ conversationId: ca.id, role: 'user', content: '上次结论说甲脒掺杂能抑制相分离，有依据吗？' });
  await store.addMessage({ conversationId: ca.id, role: 'assistant', content: '有：两篇 2023 年的研究都报告了甲脒掺杂后相稳定性提升，[[ref:12]]。' });

  const cb = await store.createConversation({ id: 'conv-b1', userId: B, title: '别人的会话' });
  await store.addMessage({ conversationId: cb.id, role: 'user', content: '甲脒掺杂只在我的会话里出现' });

  const ctxA = { userId: A, evidence: new Map(), preferences: {} };
  const r = await executeTool('search_history', { query: '甲脒掺杂' }, ctxA);
  assert.match(r.text, /历史会话命中/);
  assert.match(r.text, /钙钛矿稳定性讨论/);
  assert.match(r.text, /相稳定性提升/);
  assert.ok(!r.text.includes('别人的会话'), '不得看到他人会话');

  const ctxB = { userId: B, evidence: new Map(), preferences: {} };
  const rb = await executeTool('search_history', { query: '相稳定性' }, ctxB);
  assert.match(rb.text, /没有找到/, 'B 查不到 A 的内容');
});

test('参数校验与空结果', async () => {
  const ctx = { userId: A, evidence: new Map(), preferences: {} };
  const bad = await executeTool('search_history', { query: 'x' }, ctx);
  assert.match(bad.text, /工具参数不符合定义/);

  const none = await executeTool('search_history', { query: '完全不存在的词' }, ctx);
  assert.match(none.text, /没有找到/);
});
