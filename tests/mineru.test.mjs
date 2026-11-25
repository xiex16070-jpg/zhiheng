import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/server/config.mjs';
import { initKb, importDocument, getDocument } from '../src/server/kb.mjs';
import { extractMineru, normalizeStructuredContent, readStructuredZip } from '../src/server/extract/mineru.mjs';
import { extractText } from '../src/server/extract/index.mjs';

const document = {
  metadata: { producer: { version: '4.1.0' } }, is_full_document: true,
  pages: [
    { page_idx: 0, blocks: [{ type: 'paragraph_title', content: '实验结果', bbox: [0.1, 0.1, 0.9, 0.2] }, { type: 'text', content: '双栏正文🙂' }] },
    { page_idx: 1, blocks: [{ type: 'table', content: '| 指标 | 值 |\n| --- | --- |\n| 精度 | 0.91 |', captions: [{ content: '表一' }] }] },
  ],
};

function zipJson(value, name = 'structured_content.json') {
  const plain = Buffer.from(JSON.stringify(value));
  const data = zlib.deflateRawSync(plain);
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of plain) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(plain.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(plain.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}

async function service(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/parser`;
}

test('MinerU 页/块映射覆盖规范文本，emoji 不破坏 UTF-16 引用偏移', () => {
  const result = normalizeStructuredContent(document);
  assert.equal(result.pages, 2);
  assert.equal(result.parserVersion, '4.1.0');
  assert.deepEqual(result.sourceMap.map((x) => result.text.slice(x.start, x.end)), ['实验结果', '双栏正文🙂', '表一', '| 指标 | 值 |\n| --- | --- |\n| 精度 | 0.91 |']);
  assert.deepEqual(result.sourceMap.map((x) => x.page), [1, 1, 2, 2]);
  assert.deepEqual(result.sourceMap[0].bbox, [0.1, 0.1, 0.9, 0.2]);
  assert.throws(() => normalizeStructuredContent({ ...document, is_full_document: false }), /partial_document/);
  assert.throws(() => normalizeStructuredContent(document, { maxTextChars: 8 }), /text_too_large/);
});

test('MinerU ZIP 只读指定结构化结果，拒绝压缩炸弹、缺文件和损坏包', () => {
  assert.deepEqual(readStructuredZip(zipJson(document)), document);
  assert.throws(() => readStructuredZip(zipJson(document), 16), /invalid_zip_member/);
  assert.throws(() => readStructuredZip(zipJson(document, '../structured_content.json')), /structured_content_missing/);
  assert.throws(() => readStructuredZip(Buffer.from('not a zip')), /invalid_zip/);
});

test('MinerU 官方 Tasks 契约：manifest→原始 PUT→轮询→ZIP，并支持反代前缀', async (t) => {
  const seen = [];
  const pdf = Buffer.from('%PDF-1.4\nfixture');
  let base;
  base = await service(t, async (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/parser/v1/tasks') {
      const payload = JSON.parse(body);
      assert.equal(payload.files[0].bytes, pdf.length);
      assert.equal(payload.files[0].file_name, 'test.pdf');
      assert.deepEqual(payload.output_formats, ['default']);
      res.writeHead(202);
      res.end(JSON.stringify({ task_id: 'job', files: [{ file_id: 'file', status: 'waiting-file', upload: { url: `${base}/uploads/file`, headers: {} } }] }));
    } else if (req.method === 'PUT') {
      assert.deepEqual(body, pdf);
      res.end('{}');
    } else if (req.url === '/parser/v1/tasks/job') {
      res.end(JSON.stringify({ task_id: 'job', files: [{ file_id: 'file', status: 'completed', result_url: `${base}/result` }] }));
    } else if (req.url === '/parser/result') {
      res.setHeader('content-type', 'application/zip');
      res.end(zipJson(document));
    } else { res.writeHead(404); res.end('{}'); }
  });
  const result = await extractMineru(pdf, 'test.pdf', { settings: { baseUrl: base, apiKey: 'fixture-key', pollMs: 10 } });
  assert.equal(result.parser, 'mineru');
  assert.equal(result.sourceMap.length, 4);
  assert.deepEqual(seen, ['POST /parser/v1/tasks', 'PUT /parser/uploads/file', 'GET /parser/v1/tasks/job', 'GET /parser/result']);
});

test('MinerU 不向返回的跨域上传地址发送文档，并取消已创建任务', async (t) => {
  let canceled = false;
  const base = await service(t, async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/cancel')) { canceled = true; res.end('{}'); return; }
    res.end(JSON.stringify({ task_id: 'job', files: [{ file_id: 'file', status: 'waiting-file', upload: { url: 'http://example.invalid/upload' } }] }));
  });
  await assert.rejects(extractMineru(Buffer.from('%PDF-'), 'test.pdf', { settings: { baseUrl: base } }), /cross_origin/);
  assert.equal(canceled, true);
});

test('MinerU 总时限覆盖轮询，超时取消远程任务', async (t) => {
  let canceled = false;
  const base = await service(t, async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/cancel')) { canceled = true; res.end('{}'); return; }
    res.end(JSON.stringify({ task_id: 'job', files: [{ file_id: 'file', status: 'running' }] }));
  });
  await assert.rejects(extractMineru(Buffer.from('%PDF-'), 'test.pdf', { settings: { baseUrl: base, timeoutMs: 60, pollMs: 10 } }), /timeout/);
  assert.equal(canceled, true);
});

test('MinerU 默认关闭且失败回退可配置，非 PDF 保留原提取方式', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
  assert.equal((await extractText(pdf, 'test.pdf', { mineru: { enabled: false } })).parser, 'lightweight');
  const fallback = await extractText(pdf, 'test.pdf', { mineru: { enabled: true, baseUrl: 'invalid', fallback: true } });
  assert.equal(fallback.parser, 'lightweight');
  assert.match(fallback.warnings[0], /MinerU/);
  await assert.rejects(extractText(pdf, 'test.pdf', { mineru: { enabled: true, baseUrl: 'invalid', fallback: false } }));
  assert.equal((await extractText(Buffer.from('hello'), 'test.txt')).text, 'hello');
});

test('MinerU 导入后保留页块元数据，文档及分块引用区间与原提取文本一致', async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lkba-mineru-'));
  const previousFile = config.kbFile;
  const previousMineru = config.extract.mineru;
  t.after(async () => {
    config.kbFile = previousFile;
    config.extract.mineru = previousMineru;
    await fs.rm(temp, { recursive: true, force: true });
  });
  let base;
  base = await service(t, async (req, res) => {
    for await (const _ of req) {}
    if (req.url.endsWith('/result')) { res.end(zipJson(document)); return; }
    res.end(JSON.stringify({ task_id: 'job', files: [{ file_id: 'file', status: 'completed', result_url: `${base}/result` }] }));
  });
  config.kbFile = path.join(temp, 'kb.json');
  config.extract.mineru = { enabled: true, baseUrl: base, fallback: false, pollMs: 10 };
  await initKb({ mysqlReady: false });
  const imported = await importDocument({ userId: 'mineru-user', name: 'scan.pdf', buffer: Buffer.from('%PDF-1.4\nfixture') });
  const saved = await getDocument(imported.doc.id, 'mineru-user');
  assert.equal(saved.extraction.parser, 'mineru');
  assert.equal(saved.extraction.pages, 2);
  assert.deepEqual(saved.extraction.sourceMap, normalizeStructuredContent(document).sourceMap);
  assert.equal(saved.text, normalizeStructuredContent(document).text);
  for (const chunk of saved.chunks) assert.equal(saved.text.slice(chunk.start, chunk.end), chunk.text);
  assert.equal(await getDocument(imported.doc.id, 'other-user'), null);
  const persisted = JSON.parse(await fs.readFile(config.kbFile, 'utf8'));
  assert.deepEqual(persisted.docs[0].extraction, saved.extraction);
});
