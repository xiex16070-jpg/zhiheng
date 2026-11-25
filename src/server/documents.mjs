import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafe, writeArtifact, readFile } from './workspace.mjs';
import { launchAgentChromium } from './browser-runtime.mjs';
import { renderXlsx, renderPptx } from './docgen/office.mjs';

const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const markdownLabel = value => String(value || '').replace(/[\r\n<>]/g,' ').replace(/[\\`*_[\]{}()!#]/g,'\\$&');
const safeLink = value => { try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
let active = 0;
export const DOCUMENT_TOOL_SCHEMA = { type: 'function', function: { name: 'create_document',
  description: '真实生成 PDF、Word DOCX、Excel XLSX 或 PowerPoint PPTX 并保存到工作区。PDF/DOCX 支持中文、表格、引用与本地 PNG/JPEG；PPTX 按 Markdown 标题分节并分页；XLSX 使用 Markdown 表格或 rows 二维数组（仅静态值，不执行公式）。提供 markdown/source_path/rows 之一。图片仅工作区相对路径，不抓取外部图片。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string', minLength: 1, maxLength: 240, description: '输出相对路径：.pdf/.docx/.xlsx/.pptx' },
    title: { type: 'string', maxLength: 160 }, markdown: { type: 'string', minLength: 1, maxLength: 60000 },
    source_path: { type: 'string', maxLength: 240, description: '已有 .md/.markdown 工作区文件，适合长报告' },
    rows: { type: 'array', minItems: 1, maxItems: 2001, description: '仅 XLSX：二维静态值，首行为表头；拒绝公式对象。', items: { type: 'array', minItems: 1, maxItems: 32, items: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] } } },
    overwrite: { type: 'boolean', description: '默认 false，同名文件不覆盖' },
  }, required: ['path'], oneOf: [{ required: ['markdown'], not: { anyOf: [{ required: ['source_path'] }, { required: ['rows'] }] } }, { required: ['source_path'], not: { anyOf: [{ required: ['markdown'] }, { required: ['rows'] }] } }, { required: ['rows'], not: { anyOf: [{ required: ['markdown'] }, { required: ['source_path'] }] } }] } } };

export function imageDimensions(data) {
  if (data.length > 24 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data[0] === 255 && data[1] === 216) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i++] !== 255) break;
      const marker = data[i++];
      if (marker === 216 || marker === 217) continue;
      const length = data.readUInt16BE(i);
      if (length < 2 || i + length > data.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) return { type: 'jpg', width: data.readUInt16BE(i + 5), height: data.readUInt16BE(i + 3) };
      i += length;
    }
  }
  throw new Error('图片须为有效 PNG/JPEG，不能使用 SVG、远程地址或伪造扩展名。');
}

async function imageAsset(userId, name, signal) {
  const target = resolveSafe(userId, name);
  if (target.error || !/\.(png|jpe?g)$/i.test(name)) throw new Error('图片必须是当前工作区内的 PNG/JPEG 相对路径。');
  const handle = await fs.open(target.abs, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024 || resolveSafe(userId, name).error) throw new Error('图片不可读取或超过 5 MiB。');
    signal?.throwIfAborted();
    const data = await handle.readFile();
    const size = imageDimensions(data);
    if (!size.width || !size.height || size.width > 10000 || size.height > 10000 || size.width * size.height > 25e6) throw new Error('图片尺寸超出限制。');
    const scale = Math.min(1, 560 / size.width, 700 / size.height);
    return { data, ...size, displayWidth: Math.round(size.width * scale), displayHeight: Math.round(size.height * scale) };
  } finally { await handle.close(); }
}

function walkDocumentTokens(tokens, visit) {
  function walk(list, depth = 0) {
    if (depth > 12) throw new Error('文档嵌套层级过深。');
    for (const token of list || []) {
      visit(token);
      if (token.tokens) walk(token.tokens, depth + 1);
      if (token.items) for (const item of token.items) walk(item.tokens, depth + 1);
      if (token.type === 'table') {
        if (token.header.length > 8 || token.rows.length > 200) throw new Error('表格最多 8 列、200 行。');
        for (const cell of [...token.header, ...token.rows.flat()]) walk(cell.tokens, depth + 1);
      }
    }
  }
  walk(tokens);
}
function imagesFromTokens(tokens) {
  const images = new Set();
  walkDocumentTokens(tokens,token=>{ if(token.type==='image')images.add(token.href); });
  if(images.size>8)throw new Error('单个文档最多包含 8 张图片。');
  return [...images];
}
/** Approval and rendering share one parser, including reference images, tables and nested lists. */
export async function documentImagePaths(markdown) {
  const { Lexer } = await import('marked');
  return imagesFromTokens(Lexer.lex(markdown,{gfm:true}));
}
async function prepare(userId, markdown, title, signal) {
  const { Lexer } = await import('marked');
  const tokens = Lexer.lex(markdown, { gfm: true });
  const assets = new Map();
  for(const image of imagesFromTokens(tokens))assets.set(image,await imageAsset(userId,image,signal));
  return { tokens, assets, title };
}

function inlineHtml(tokens, assets) {
  return (tokens || []).map(t => {
    if (t.type === 'image') { const a = assets.get(t.href); return `<img alt="${escape(t.text)}" src="data:image/${a.type === 'jpg' ? 'jpeg' : 'png'};base64,${a.data.toString('base64')}" style="max-height:180mm">`; }
    const text = t.tokens ? inlineHtml(t.tokens, assets) : escape(t.text ?? t.raw);
    if (t.type === 'strong') return `<strong>${text}</strong>`;
    if (t.type === 'em') return `<em>${text}</em>`;
    if (t.type === 'codespan') return `<code>${text}</code>`;
    if (t.type === 'br') return '<br>';
    if (t.type === 'link' && safeLink(t.href)) return `<a href="${escape(safeLink(t.href))}">${text}</a>`;
    return text;
  }).join('');
}
function blocksHtml(tokens, assets) {
  return tokens.map(t => {
    const text = inlineHtml(t.tokens || [{ text: t.text || '' }], assets);
    if (t.type === 'space') return '';
    if (t.type === 'heading') return `<h${t.depth}>${text}</h${t.depth}>`;
    if (t.type === 'code') return `<pre><code>${escape(t.text)}</code></pre>`;
    if (t.type === 'blockquote') return `<blockquote>${blocksHtml(t.tokens, assets)}</blockquote>`;
    if (t.type === 'list') return `<${t.ordered ? 'ol' : 'ul'}>${t.items.map(i => `<li>${blocksHtml(i.tokens, assets)}</li>`).join('')}</${t.ordered ? 'ol' : 'ul'}>`;
    if (t.type === 'table') return `<table><thead><tr>${t.header.map(c => `<th>${inlineHtml(c.tokens, assets)}</th>`).join('')}</tr></thead><tbody>${t.rows.map(row => `<tr>${row.map(c => `<td>${inlineHtml(c.tokens, assets)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (t.type === 'hr') return '<hr>';
    return `<p>${text}</p>`;
  }).join('\n');
}

async function renderPdf(document, signal) {
  const browser = await launchAgentChromium();
  const abort = () => browser.close().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', r => r.abort());
    const page = await context.newPage();
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(document.title)}</title><style>
      @page{size:A4;margin:20mm 19mm 22mm}*{box-sizing:border-box}body{font:11pt/1.8 'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#263e3b;overflow-wrap:anywhere}h1{font-size:25pt;line-height:1.35;margin:0 0 22pt;border-bottom:2pt solid #315b55;padding-bottom:12pt}h2,h3,h4{break-after:avoid;line-height:1.4;color:#315b55}h2{font-size:17pt;margin-top:24pt}p{orphans:3;widows:3}blockquote{border-left:3pt solid #b39352;margin:14pt 0;padding:2pt 14pt;background:#f5f4ef}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10pt}thead{display:table-header-group}td,th{border:1px solid #d8ded8;padding:7pt;vertical-align:top}th{background:#edf3f0;text-align:left}tr,img{break-inside:avoid}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f4f5f2;border:1px solid #ddd;padding:12pt;font-size:9pt}code{font-family:Consolas,'Noto Sans Mono',monospace}a{color:#315b55;text-decoration:none}hr{border:0;border-top:1px solid #ccc}</style><body>${document.title ? `<h1>${escape(document.title)}</h1>` : ''}${blocksHtml(document.tokens, document.assets)}</body></html>`;
    await page.setContent(html, { waitUntil: 'load', timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    const buffer = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true,
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: '<div style="font-size:9px;color:#6b7771;text-align:center;width:100%"><span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
    signal?.throwIfAborted();
    return buffer;
  } finally { signal?.removeEventListener('abort', abort); await browser.close(); }
}

async function renderDocx(document) {
  const d = await import('docx');
  function runs(tokens, format = {}) {
    return (tokens || []).flatMap(t => {
      if (t.type === 'image') { const a = document.assets.get(t.href); return [new d.ImageRun({ type: a.type, data: a.data, transformation: { width: a.displayWidth, height: a.displayHeight }, altText: { title: t.text || '', description: t.text || '', name: t.text || '图片' } })]; }
      if (t.type === 'br') return [new d.TextRun({ break: 1 })];
      if (t.type === 'link' && safeLink(t.href)) return [new d.ExternalHyperlink({ link: safeLink(t.href), children: runs(t.tokens, { ...format, color: '315B55', underline: {} }) })];
      const next = { ...format, ...(t.type === 'strong' ? { bold: true } : {}), ...(t.type === 'em' ? { italics: true } : {}), ...(t.type === 'codespan' ? { font: 'Consolas' } : {}) };
      return t.tokens ? runs(t.tokens, next) : [new d.TextRun({ text: t.text ?? t.raw ?? '', ...next })];
    });
  }
  function blocks(tokens, listLevel = 0) {
    return tokens.flatMap(t => {
      if (t.type === 'space') return [];
      if (t.type === 'table') {
        const width = Math.floor(9638 / t.header.length);
        return [new d.Table({ width: { size: 9638, type: d.WidthType.DXA }, columnWidths: t.header.map(() => width), rows: [t.header, ...t.rows].map((row, index) => new d.TableRow({ tableHeader: index === 0, cantSplit: true, children: row.map(c => new d.TableCell({ width: { size: width, type: d.WidthType.DXA }, shading: index === 0 ? { fill: 'EDF3F0' } : undefined, margins: { top: 100, bottom: 100, left: 120, right: 120 }, children: [new d.Paragraph({ children: runs(c.tokens, { bold: index === 0 }) })] })) })) })];
      }
      if (t.type === 'list') return t.items.flatMap((item, index) => item.tokens.flatMap((p, pi) => p.type === 'list' ? blocks([p], listLevel + 1) : p.type === 'space' ? [] : [new d.Paragraph({ children: runs(p.tokens || [{ text: p.text }]), ...(pi === 0 ? t.ordered ? { numbering: { reference: 'ordered', level: Math.min(5, listLevel), instance: listInstances.get(t) } } : { bullet: { level: Math.min(5, listLevel) } } : {}), spacing: { after: 100 } })]));
      if (t.type === 'blockquote') return t.tokens.filter(p => p.type !== 'space').flatMap(p => ['paragraph','text'].includes(p.type)
        ? [new d.Paragraph({ children: runs(p.tokens || [{ text: p.text }], { italics: true, color: '586963' }), indent: { left: 300 }, border: { left: { color: 'B39352', size: 14, style: d.BorderStyle.SINGLE, space: 12 } }, spacing: { after: 180 } })]
        : blocks([p], listLevel));
      if (t.type === 'hr') return [new d.Paragraph({ border: { bottom: { color: 'CCCCCC', size: 4, style: d.BorderStyle.SINGLE } } })];
      return [new d.Paragraph({ children: t.type === 'code' ? String(t.text).split('\n').flatMap((line, i) => [new d.TextRun({ text: line, font: 'Consolas', size: 19, ...(i ? { break: 1 } : {}) })]) : runs(t.tokens || [{ text: t.text || '' }]),
        ...(t.type === 'heading' ? { heading: d.HeadingLevel['HEADING_' + t.depth], keepNext: true } : {}), spacing: { after: 180, line: 330 } })];
    });
  }
  const listInstances = new Map();
  let instance = 0;
  const walk = tokens => { for (const t of tokens) { if (t.type === 'list') { listInstances.set(t, instance++); t.items.forEach(i => walk(i.tokens)); } if (t.type === 'blockquote') walk(t.tokens); } };
  walk(document.tokens);
  const doc = new d.Document({ title: document.title, creator: '知衡',
    styles: { default: { document: { run: { font: { name: 'Microsoft YaHei', eastAsia: 'Microsoft YaHei' }, size: 22, color: '263E3B' } } },
      paragraphStyles: [1,2,3,4,5,6].map(n => ({ id: 'Heading' + n, name: 'Heading ' + n, basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { bold: true, color: '315B55', size: n === 1 ? 38 : n === 2 ? 32 : 26 }, paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: n - 1 } })) },
    numbering: { config: [{ reference: 'ordered', levels: Array.from({ length: 6 }, (_, level) => ({ level, format: d.LevelFormat.DECIMAL, text: '%' + (level + 1) + '.', alignment: d.AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 240 } } } })) }] },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1247, left: 1134, right: 1134 } } },
      footers: { default: new d.Footer({ children: [new d.Paragraph({ alignment: d.AlignmentType.CENTER, children: [new d.TextRun({ children: [d.PageNumber.CURRENT, ' / ', d.PageNumber.TOTAL_PAGES], size: 18, color: '6B7771' })] })] }) },
      children: [...(document.title ? [new d.Paragraph({ text: document.title, heading: d.HeadingLevel.TITLE, spacing: { after: 360 } })] : []), ...blocks(document.tokens)] }] });
  return d.Packer.toBuffer(doc);
}

