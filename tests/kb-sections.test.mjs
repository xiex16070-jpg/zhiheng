import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('private sections survive restart and constrain lexical, vector, MCP and follow-up tool reads', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiheng-kb-sections-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  Object.assign(process.env, {
    KB_FILE: path.join(directory, 'kb.json'), VECTOR_FILE: path.join(directory, 'vectors.json'),
    DATA_DIR: directory, MYSQL_ENABLED: 'false', QDRANT_URL: '', EMBEDDING_PROVIDER: 'local',
    EMBEDDING_BASE_URL: '', EMBEDDING_MODEL: 'local-hash-512', EMBEDDING_REVISION: '', EMBEDDING_DIM: '512',
    CORPUS_PROFILE: 'formal', CORPUS_JSONL: '', RERANK_ENABLED: 'false',
  });
  const { initKb, importDocument, deleteDocument, suggestSection, saveSection, listSections } = await import('../src/server/kb.mjs');
  const { searchVectors, initVector } = await import('../src/server/vector.mjs');
  const { initRag, listCorpusFiles } = await import('../src/server/rag.mjs');
  const { executeTool } = await import('../src/server/tools.mjs');
  const { retrieveAll } = await import('../src/server/retrieve.mjs');
  const { userPreferenceError, effectivePreferences } = await import('../src/server/preferences.mjs');
  const { callMcpTool } = await import('../src/server/mcp.mjs');
  await initVector();
  await initKb({ mysqlReady: false });
  const rag = await initRag({ mysqlReady: false });
  const catalog = listCorpusFiles();
  assert.ok(catalog.length > 1);
  assert.equal(catalog.reduce((count, file) => count + file.records.length, 0), rag.papers);
  assert.ok(catalog.every(file => file.name.endsWith('.v')));
  const upload = async (userId, name, text) => (await importDocument({ userId, name, buffer: Buffer.from(text) })).doc;
  const inside = await upload('alice', '约束求解讲义.md', '本章讨论约束求解中变量定义与冲突分析。');
  const outside = await upload('alice', '临时试题.md', '约束求解试题涉及本周的新材料和附加实验。');
  const bob = await upload('bob', '外部资料.md', '约束求解私人资料属于另一位使用者。');
  const scan1 = await upload('scanner', '001.txt', '约束求解可用来寻找满足条件的变量取值。');
  const scan2 = await upload('scanner', '002.txt', '约束求解可以用于冲突分析和调度。');
  const fromContents = await suggestSection('scanner', [scan1.id, scan2.id]);
  assert.match(fromContents.name, /约束|求解/);
  const docIds = [inside.id];
  const suggestion = await suggestSection('alice', docIds);
  assert.match(suggestion.summary, /变量定义与冲突分析/);
  assert.match(suggestion.name, /约束求解/);
  for (const bad of [[], [bob.id], [inside.id, 'unknown']]) await assert.rejects(suggestSection('alice', bad));
  const saved = await saveSection('alice', null, { ...suggestion, docIds: [...docIds, ...docIds] });
  assert.deepEqual(saved.docIds, docIds);
  const updated = await saveSection('alice', saved.id, { name: '约束求解', summary: '可修改', docIds });
  await assert.rejects(saveSection('bob', saved.id, { ...updated, docIds: [bob.id] }));
  await assert.rejects(saveSection('alice', saved.id, { ...updated, docIds: [bob.id] }));
  await initKb({ mysqlReady: false });
  assert.deepEqual(await listSections('alice'), [updated]);
  assert.deepEqual(await listSections('bob'), []);
  const preferences = { discipline: saved.id };
  assert.equal(effectivePreferences(preferences).discipline, saved.id);
  assert.equal(await userPreferenceError('alice', preferences), '');
  assert.ok(await userPreferenceError('bob', preferences));
  const query = '约束求解';
  const args = { userId: 'alice', discipline: saved.id, rewrite: false };
  for (const channels of [['kb'], ['vector'], ['kb', 'vector', 'external', 'paper']]) {
    const { results } = await retrieveAll(query, { ...args, channels });
    assert.ok(results.length > 0, channels.join(','));
    assert.ok(results.every(r => r.kind === 'doc' && r.docId === inside.id));
  }
  // Force the scoped file to compete with a stronger match. Apply membership before top-k.
  const vectors = await searchVectors(outside.text, { userId: 'alice', k: 1, kind: 'doc', docIds, minScore: -1 });
  assert.deepEqual(vectors.results.map(x => x.payload.docId), docIds);
  assert.deepEqual((await retrieveAll(query, { ...args, userId: 'bob' })).results, []);
  const ctx = { userId: 'alice', preferences, evidence: new Map(), allowSearchFallback: true };
  const searched = await executeTool('search_knowledge', { query, discipline: '其他学科', source: 'paper' }, ctx);
  assert.ok(searched.evidence.length);
  assert.ok(searched.evidence.every(e => e.docId === inside.id));
  const mcpCtx = { callerId: 'alice', getPreferences: async () => preferences };
  for (const name of ['read_source', 'verify_quote']) {
    for (const ref of ['111724829509355', outside.id + '_0', bob.id + '_0']) {
      const toolArgs = { ref, quote: outside.text };
      assert.equal((await executeTool(name, toolArgs, ctx)).summary, '来源超出分区');
      assert.equal((await callMcpTool(name, toolArgs, mcpCtx)).isError, true);
    }
  }
  const listed = await callMcpTool('list_documents', {}, mcpCtx);
  assert.match(listed.content[0].text, /约束求解讲义/);
  assert.doesNotMatch(listed.content[0].text, /临时试题|外部资料/);
  assert.equal((await executeTool('web_fetch', { url: 'https://invalid.invalid' }, ctx)).summary, '来源超出分区');
  assert.ok((await executeTool('read_source', { ref: inside.id + '_0' }, ctx)).text.includes(inside.text));
  await deleteDocument(inside.id, 'alice');
  await initKb({ mysqlReady: false });
  assert.deepEqual((await listSections('alice'))[0].docIds, []);
  assert.deepEqual((await retrieveAll(query, args)).results, []);
});
