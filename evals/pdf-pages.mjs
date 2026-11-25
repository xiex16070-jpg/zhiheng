/** Two-page, offline Markdown/read-order benchmark for the existing MinerU adapter. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { extractMineru } from '../src/server/extract/mineru.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const normalize = s => s.normalize('NFC').replace(/\s+/gu, ' ').trim();
const pageName = n => 'page-' + n + '.md';
const json = value => JSON.stringify(value, null, 2) + '\n';

// Rolling-row Levenshtein on Unicode code points, including punctuation and Markdown syntax.
function editDistance(a, b) {
  let previous = Uint32Array.from({ length: b.length + 1 }, (_, i) => i);
  let current = new Uint32Array(previous.length);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + Number(a[i - 1] !== b[j - 1]));
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function uniquePosition(haystack, needle) {
  const position = haystack.indexOf(needle);
  return position >= 0 && position === haystack.lastIndexOf(needle) ? position : -1;
}

export function scorePage(gold, prediction, anchors) {
  const expected = normalize(gold), observed = normalize(prediction);
  const reference = [...expected], actual = [...observed];
  if (!reference.length || Math.max(reference.length, actual.length) > 12000) throw Error('empty_reference_or_page_exceeds_12000_codepoints');
  if (!Array.isArray(anchors) || anchors.length < 2 || anchors.length > 100) throw Error('supply_2_to_100_ordered_anchors');
  const terms = anchors.map(s => normalize(s));
  const positions = terms.map(s => uniquePosition(expected, s));
  if (terms.some((s, i) => !s || positions[i] < 0 || (i && positions[i] <= positions[i - 1]))) throw Error('reference_anchors_must_be_unique_and_in_reading_order');
  const found = terms.map(s => uniquePosition(observed, s));
  let correctPairs = 0;
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) if (found[i] >= 0 && found[j] > found[i]) correctPairs++;
  }
  const edits = editDistance(reference, actual), pairs = terms.length * (terms.length - 1) / 2;
  return { expectedChars: reference.length, actualChars: actual.length, edits, characterErrorRate: edits / reference.length,
    correctPairs, expectedPairs: pairs, readingOrderAccuracy: correctPairs / pairs, missingOrAmbiguousAnchors: found.filter(i => i < 0).length };
}

export function markdownPages(extraction, expectedCount) {
  if (extraction.parser !== 'mineru' || extraction.pages !== expectedCount) throw Error('parser_or_page_count_mismatch');
  const pages = Array.from({ length: expectedCount }, () => []);
  let end = 0;
  for (const block of extraction.sourceMap) {
    if (!Number.isInteger(block.page) || block.page < 1 || block.page > expectedCount || !Number.isInteger(block.start)
        || !Number.isInteger(block.end) || block.start < end || block.end <= block.start || block.end > extraction.text.length) throw Error('invalid_page_mapping');
    pages[block.page - 1].push(extraction.text.slice(block.start, block.end));
    end = block.end;
  }
  return pages.map(blocks => blocks.join('\n\n'));
}

async function sample(filename) {
  const info = await fs.stat(filename);
  if (!info.isFile() || info.size > 32 * 1024 * 1024) throw Error('pdf_must_be_under_32_mib');
  const bytes = await fs.readFile(filename);
  if ((await PDFDocument.load(bytes)).getPageCount() !== 2) throw Error('provide_a_two_page_pdf');
  return bytes;
}
export async function runPdfEvaluation(args, { extract = extractMineru } = {}) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: {
    pdf: { type: 'string' }, gold: { type: 'string' }, out: { type: 'string' }, endpoint: { type: 'string' } } });
  const [command] = positionals;
  if (positionals.length !== 1 || !['prepare', 'run'].includes(command)) throw Error('use_prepare_or_run');
  if (command === 'run' && (!values.pdf || !values.gold || !values.endpoint)) {
    return { status: 'skipped', reason: 'requires_explicit_two_page_pdf_human_gold_and_isolated_mineru_endpoint', scoredPages: 0 };
  }
  if (!values.out || !values.pdf) throw Error('new_output_directory_and_pdf_required');
  const bytes = await sample(values.pdf), pdfSha256 = sha(bytes);
  if (command === 'prepare') {
    await fs.mkdir(values.out);
    await fs.writeFile(path.join(values.out, 'manifest.json'), json({ schema: 'zhiheng/pdf-gold/1', pdfSha256,
      authorization: '', reviewer: '', reviewedAt: null, kind: 'pending', pages: [{ page: 1, anchors: [] }, { page: 2, anchors: [] }] }));
    for (const n of [1, 2]) await fs.writeFile(path.join(values.out, pageName(n)), '');
    return { status: 'awaiting_human', pages: 2, pdfSha256 };
  }
  const endpoint = new URL(values.endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('explicit_loopback_mineru_required');
  const manifest = JSON.parse(await fs.readFile(path.join(values.gold, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 'zhiheng/pdf-gold/1' || manifest.pdfSha256 !== pdfSha256 || !['human', 'synthetic_fixture'].includes(manifest.kind)
    || !manifest.authorization?.trim() || !manifest.reviewer?.trim() || !Number.isFinite(Date.parse(manifest.reviewedAt))
    || manifest.pages?.length !== 2 || manifest.pages.some((p, i) => p.page !== i + 1)) throw Error('authorized_hash_bound_human_gold_required');
  const gold = [];
  for (const p of manifest.pages) {
    const md = await fs.readFile(path.join(values.gold, pageName(p.page)), 'utf8');
    scorePage(md, '', p.anchors); // Reject invalid reference before transferring even one byte.
    gold.push(md);
  }
  await fs.mkdir(values.out); // Refuse to overwrite completed runs.
  let extraction;
  try { extraction = await extract(bytes, 'benchmark.pdf', { settings: { baseUrl: endpoint.href } }); }
  catch (err) {
    const unavailable = ['ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH'].includes(err.cause?.code);
    const result = { status: unavailable ? 'skipped' : 'failed', reason: unavailable ? 'isolated_mineru_unreachable' : 'mineru_extraction_failed', scoredPages: 0, pdfSha256 };
    await fs.writeFile(path.join(values.out, 'report.json'), json(result));
    return result;
  }
  let predictions, pages;
  try {
    predictions = markdownPages(extraction, 2);
    pages = predictions.map((md, i) => ({ page: i + 1, groundTruthSha256: sha(gold[i]),
      outputSha256: sha(md), ...scorePage(gold[i], md, manifest.pages[i].anchors) }));
  } catch {
    const failure = { status: 'failed', scoredPages: 0, reason: 'invalid_parser_output_for_reference_pages', pdfSha256 };
    await fs.writeFile(path.join(values.out, 'report.json'), json(failure));
    return failure;
  }
  for (const p of pages) await fs.writeFile(path.join(values.out, pageName(p.page)), predictions[p.page - 1]);
  const report = { status: manifest.kind === 'human' ? 'scored' : 'fixture_scored', goldKind: manifest.kind, scoredPages: 2,
    pdfSha256, referenceManifestSha256: sha(json(manifest)), parser: 'mineru', parserVersion: extraction.parserVersion || null, pages };
  await fs.writeFile(path.join(values.out, 'report.json'), json(report));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPdfEvaluation(process.argv.slice(2)).then(r => { console.log(json(r)); if (r.status === 'failed') process.exitCode = 1; })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