export async function createDocument(userId, args, { signal, evidence = new Map(), aliases = new Map() } = {}) {
  signal?.throwIfAborted();
  if (active >= 2) return { ok: false, code: 'busy', message: '文档生成正在忙，请稍后重试。' };
  const format = path.extname(String(args.path || '')).toLowerCase();
  if (!['.pdf', '.docx', '.xlsx', '.pptx'].includes(format)) return { ok: false, code: 'format', message: '请选择 .pdf/.docx/.xlsx/.pptx 输出路径。' };
  const initialOutput = resolveSafe(userId, args.path);
  if (initialOutput.error) return { ok: false, code: 'path', message: '输出路径必须位于当前工作区。' };
  active++;
  const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(45000)]);
  const save = async buffer => {
    if (resolveSafe(userId, args.path).abs !== initialOutput.abs) return { ok: false, code: 'workspace_changed', message: '工作区已变更，未写入产物。' };
    return writeArtifact(userId, args.path, buffer, { overwrite: args.overwrite === true, signal: combined });
  };
  try {
    if (args.rows !== undefined) {
      if (format !== '.xlsx' || args.markdown !== undefined || args.source_path !== undefined) throw new Error('rows 仅用于 XLSX，且不能同时提供 Markdown。');
      const refs = new Map();
      const rows = Array.isArray(args.rows) ? args.rows.map(row => Array.isArray(row) ? row.map(value => typeof value === 'string' ? value.replace(/\[\[([A-Za-z0-9_-]{1,80})\]\]/g, (_, ref) => {
        const source = evidence.get(aliases.get(ref) || ref);
        if (!source) throw new Error('表格包含本轮尚未取得的引用编号，请先检索或读取来源。');
        if (!refs.has(ref)) refs.set(ref, source);
        return '[' + ([...refs.keys()].indexOf(ref) + 1) + ']';
      }) : value) : row) : args.rows;
      const references = [...refs.values()].map((s, i) => [i + 1, String(s.title || s.docName || s.ref), safeLink(s.sourceUrl || s.url), s.authority?.evidenceLevel === 'abstract' ? '仅摘要' : '已取得的证据']);
      const buffer = await renderXlsx({ rows, references, title: String(args.title || '').slice(0, 160), signal: combined });
      return { ...await save(buffer), format: 'xlsx' };
    }
    let markdown = args.markdown;
    if (args.source_path) {
      if (!/\.(md|markdown)$/i.test(args.source_path) || markdown !== undefined) throw new Error('请提供 Markdown 正文或一个 .md 源文件，不能同时提供。');
      const result = await readFile(userId, args.source_path, 240000);
      if (!result.ok || result.truncated) throw new Error('Markdown 源文件不可读取或过大。');
      markdown = result.content;
    }
    if (typeof markdown !== 'string' || !markdown.trim() || markdown.length > 60000) throw new Error('文档正文需要 1–60000 字符。');
    const refs = new Map();
    markdown = markdown.replace(/\[\[([A-Za-z0-9_-]{1,80})\]\]/g, (_, ref) => {
      const source = evidence.get(aliases.get(ref) || ref);
      if (!source) throw new Error('文档包含本轮尚未取得的引用编号，请先检索或读取来源。');
      if (!refs.has(ref)) refs.set(ref, source);
      return '[' + ([...refs.keys()].indexOf(ref) + 1) + ']';
    });
    if (refs.size) {
      const sources = [...refs.values()];
      markdown += '\n\n## 参考来源\n\n' + (format === '.xlsx'
        ? '| 编号 | 来源 | 链接 | 证据范围 |\n|---|---|---|---|\n' + sources.map((s, i) => `| ${i + 1} | ${String(s.title || s.docName || s.ref).replace(/[\r\n<>|]/g, ' ')} | ${safeLink(s.sourceUrl || s.url).replace(/\|/g, '%7C')} | ${s.authority?.evidenceLevel === 'abstract' ? '仅摘要' : '已取得的证据'} |`).join('\n')
        : sources.map((s, i) => `${i + 1}. ${markdownLabel(s.title || s.docName || s.ref)}${safeLink(s.sourceUrl || s.url) ? ' · ' + markdownLabel(safeLink(s.sourceUrl || s.url)) : ''}${s.authority?.evidenceLevel === 'abstract' ? '（仅摘要）' : ''}`).join('\n'));
    }
    if (format === '.xlsx') {
      const buffer = await renderXlsx({ markdown, title: String(args.title || '').slice(0, 160), signal: combined });
      return { ...await save(buffer), format: 'xlsx' };
    }
    const document = await prepare(userId, markdown, String(args.title || '').slice(0, 160), combined);
    combined.throwIfAborted();
    const buffer = format === '.pdf' ? await renderPdf(document, combined) : format === '.pptx' ? await renderPptx(document, combined) : await renderDocx(document);
    combined.throwIfAborted();
    return { ...await save(buffer), format: format.slice(1) };
  } catch (error) {
    signal?.throwIfAborted();
    return { ok: false, code: combined.aborted ? 'timeout' : 'render_failed', message: /Executable doesn't exist/.test(error.message)
      ? 'PDF 渲染浏览器未安装，请运行 npm run setup:browser 后重试。' : combined.aborted ? '文档生成超时，未写入文件。' : String(error.message).slice(0, 200) };
  } finally { active--; }
}
