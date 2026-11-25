import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { workspaceById } from './workspace-selection.mjs';
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { extractText } from './extract/index.mjs';

const TEXT_LIMIT = 200000, DOCUMENT_LIMIT = 25 * 1024 * 1024;
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml' };
const TEXT_TYPES = new Set(['.txt','.md','.markdown','.mdown','.csv','.tsv','.json','.jsonl','.log','.yaml','.yml','.html','.htm','.xml','.svg','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.css','.scss','.less','.zh','.han','.sql','.rs','.go','.java','.c','.cpp','.h','.sh','.ps1','.toml','.ini','.vue','.svelte','.ipynb']);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const failure = (code, status = 400) => Object.assign(new Error(code), { code, status });
const urlFor = (pathname, rel, workspaceId, more = {}) => pathname + '?' + new URLSearchParams({ path: rel, workspace: workspaceId, ...more });

// A preview can read another registered project, but never changes the selected
// project or creates a task-local write scope. Every request revalidates ownership.
export function resolvePreviewPath(userId, workspaceId, relPath) {
  if (!ID_RE.test(String(userId || ''))) throw failure('invalid_user', 401);
  const workspace = workspaceById(userId, workspaceId);
  if (!workspace) throw failure('not_found', 404);
  if (!workspace.available) throw failure('workspace_unavailable', 409);
  const root = path.resolve(workspace.root || path.join(config.dataDir, 'workspace', userId));
  const rel = String(relPath || '').replace(/\\/g, '/').trim();
  if (!rel || rel.length > 240 || /[\x00-\x1f]/.test(rel) || /^(?:[A-Za-z]:|\/|~)/.test(rel)) throw failure('invalid_path');
  const segments = rel.split('/').filter(Boolean);
  if (segments.some(s => s === '.' || s === '..' || s.length > 120 || /[:<>"|?*]|[. ]$/.test(s) || /^\.trash$/i.test(s) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s))) throw failure('invalid_path');
  const target = path.resolve(root, ...segments);
  if (!target.startsWith(root + path.sep)) throw failure('invalid_path');
  // Do not follow even an intermediate junction; .trash is never addressable.
  let current = path.parse(root).root;
  for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat; try { stat = lstatSync(current); } catch { throw failure('not_found', 404); }
    if (stat.isSymbolicLink() || !(stat.isDirectory() || stat.isFile()) || (stat.isFile() && stat.nlink !== 1)) throw failure('unsafe_link', 403);
  }
  return { root, abs: target, rel: segments.join('/'), workspace };
}

function localReference(value, currentPath) {
  let ref; try { ref = decodeURIComponent(String(value || '').trim().split(/[?#]/, 1)[0]); } catch { return null; }
  if (!ref || /[\x00-\x1f]/.test(ref) || /^(?:[a-z][\w+.-]*:|\/|\\|~)/i.test(ref)) return null;
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(currentPath), ref.replaceAll('\\', '/')));
  return rel === '..' || rel.startsWith('../') || rel.split('/').some(s => /^\.trash$/i.test(s)) ? null : rel;
}

function cleanHtml(html, rel, workspaceId) {
  return sanitizeHtml(html, {
    allowedTags: ['p','div','section','article','header','footer','main','aside','span','h1','h2','h3','h4','h5','h6','blockquote','pre','code','em','strong','del','s','ul','ol','li','table','thead','tbody','tfoot','tr','th','td','br','hr','a','img','details','summary','sup','sub','kbd','mark'],
    allowedAttributes: { a: ['href','title','target','rel'], img: ['src','alt','title','loading','decoding'], code: ['class'], h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'], th: ['align'], td: ['align'], ol: ['start'], details: ['open'] },
    allowedClasses: { code: [/^language-[\w-]{1,30}$/] },
    allowedSchemes: ['http','https'], allowProtocolRelative: false,
    transformTags: {
      '*': (tag, attrs) => { if (attrs.id && !attrs.id.startsWith('artifact-')) delete attrs.id; return { tagName: tag, attribs: attrs }; },
      a: (_tag, attrs) => {
        let href = String(attrs.href || '').trim();
        if (href.startsWith('#')) { try { href = '#artifact-' + decodeURIComponent(href.slice(1)).replace(/^artifact-/, ''); } catch { href = ''; } }
        else if (/^https?:\/\//i.test(href)) { try { const parsed = new URL(href); if (parsed.username || parsed.password) href = ''; } catch { href = ''; } }
        else { const linked = localReference(href, rel); href = linked ? urlFor('/preview.html', linked, workspaceId) : ''; }
        return { tagName: 'a', attribs: { href, title: attrs.title || '', ...(href && !href.startsWith('#') ? { target: '_blank', rel: 'noopener noreferrer' } : {}) } };
      },
      img: (_tag, attrs) => {
        const linked = localReference(attrs.src, rel);
        if (!linked || !Object.hasOwn(IMAGE_TYPES, path.extname(linked).toLowerCase())) return { tagName: 'span', attribs: {}, text: attrs.alt ? `[图片：${attrs.alt}]` : '[外部图片未加载]' };
        return { tagName: 'img', attribs: { src: urlFor('/api/workspace/asset', linked, workspaceId), alt: attrs.alt || '', title: attrs.title || '', loading: 'lazy', decoding: 'async' } };
      },
    },
  });
}

export function renderArtifactMarkdown(source, rel, workspaceId) {
  const headings = [], used = new Map();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({ renderer: { heading({ tokens, depth }) {
    const body = this.parser.parseInline(tokens);
    const text = sanitizeHtml(body, { allowedTags: [], allowedAttributes: {} });
    const stem = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section';
    const count = (used.get(stem) || 0) + 1; used.set(stem, count);
    const id = 'artifact-' + stem + (count > 1 ? '-' + count : '');
    headings.push({ id, title: text, depth });
    return `<h${depth} id="${escape(id)}">${body}</h${depth}>`;
  } } });
  return { html: cleanHtml(marked.parse(source), rel, workspaceId), headings: headings.slice(0, 80) };
}

function renderDelimited(source, separator) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length && rows.length < 201; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (char === separator || char === '\n')) { row.push(cell); cell = ''; if (char === '\n') { rows.push(row); row = []; } if (row.length > 50) break; }
    else if (char !== '\r') cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return '<div class="artifact-table-scroll"><table>' + rows.slice(0, 200).map((cells, i) => '<tr>' + cells.slice(0, 50).map(v => `<${i ? 'td' : 'th'}>${escape(v)}</${i ? 'td' : 'th'}>`).join('') + '</tr>').join('') + '</table></div>';
}

export async function artifactDescriptor(userId, workspaceId, relPath) {
  const target = resolvePreviewPath(userId, workspaceId, relPath);
  const handle = await fs.open(target.abs, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw failure('not_found', 404);
    const ext = path.extname(target.rel).toLowerCase();
    const descriptor = { path: target.rel, name: path.basename(target.rel), workspaceId, workspaceName: target.workspace.name,
      bytes: stat.size, modifiedAt: stat.mtime.toISOString(), kind: 'unsupported', format: ext.slice(1).toUpperCase() || 'FILE',
      downloadUrl: urlFor('/api/workspace/asset', target.rel, workspaceId, { download: '1' }),
      windowUrl: urlFor('/preview.html', target.rel, workspaceId), headings: [] };
    if (IMAGE_TYPES[ext] || ext === '.pdf') {
      descriptor.kind = ext === '.pdf' ? 'pdf' : 'image';
      descriptor.assetUrl = urlFor('/api/workspace/asset', target.rel, workspaceId);
      return descriptor;
    }
    const office = ['.docx','.xlsx','.pptx','.ipynb'].includes(ext);
    if (!TEXT_TYPES.has(ext) && !office && ext) return descriptor;
    if (office && stat.size > DOCUMENT_LIMIT) throw failure('preview_too_large', 413);
    const limit = office ? stat.size : Math.min(stat.size, TEXT_LIMIT);
    const buffer = Buffer.alloc(limit); await handle.read(buffer, 0, limit, 0);
    descriptor.previewSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    descriptor.truncated = stat.size > limit;
    if (office) {
      const parsed = await extractText(buffer, target.rel, { mineru: { enabled: false } });
      descriptor.kind = 'extracted'; descriptor.source = parsed.text.slice(0, TEXT_LIMIT); descriptor.truncated ||= parsed.text.length > TEXT_LIMIT;
      descriptor.html = renderArtifactMarkdown(descriptor.source, target.rel, workspaceId).html;
      descriptor.notice = '文本预览；完整排版、公式与交互请下载后在原应用中查看。';
    } else {
      const source = buffer.toString('utf8');
      if (source.includes('\0')) return { ...descriptor, kind: 'unsupported', notice: '此文件包含二进制数据，请下载后打开。' };
      descriptor.source = source;
      if (['.md','.markdown','.mdown'].includes(ext)) { descriptor.kind = 'markdown'; Object.assign(descriptor, renderArtifactMarkdown(source, target.rel, workspaceId)); }
      else if (['.html','.htm'].includes(ext)) { descriptor.kind = 'html'; descriptor.html = cleanHtml(source, target.rel, workspaceId); descriptor.notice = '静态预览：脚本、表单和外部资源未运行。'; }
      else if (['.csv','.tsv'].includes(ext)) { descriptor.kind = 'table'; descriptor.html = renderDelimited(source, ext === '.csv' ? ',' : '\t'); descriptor.notice = '表格预览最多显示 200 行、50 列。'; }
      else { descriptor.kind = 'code'; }
    }
    return descriptor;
  } finally { await handle.close(); }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value));
}

export async function handleArtifactPreview(req, res, url, userId, { allowLocalProjects = false } = {}) {
  if (!['/api/workspace/preview','/api/workspace/asset'].includes(url.pathname)) return false;
  if (req.method !== 'GET') { json(res, 405, { error: 'method_not_allowed' }); return true; }
  const rel = url.searchParams.get('path') || '', workspaceId = url.searchParams.get('workspace') || 'default';
  if (workspaceId !== 'default' && !allowLocalProjects) { json(res, 403, { error: 'local_workspace_required' }); return true; }
  try {
    if (url.pathname.endsWith('/preview')) { json(res, 200, await artifactDescriptor(userId, workspaceId, rel)); return true; }
    const target = resolvePreviewPath(userId, workspaceId, rel);
    const file = await fs.open(target.abs, 'r');
    let stat; try { stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1) throw failure('not_found', 404); }
    catch (error) { await file.close(); throw error; }
    const ext = path.extname(target.rel).toLowerCase();
    const inline = url.searchParams.get('download') !== '1' && (IMAGE_TYPES[ext] || ext === '.pdf');
    const mime = inline ? IMAGE_TYPES[ext] || 'application/pdf' : 'application/octet-stream';
    const headers = { 'content-type': mime, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(target.rel))}`,
      'content-security-policy': "default-src 'none'; script-src 'none'; sandbox", 'referrer-policy': 'no-referrer', 'accept-ranges': 'bytes' };
    let start = 0, end = stat.size - 1, status = 200;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) { await file.close(); res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return true; }
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) { await file.close(); res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return true; }
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['content-length'] = String(Math.max(0, end - start + 1)); res.writeHead(status, headers);
    if (!stat.size) { await file.close(); res.end(); return true; }
    const stream = file.createReadStream({ start, end }); res.once('close', () => stream.destroy()); stream.on('error', error => res.destroy(error)); stream.pipe(res);
  } catch (error) { json(res, error.status || 404, { error: error.code || 'preview_unavailable' }); }
  return true;
}
