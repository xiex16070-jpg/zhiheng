/**
 * DOCX 文本提取（纯 JS，零依赖）。
 *
 * .docx 本质是 ZIP，正文在 word/document.xml。这里实现最小 ZIP 读取
 * （支持 stored / deflate 两种压缩方式），再把 WordprocessingML 转成纯文本。
 */

import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;

/** 读取 zip 内指定文件，找不到返回 null */
function readZipEntry(buf, wanted) {
  // 从尾部向前找 EOCD（最多回退 64KB，注释长度上限）
  let eocd = -1;
  const from = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) return null;

  let p = cdOffset;
  for (let n = 0; n < total && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== SIG_CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;

    if (name !== wanted) continue;
    if (localOffset + 30 > buf.length) return null;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) return data;
    if (method === 8) {
      try {
        // 同样限制解压后大小，防止 zip 炸弹
        return zlib.inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
    }
    return null;
  }
  return null;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** WordprocessingML → 纯文本，保留段落与表格结构 */
export function docxXmlToText(xml) {
  let s = xml;
  // 域代码（目录、页码等）不参与正文
  s = s.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, '');
  // 删除修订痕迹里的删除内容
  s = s.replace(/<w:delText[\s\S]*?<\/w:delText>/g, '');
  // 制表、换行、分页
  s = s.replace(/<w:tab\b[^>]*\/>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/>/g, '\n');
  s = s.replace(/<w:cr\b[^>]*\/>/g, '\n');
  // 段落 / 表格结构
  s = s.replace(/<\/w:p>/g, '\n');
  s = s.replace(/<\/w:tr>/g, '\n');
  s = s.replace(/<\/w:tc>/g, '\t');
  // 只保留文本节点
  s = s.replace(/<w:t\b[^>]*>/g, '');
  s = s.replace(/<\/w:t>/g, '');
  // 其余标签一律剔除
  s = s.replace(/<[^>]+>/g, '');

  s = decodeXmlEntities(s);
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\t{2,}/g, '\t')
    .trim();
}

export function extractDocx(buffer) {
  const doc = readZipEntry(buffer, 'word/document.xml');
  if (!doc) throw new Error('docx 结构异常：未找到 word/document.xml');
  return { text: docxXmlToText(doc.toString('utf8')), pages: 0, kind: 'docx' };
}

export const __test = { readZipEntry };
