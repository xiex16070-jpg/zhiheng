import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdf } from '../src/server/extract/pdf.mjs';

/**
 * 构造一个最小 PDF：Type0 字体 + 预定义 CMap UniGB-UTF16-H。
 *
 * 这类字体没有 ToUnicode，字符码本身就是 UTF-16BE 的 Unicode 码点。
 * OCR 生成的文字层（PyMuPDF 等）大量使用这种编码，之前解析器直接丢弃，
 * 表现为「PDF 有文字层但提取出 0 字符」。
 */
function buildPdf({ encoding, hex }) {
  const content = `BT /F1 12 Tf 72 700 Td <${hex}> Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Type /Font /Subtype /Type0 /BaseFont /Heiti /Encoding /${encoding} /DescendantFonts [6 0 R] >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Heiti >>',
  ];

  let out = '%PDF-1.4\n';
  objs.forEach((body, i) => {
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  out += 'trailer\n<< /Root 1 0 R /Size 7 >>\n%%EOF\n';
  return Buffer.from(out, 'latin1');
}

test('UniGB-UTF16-H 字体：没有 ToUnicode 也能还原中文', () => {
  // 9a6c=马 514b=克 601d=思 4e3b=主 4e49=义
  const r = extractPdf(buildPdf({ encoding: 'UniGB-UTF16-H', hex: '9a6c514b601d4e3b4e49' }));
  assert.equal(r.kind, 'pdf');
  assert.equal(r.pages, 1);
  assert.equal(r.textPages, 1);
  assert.equal(r.text.trim(), '马克思主义');
  assert.deepEqual(r.sourceMap.map(p=>({page:p.page,text:r.text.slice(p.start,p.end)})),[{page:1,text:'马克思主义'}]);
});

test('UniCNS-UTF16-H / UniJIS-UTF16-H 同样适用', () => {
  for (const encoding of ['UniCNS-UTF16-H', 'UniJIS-UTF16-H', 'UniKS-UCS2-H']) {
    const r = extractPdf(buildPdf({ encoding, hex: '9a6c514b' }));
    assert.equal(r.text.trim(), '马克', `${encoding} 解码失败`);
  }
});

test('Identity-H 且无 ToUnicode：不臆造文字（CID 不是 Unicode）', () => {
  // Identity-H 的 CID 是字形索引，直接当 Unicode 会输出乱码，必须留空
  const r = extractPdf(buildPdf({ encoding: 'Identity-H', hex: '9a6c514b' }));
  assert.equal(r.text.trim(), '');
  assert.equal(r.textPages, 0);
});
