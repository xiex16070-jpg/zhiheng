import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import { normalizeStructuredContent } from '../src/server/extract/mineru.mjs';
import { scorePage, markdownPages, runPdfEvaluation } from '../evals/pdf-pages.mjs';

test('page text and reading order, including omitted or repeated anchors', () => {
  const anchors = ['命题甲', '证明乙', '结论丙'];
  const gold = anchors.join('\n');
  assert.equal(scorePage(gold, gold, anchors).characterErrorRate, 0);
  assert.equal(scorePage(gold, [...anchors].reverse().join(' '), anchors).readingOrderAccuracy, 0);
  assert.equal(scorePage(gold, '命题甲 证明乙', anchors).readingOrderAccuracy, 1 / 3);
  assert.equal(scorePage(gold, '', anchors).characterErrorRate, 1);
  assert.equal(scorePage(gold, '命题甲 证明乙 证明乙 结论丙', anchors).missingOrAmbiguousAnchors, 1);
  assert.throws(() => scorePage(gold, gold, [...anchors].reverse()), /reading_order/);
});
test('synthetic MinerU block offsets split Markdown onto the original pages', () => {
  const input = normalizeStructuredContent({ pages: [
    { page_idx: 0, blocks: [{ type: 'text', content: '# 条件' }, { type: 'text', content: 'α → β' }] },
    { page_idx: 1, blocks: [{ type: 'table', content: '|x|y|', captions: [{ content: '表一' }] }] },
  ] });
  assert.deepEqual(markdownPages(input, 2), ['# 条件\n\nα → β', '表一\n\n|x|y|']);
  assert.throws(() => markdownPages(input, 3), /count/);
});
test('real two-page synthetic PDF prepares blank human sheets, skips missing input, and rejects incomplete gold before upload', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-pdf-benchmark-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText('Synthetic fixture page one'); pdf.addPage().drawText('Synthetic fixture page two');
  const source = path.join(dir, 'sample.pdf'), gold = path.join(dir, 'gold');
  await fs.writeFile(source, await pdf.save());
  assert.equal((await runPdfEvaluation(['prepare', '--pdf', source, '--out', gold])).status, 'awaiting_human');
  assert.equal(await fs.readFile(path.join(gold, 'page-2.md'), 'utf8'), '');
  assert.equal((await runPdfEvaluation(['run'])).status, 'skipped');
  await assert.rejects(runPdfEvaluation(['run', '--pdf', source, '--gold', gold, '--out', path.join(dir, 'out'),
    '--endpoint', 'http://127.0.0.1:1']), /human_gold/);
  const manifestFile = path.join(gold, 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  Object.assign(manifest, { kind: 'synthetic_fixture', authorization: 'Generated in this test', reviewer: 'fixture', reviewedAt: '2026-11-15T00:00:00Z' });
  for (const p of manifest.pages) {
    p.anchors = ['Synthetic', 'page'];
    await fs.writeFile(path.join(gold, 'page-' + p.page + '.md'), 'Synthetic fixture page ' + (p.page === 1 ? 'one' : 'two'));
  }
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const extract = async () => normalizeStructuredContent({ pages: [1,2].map(page => ({
    page_idx: page - 1, blocks: [{ type: 'text', content: 'Synthetic fixture page ' + (page === 1 ? 'one' : 'two') }],
  })) });
  const result = await runPdfEvaluation(['run', '--pdf', source, '--gold', gold, '--out', path.join(dir, 'out'),
    '--endpoint', 'http://127.0.0.1:1'], { extract });
  assert.equal(result.status, 'fixture_scored');
  assert.equal(result.scoredPages, 2);
  assert.deepEqual(result.pages.map(p => p.characterErrorRate), [0, 0]);
  assert.equal(await fs.readFile(path.join(dir, 'out', 'page-2.md'), 'utf8'), 'Synthetic fixture page two');
  const invalid = path.join(dir, 'partial-result');
  const failure = await runPdfEvaluation(['run', '--pdf', source, '--gold', gold, '--out', invalid,
    '--endpoint', 'http://127.0.0.1:1'], { extract: async () => ({ parser: 'mineru', pages: 1, sourceMap: [] }) });
  assert.equal(failure.status, 'failed');
  assert.equal(JSON.parse(await fs.readFile(path.join(invalid, 'report.json'), 'utf8')).scoredPages, 0);
});
