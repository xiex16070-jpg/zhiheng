import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, REVISION, parseCoqSections, chunkSections, stableId, sha256, buildCorpus, sectionLanguage, sectionKeywords } from '../scripts/ingest-formal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORMAL = path.join(ROOT, 'data/formal');

test('中文教材导入保留嵌套注释、逻辑符号、证明代码与源行范围，标题内正文不丢失', () => {
  const source = '(** * Logic: 逻辑 *)\n(** ** 否定\n否定是蕴含假命题。 *)\nDefinition quoted := "(* literal *)".\n(* ==> output (* nested *) *)\nTheorem p : True.\nProof. exact I. Qed.\n(** 下一段。 *)';
  const sections = parseCoqSections(source, '逻辑');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].heading, '否定');
  const [chunk] = chunkSections(sections);
  assert.match(chunk.text, /否定是蕴含假命题/);
  assert.match(chunk.text, /"\(\* literal \*\)"/);
  assert.match(chunk.text, /output \(\* nested \*\)/);
  assert.match(chunk.text, /Proof\. exact I\. Qed\./);
  assert.equal(chunk.sourceStartLine, 2);
  assert.equal(chunk.sourceEndLine, 8);
  assert.throws(() => parseCoqSections('(** unclosed'), /Unclosed/);
});

test('分片在完整块边界进行，不截断证明；稳定ID不依赖全库行号', () => {
  const sections = [{ heading: '合取', ordinal: 0, blocks: [
    { text: '解释'.repeat(80), sourceStartLine: 1, sourceEndLine: 2, kind: 'prose' },
    { text: 'Theorem example.\nProof.\n' + 'exact I.\n'.repeat(50) + 'Qed.', sourceStartLine: 3, sourceEndLine: 55, kind: 'code' },
  ] }];
  const chunks = chunkSections(sections, 200);
  assert.equal(chunks.length, 2);
  assert.match(chunks[1].text, /^Theorem example[\s\S]*Qed\.$/);
  const id = stableId('lf-current/Logic.v', '合取', 0, 1);
  assert.ok(Number.isSafeInteger(id) && id > 900_000_000);
  assert.equal(id, stableId('lf-current/Logic.v', '合取', 0, 1));
  assert.notEqual(id, stableId('lf-current/Logic.v', '合取', 1, 1));
  assert.notEqual(id, stableId('plf-current/Hoare.v', '合取', 0, 1));
});

test('尚未翻译的正文保留英文标记，不由中文章名伪装为中文原文', () => {
  assert.equal(sectionLanguage('We begin by repeating the relevant language definition, which is a subset of the simply typed lambda calculus without products or recursive functions.'), 'en');
  assert.equal(sectionLanguage('关于类型的第二个重要性质是，当一个良型项可前进一步时，其结果也是一个良型项。'), 'zh-CN');
  assert.equal(sectionLanguage(''), 'code');
});

test('关键词限定到实际小节，练习不会继承整章无关逻辑术语', () => {
  const chapter = CATALOG.find((item) => item.chapter === 'Logic');
  const conjunction = sectionKeywords(chapter, { heading: '合取', text: '命题 A 与 B 的合取表示两者均为真。' });
  assert.match(conjunction, /conjunction/);
  assert.doesNotMatch(conjunction, /析取|排中律|全称/);
  const exercise = sectionKeywords(CATALOG.find((item) => item.chapter === 'ProofObjects'), { heading: '练习 eight_is_even', text: '写出 ev 8 的证明对象。' });
  assert.doesNotMatch(exercise, /Curry|Howard|命题即类型/);
});

test('固定版本中文全文库可逐字离线重建，许可、来源、哈希和章节完整', async () => {
  const texts = new Map(await Promise.all(CATALOG.map(async (entry) => [entry.path, await fs.readFile(path.join(FORMAL, 'sources', entry.path), 'utf8')])));
  const actual = await fs.readFile(path.join(FORMAL, 'papers.jsonl'), 'utf8');
  const manifest = JSON.parse(await fs.readFile(path.join(FORMAL, 'manifest.json'), 'utf8'));
  const built = buildCorpus(texts);
  assert.equal(built.jsonl, actual);
  assert.equal(manifest.contentSha256, sha256(actual));
  assert.equal(manifest.revision, REVISION);
  assert.equal(manifest.chapterCount, CATALOG.length);
  assert.equal(manifest.sectionCount, built.records.length);
  assert.ok(manifest.sectionCount > 300, 'must contain substantive textbook sections, not a few sample summaries');
  assert.ok(manifest.totalCharacters > 400_000);
  assert.equal(new Set(built.records.map((r) => r.id)).size, built.records.length);
  for (const record of built.records) {
    assert.equal(record.recordType, 'textbook-section');
    assert.equal(record.contentSha256, sha256(record.abstract));
    assert.equal(record.sourceSha256, sha256(texts.get(record.sourcePath)));
    assert.match(record.sourceUrl, new RegExp(`${REVISION}/.+#L\\d+-L\\d+$`));
    assert.ok(record.sourceStartLine > 0 && record.sourceEndLine >= record.sourceStartLine);
    assert.ok(record.sourceEndLine <= texts.get(record.sourcePath).split('\n').length);
    assert.equal(record.translationStatus, 'alpha');
    assert.equal(record.proofStatus, 'source-text-not-rechecked');
    assert.ok(['zh-CN', 'en', 'mixed', 'code'].includes(record.language));
    assert.equal(record.sourceEditionDate, '2022-03-14');
    assert.equal(record.license, 'MIT');
    assert.ok(record.authors.length > 0);
  }
  assert.ok(built.records.some((r) => /排中律/.test(r.abstract)));
  assert.ok(built.records.some((r) => /Hoare/.test(r.sourcePath) && /循环|不变式/.test(r.abstract)));
  assert.ok(built.records.some((r) => /Proof\.[\s\S]*Qed\./.test(r.abstract)));
  assert.ok(built.records.some((r) => r.containsExercises && /Admitted\./.test(r.abstract)));
  for (const notice of manifest.notices) {
    const text = await fs.readFile(path.join(FORMAL, 'sources', notice.path), 'utf8');
    assert.equal(sha256(text), notice.sha256);
    if (notice.path.endsWith('LICENSE')) assert.match(text, /Permission is hereby granted/);
  }
});
