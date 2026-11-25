/**
 * 统一文本提取入口。
 *
 * 支持：pdf / docx / md / txt / csv / tsv / json / html
 * 全部零第三方依赖，便于在没有数据库的托管环境同样可用。
 */

import { extractPdf } from './pdf.mjs';
import { extractDocx } from './docx.mjs';
import { extractMineru } from './mineru.mjs';
import { config } from '../config.mjs';
import { extractXlsx } from './xlsx.mjs';
import { extractNotebook } from './ipynb.mjs';
import { readOfficeZip, xmlText } from './office-zip.mjs';

export const SUPPORTED = ['pdf', 'docx', 'xlsx', 'pptx', 'ipynb', 'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'html', 'htm'];

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

/** UTF-8 优先，失败则按 GB18030（中文 Windows 常见）解码 */
function decodeText(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {Buffer} buffer
 * @param {string} filename
 * @returns {Promise<{text:string, kind:string, pages:number, parser?:string, sourceMap?:Array}>}
 */
export async function extractText(buffer, filename, options = {}) {
  if (!buffer || !buffer.length) throw new Error('文件为空');
  options.signal?.throwIfAborted();

  const ext = extOf(filename);
  const head = buffer.subarray(0, 5).toString('latin1');
  if (ext === 'xlsx') return extractXlsx(buffer, options);
  if (ext === 'ipynb') return extractNotebook(buffer);
  if (ext === 'pptx') {
    const members = readOfficeZip(buffer, options);
    const slides = [...members.keys()].filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
    if (!slides.length) throw new Error('pptx_slides_missing');
    return { text: slides.map((name, i) => `## 幻灯片 ${i + 1}\n` + [...members.get(name).toString('utf8').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => xmlText(m[1])).join('\n')).join('\n\n'), kind: 'pptx', pages: slides.length, parser: 'bounded-ooxml' };
  }

  if (ext === 'pdf' || head === '%PDF-') {
    const settings = options.mineru || config.extract?.mineru || {};
    if (settings.enabled) {
      try {
        return await extractMineru(buffer, filename, { ...options, settings, maxTextChars: config.upload.maxTextChars });
      } catch (err) {
        if (options.signal?.aborted || settings.fallback === false) throw err;
        const light = extractPdf(buffer);
        return { ...light, parser: 'lightweight', warnings: [`MinerU 失败，已使用轻量解析：${String(err.message || err).slice(0, 160)}`] };
      }
    }
    return { ...extractPdf(buffer), parser: 'lightweight' };
  }
  if (ext === 'docx') return extractDocx(buffer);
  if (ext === 'doc') throw new Error('不支持旧版 .doc，请另存为 .docx 或 PDF');

  const raw = decodeText(buffer);
  if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype|html)/i.test(raw.slice(0, 200))) {
    return { text: htmlToText(raw), pages: 0, kind: 'html' };
  }
  if (ext === 'json') {
    try {
      const obj = JSON.parse(raw);
      const flat = [];
      const walk = (v, depth = 0) => {
        if (depth > 6) return;
        if (typeof v === 'string') flat.push(v);
        else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
        else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
      };
      walk(obj);
      return { text: flat.join('\n'), pages: 0, kind: 'json' };
    } catch {
      return { text: raw, pages: 0, kind: 'text' };
    }
  }

  return {
    text: raw.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    pages: 0,
    kind: ext === 'md' || ext === 'markdown' ? 'markdown' : 'text',
  };
}
