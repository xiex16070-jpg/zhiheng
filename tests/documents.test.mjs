import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-documents-test-'));
process.env.DATA_DIR = root;
const { createDocument } = await import('../src/server/documents.mjs');
const { writeFile, patchFile, readFile, resolveSafe } = await import('../src/server/workspace.mjs');
const { executeTool } = await import('../src/server/tools.mjs');
const { readFilePermission,saveFilePermission } = await import('../src/server/file-permissions.mjs');
const { extractText } = await import('../src/server/extract/index.mjs');
after(() => fs.rm(root, { recursive: true, force: true }));
const markdown = '## 核心结论\n\n**形式验证**依据规范检验程序，未知不等于否定。\n\n| 前提 | 结论 |\n|---|---|\n| 完成验证 | 满足规范 |\n\n> 引文需要核对原文。\n\n1. 检索\n2. 核验\n\n![引用示意图](assets/pixel.png)\n\n参考 [[ref_one]]';
const evidence = new Map([['ref_one', { title: '验证依据', sourceUrl: 'https://example.org/paper', authority: { evidenceLevel: 'abstract' } }]]);
// Tiny valid PNG; image bytes are fixture data, no external requests.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64');

test('实际生成 PDF/DOCX 二进制、中文/表格/图片/引用，工具返回可下载产物', async () => {
  // This renderer contract explicitly grants the isolated test project file access.
  await saveFilePermission('alice',{...await readFilePermission('alice'),mode:'trusted'});
  const image = resolveSafe('alice', 'assets/pixel.png');
  await fs.mkdir(path.dirname(image.abs), { recursive: true }); await fs.writeFile(image.abs, png);
  for (const extension of ['docx', 'pdf']) {
    const result = await executeTool('create_document', { path: '研究报告.' + extension, title: '形式验证研究', markdown }, { userId: 'alice', evidence, preferences: {} });
    assert.ok(result.artifact, result.text);
    const file = resolveSafe('alice', result.artifact.path).abs;
    const data = await fs.readFile(file);
    assert.equal(data.subarray(0, extension === 'pdf' ? 5 : 2).toString(), extension === 'pdf' ? '%PDF-' : 'PK');
    if (extension === 'docx') {
      const result = await extractText(data, '研究报告.docx');
      assert.match(result.text, /形式验证/);
      assert.match(result.text, /验证依据/);
      assert.match(result.text, /仅摘要/);
      assert.ok(!result.text.includes('[[ref_one]]'));
    }
    assert.equal(data.length, result.artifact.bytes);
  }
});

test('源 Markdown 可复用，默认不覆盖已有产物；未知引用拒绝落盘', async () => {
  await writeFile('alice', 'draft.md', '# 中文文档\n\n来源待核对');
  assert.equal((await createDocument('alice', { path: 'from-source.docx', source_path: 'draft.md' })).ok, true);
  const old = await fs.readFile(resolveSafe('alice', 'from-source.docx').abs);
  assert.equal((await createDocument('alice', { path: 'from-source.docx', markdown: 'changed' })).code, 'exists');
  assert.deepEqual(await fs.readFile(resolveSafe('alice', 'from-source.docx').abs), old);
  const unknown = await createDocument('alice', { path: 'bad.docx', markdown: '引用 [[no_such_ref]]' });
  assert.equal(unknown.ok, false);
  await assert.rejects(fs.access(resolveSafe('alice', 'bad.docx').abs));
});

test('文档工具遵守用户工作区、取消、输入/图片限制；文本工具不能损坏二进制', async () => {
  assert.equal((await createDocument('bob', { path: '../escape.pdf', markdown: 'x' })).ok, false);
  assert.equal((await createDocument('bob', { path: 'image.docx', markdown: '![x](assets/pixel.png)' })).ok, false);
  assert.equal((await createDocument('alice', { path: 'remote.pdf', markdown: '![x](https://example.org/private.png)' })).ok, false);
  assert.equal((await createDocument('alice', { path: 'huge.docx', markdown: 'x'.repeat(60001) })).ok, false);
  await assert.rejects(createDocument('alice', { path: 'cancel.pdf', markdown: 'cancelled' }, { signal: AbortSignal.abort() }));
  assert.equal((await writeFile('alice', 'fake.pdf', 'plain text')).code, 'binary_format');
  assert.equal((await patchFile('alice', '研究报告.docx', 'a', 'b')).code, 'binary_format');
  assert.equal((await readFile('alice', '研究报告.pdf')).code, 'binary_format');
});
