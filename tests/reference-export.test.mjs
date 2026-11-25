import assert from 'node:assert/strict';
import test from 'node:test';
import { Cite } from '@citation-js/core';
import { exportReferences } from '../src/server/reference-export.mjs';

const title = '中文 {递归} & 50% #1_a ^ ~ \\ <条件> $';
const snapshot = {
  body: '先 [[z9]]。未知 [[wrong]]。再 [[a2]]，复引 [[z9]]。最后 [[constructor]]。',
  citations: [
    { ref: 'a2', kind: 'paper', title: 'Alpha', doi: '10.1234/alpha', year: '2018', volume: 2, issue: '3', page: '11-17' },
    { ref: 'unused', title: 'Not actually cited' },
    { ref: 'constructor', title: '内部资料', kind: 'doc', heading: '附录' },
    { ref: 'z9', title, kind: 'external', sourceUrl: 'https://example.test/record/1', sourceText: 'synthetic full snapshot',
      authority: { catalog: '示例目录', type: 'preprint', evidenceLevel: 'abstract', retrievedAt: '2026-11-12T10:00:00Z',
        authorList: [{ family: '欧阳', given: '明' }, { literal: '研发 & 合作组' }] } },
  ],
};

test('CSL-JSON exports only saved cited fields in first-citation order and preserves abstract scope', () => {
  const [a, b, c] = JSON.parse(exportReferences(snapshot, 'csl-json'));
  assert.deepEqual([a.id, b.id, c.id], ['z9', 'a2', 'constructor']);
  assert.equal(a.title, title);
  assert.deepEqual(a.author, [{ family: '欧阳', given: '明' }, { literal: '研发 & 合作组' }]);
  assert.equal(a.type, 'manuscript');
  assert.match(a.note, /正文 \[1\] ref=z9.*示例目录.*仅摘要.*预印本/);
  for (const field of ['DOI', 'issued', 'publisher', 'abstract', 'container-title']) assert.equal(a[field], undefined);
  assert.deepEqual(a.accessed, { 'date-parts': [[2026, 11, 12]] });
  assert.equal(b.author, undefined);
  assert.deepEqual(b.issued, { 'date-parts': [[2018]] });
  assert.equal(b.DOI, '10.1234/alpha');
  assert.deepEqual([b.volume, b.issue, b.page], ['2', '3', '11-17']);
  assert.match(c.note, /正文 \[3\].*知识库文档.*附录/);
});

for (const format of ['bibtex', 'ris']) test(format + ' round-trips Unicode, metacharacters, stable IDs and notes', () => {
  const encoded = exportReferences(snapshot, format);
  const parsed = new Cite(encoded).data;
  assert.deepEqual(parsed.map(r => r.id), ['z9', 'a2', 'constructor']);
  assert.equal(parsed[0].title, title);
  assert.equal(parsed[0].author[0].family, '欧阳');
  assert.equal(parsed[0].author[0].given, '明');
  assert.equal(parsed[0].author[1].family || parsed[0].author[1].literal, '研发 & 合作组');
  assert.equal(parsed[0].DOI, undefined);
  assert.equal(parsed[0].issued, undefined);
  assert.equal(parsed[1].DOI, '10.1234/alpha');
  assert.match(parsed[0].note, /仅摘要/);
  assert.doesNotMatch(encoded, /synthetic full snapshot|Not actually cited|wrong/);
});

test('APA keeps answer numbers even for entries that the style normally alphabetizes', () => {
  const output = exportReferences(snapshot, 'apa');
  assert.match(output, /^\[1\] .*中文[\s\S]+仅摘要[\s\S]+\[2\] Alpha[\s\S]+\[3\] 内部资料/);
  assert.equal(exportReferences({ body: '[[wrong]]', citations: snapshot.citations }, 'bibtex'), null);
  assert.throws(() => exportReferences(snapshot, 'toString'), /invalid_reference_format/);
});
