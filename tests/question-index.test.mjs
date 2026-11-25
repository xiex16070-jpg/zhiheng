import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('research questions rotate through real sources and follow private section changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zhiheng-question-index-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  Object.assign(process.env, {
    DATA_DIR: dir, KB_FILE: path.join(dir, 'kb.json'), VECTOR_FILE: path.join(dir, 'vectors.json'),
    MYSQL_ENABLED: 'false', QDRANT_URL: '', EMBEDDING_PROVIDER: 'local', CORPUS_PROFILE: 'formal', CORPUS_JSONL: '',
  });
  const { initKb, importDocument, saveSection, deleteDocument, getChunkById } = await import('../src/server/kb.mjs');
  const { initRag, getPaper } = await import('../src/server/rag.mjs');
  const { initVector } = await import('../src/server/vector.mjs');
  const { researchQuestions } = await import('../src/server/question-index.mjs');
  await initVector();
  await initKb({ mysqlReady: false });
  await initRag({ mysqlReady: false });
  const builtins = await researchQuestions('alice', '', 0);
  assert.equal(builtins.length, 6);
  assert.notDeepEqual(builtins, await researchQuestions('alice', '', 1));
  for (const { ref, question, topic, source } of builtins) {
    assert.ok(await getPaper(ref));
    assert.ok(topic.length && question.includes(topic.replace(/…$/, '')));
    assert.equal(source, '专业文献');
  }
  assert.deepEqual(await researchQuestions('alice', '已停用的学科'), []);

  async function upload(userId, name, text) {
    return (await importDocument({ userId, name, buffer: Buffer.from(text) })).doc;
  }
  const first = await upload('alice', '001.md', '# 归纳不变式\n对每个循环状态验证归纳不变式。');
  const second = await upload('alice', '002.txt', '可达状态构成一个集合，据此核对断言。');
  await upload('bob', '独有文件.txt', '不应出现在其他用户的首页。');
  const all = await researchQuestions('alice');
  assert.equal(all.length, 6);
  assert.ok(all.filter(c => c.kind === 'doc').length === 2 && all.some(c => c.kind === 'paper'));
  assert.doesNotMatch(JSON.stringify(all), /独有文件/);
  assert.deepEqual(await researchQuestions('alice', '计算机科学与形式逻辑'), builtins);
  const grouped = await saveSection('alice', null, { name: '验证', docIds: [first.id] });
  const scoped = await researchQuestions('alice', grouped.id);
  assert.equal(scoped.length, 1);
  assert.match(scoped[0].question, /归纳不变式/);
  assert.equal((await getChunkById(scoped[0].ref, 'alice')).docId, first.id);
  assert.deepEqual(await researchQuestions('bob', grouped.id), []);
  await saveSection('alice', grouped.id, { name: '验证', docIds: [second.id] });
  assert.match((await researchQuestions('alice', grouped.id))[0].question, /可达状态/);
  await deleteDocument(second.id, 'alice');
  assert.deepEqual(await researchQuestions('alice', grouped.id), []);

  const filename = '马克思主义基本原理_辅导用书_2025_10_第424-465页_ocr.md';
  const imported = await upload('alice', filename, '# 专题讲义\n' + filename + '\n2025-10\n第424-465页\n资本主义基本矛盾，是生产社会化和生产资料资本主义私人占有之间的矛盾。');
  const another = await upload('alice', '辅导用书_2025_09_第377-423页_ocr.md', '# 专题讲义\n对具体状况的科学分析，能够帮助澄清研究前提与结论。');
  const topics = await saveSection('alice', null, { name: '主题测试', docIds: [imported.id, another.id] });
  const questions = await researchQuestions('alice', topics.id);
  assert.equal(questions.length, 2);
  assert.notEqual(questions[0].topic, questions[1].topic);
  assert.ok(questions.some(item => item.question.includes('资本主义基本矛盾')));
  assert.ok(questions.some(item => item.question.includes('对具体状况的科学分析')));
  for (const item of questions) {
    assert.equal(item.source, '导入资料');
    assert.doesNotMatch(JSON.stringify({ source: item.source, question: item.question, topic: item.topic }), /辅导用书|2025|424|465|377|423|ocr|\.md|专题讲义/iu);
    assert.equal((await getChunkById(item.ref, 'alice')).docId, item.docId);
  }
  const semanticName = await upload('alice', 'logic.md', '# 专题讲义\nLogical relations establish the proof.');
  const semanticSection = await saveSection('alice', null, { name: '词义保留', docIds: [semanticName.id] });
  const semantic = await researchQuestions('alice', semanticSection.id);
  assert.match(semantic[0].question, /Logical relations/);
  const namedConcept = await upload('alice', '逻辑归纳.md', '# 专题讲义\n逻辑归纳的基础情形与归纳步骤共同建立证明。');
  await saveSection('alice', semanticSection.id, { name: '词义保留', docIds: [namedConcept.id] });
  assert.match((await researchQuestions('alice', semanticSection.id))[0].question, /逻辑归纳的基础情形/);
});
