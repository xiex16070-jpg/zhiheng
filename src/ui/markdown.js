/** Markdown 渲染与引用角标。流式与终态共用相同的块边界、转义和编号规则。 */
import { escapeHtml } from '../agent/text.js';

const CITE_RE = /\[\[\s*([A-Za-z0-9][A-Za-z0-9_-]*)\s*\]\]/g;
const CJK = /[\u3000-\u9fff\uff00-\uffef]/;
const FENCE = /^\s*```/;
const INFERENCE = /^\[推断\]\s*[（(]([^)）]*)[)）]\s*(.*)$/;

function joinLines(lines) {
  let out = '';
  for (const line of lines) {
    if (out && !CJK.test(out.at(-1)) && !CJK.test(line[0] || '')) out += ' ';
    out += line;
  }
  return out;
}

function citation(id, info) {
  if (info.bad) return '<span class="cite bad">来源未匹配</span>';
  const ref = escapeHtml(info.ref ?? id);
  const n = escapeHtml(info.n);
  return `<button type="button" class="cite" data-cite="${ref}" title="${escapeHtml(info.title || '')}" aria-label="查看依据 ${n}">${n}</button>`;
}

function replaceLinks(text, render) {
  const start = /(!?)\[([^\[\]\n]+)\]\(/g;
  let result = '', consumed = 0, match;
  while ((match = start.exec(text))) {
    const targetStart = start.lastIndex;
    let cursor = targetStart, depth = 1;
    for (; cursor < text.length && text[cursor] !== '\n'; cursor++) {
      if (text[cursor] === '\\' && /[()\\]/.test(text[cursor + 1] || '')) { cursor++; continue; }
      if (text[cursor] === '(') depth++;
      else if (text[cursor] === ')' && --depth === 0) break;
    }
    if (depth) {
      // Keep malformed targets literal. Advance past the scanned span so a
      // long run of unfinished links cannot repeatedly scan the same text.
      result += text.slice(consumed, cursor); consumed = cursor;
      start.lastIndex = cursor;
      continue;
    }
    result += text.slice(consumed, match.index);
    const whole = text.slice(match.index, cursor + 1);
    const target = text.slice(targetStart, cursor).replace(/\\([()\\])/g, '$1');
    result += render(whole, match[1], match[2], target);
    consumed = cursor + 1; start.lastIndex = consumed;
  }
  return result + text.slice(consumed);
}

export function renderInline(text, ctx = {}) {
  const codes = [];
  const links = [];
  // The last delimiter may arrive in the next token. A citation in unfinished
  // inline code must already be literal while the user is reading the stream.
  const codeSpans = ctx.pending ? /`([^`\n]+)(?:`|$)/g : /`([^`\n]+)`/g;
  let s = String(text ?? '').replace(/\u0000/g, '\uFFFD').replace(codeSpans, (_, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = replaceLinks(s, (whole, image, label, target) => {
    if (image || /[\u0000-\u0020\u007f]/.test(target)) return whole;
    let href;
    try {
      const url = new URL(target);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return whole;
      href = url.href;
    } catch { return whole; }
    const caption = escapeHtml(label).replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`);
    links.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${caption}</a>`);
    return `\u0000link${links.length - 1}\u0000`;
  });
  s = escapeHtml(s).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  if (ctx.pending) s = s.replace(/\*\*([^*\n]+)$/, '<strong>$1</strong>');
  if (ctx.numberFor) {
    s = s.replace(CITE_RE, (whole, id) => {
      const info = ctx.numberFor(id);
      return info ? citation(id, info) : whole;
    });
  }
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)])}</code>`)
    .replace(/\u0000link(\d+)\u0000/g, (_, i) => links[Number(i)]);
}

function tableCells(line) {
  const cells = []; let cell = '', quoted = false;
  line = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '\\' && line[i + 1] === '|') { cell += '|'; i++; }
    else if (char === '`') { quoted = !quoted; cell += char; }
    else if (char === '|' && !quoted) { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim()); return cells;
}

const tableSeparator = line => line.includes('|') && tableCells(line).every(cell => /^:?-{3,}:?$/.test(cell));

// A completed line may extend the open block, close it, or start a new one.
// Keeping the unfinished line separate lets split fences, CRLF and citations
// be reinterpreted without ever walking the completed history.
function consumeLine(block, line, emit) {
  if (block?.kind === 'pre') {
    if (FENCE.test(line)) { emit(block); return null; }
    block.lines.push(line);
    return block;
  }

  let kind = 'p';
  let content = line;
  const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
  const list = /^\s*([-*+]|\d+\.)\s+/.exec(line);
  if (!line.trim()) kind = '';
  else if (FENCE.test(line)) kind = 'pre';
  else if (INFERENCE.test(line)) kind = 'inference';
  else if (heading) { kind = `h${Math.min(4, heading[1].length + 1)}`; content = heading[2]; }
  else if (list) { kind = /\d/.test(list[1]) ? 'ol' : 'ul'; content = line.slice(list[0].length); }
  else if (/^\s*>/.test(line)) { kind = 'blockquote'; content = line.replace(/^\s*>\s?/, ''); }

  if (block?.kind === 'table') {
    // A new block interrupts the table even when its text contains a pipe.
    // In particular, inference cards must retain their evidence/audit identity.
    if (kind === 'p' && line.includes('|')) { block.lines.push(line); return block; }
    emit(block); block = null;
  }
  if (block?.kind === 'p' && block.lines.length === 1 && block.lines[0].includes('|') && tableSeparator(line)) {
    const headers = tableCells(block.lines[0]);
    if (headers.length === tableCells(line).length) return { kind: 'table', lines: [block.lines[0], line] };
  }

  if (block && block.kind === kind) {
    block.lines.push(content);
    return block;
  }
  if (block) emit(block);
  if (!kind) return null;
  if (kind === 'pre') return { kind, lang: line.replace(FENCE, '').trim(), lines: [] };

  const next = { kind, lines: [content] };
  if (heading || kind === 'inference') { emit(next); return null; }
  return next;
}

export function createMarkdownParser(emit) {
  let open = null;
  let partial = '';
  return {
    append(delta) {
      const lines = String(delta).split('\n');
      if (lines.length === 1) { partial += lines[0]; return; }
      lines[0] = partial + lines[0];
      partial = lines.pop();
      for (const line of lines) open = consumeLine(open, line.replace(/\r$/, ''), emit);
    },
    // The last line may still change its meaning. Only commit it on a newline.
    pending(visit) {
      const copy = open && { ...open, lines: open.lines.slice() };
      const last = consumeLine(copy, partial, visit);
      if (last) visit(last);
    },
  };
}

export function renderMarkdownBlock({ kind, lines, lang }, ctx, infSeq) {
  if (kind === 'table') {
    const headers = tableCells(lines[0]), alignment = tableCells(lines[1]);
    const align = i => alignment[i]?.startsWith(':') && alignment[i]?.endsWith(':') ? 'center' : alignment[i]?.endsWith(':') ? 'right' : 'left';
    return `<div class="answer-table" role="region" aria-label="回答中的数据表格" tabindex="0"><table><thead><tr>${headers.map((cell, i) => `<th scope="col" class="align-${align(i)}">${renderInline(cell, ctx)}</th>`).join('')}</tr></thead><tbody>${lines.slice(2).map(line => {
      const cells = tableCells(line);
      return `<tr>${headers.map((_, i) => `<td class="align-${align(i)}">${renderInline(cells[i] || '', ctx)}</td>`).join('')}</tr>`;
    }).join('')}</tbody></table></div>`;
  }
  if (kind === 'pre') {
    return `<pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ''}>${escapeHtml(lines.join('\n'))}</code></pre>`;
  }
  if (kind === 'ul' || kind === 'ol') {
    return `<${kind}>${lines.map(t => `<li>${renderInline(t, ctx)}</li>`).join('')}</${kind}>`;
  }
  if (kind !== 'inference') return `<${kind}>${renderInline(joinLines(lines), ctx)}</${kind}>`;

  const [, meta, body] = INFERENCE.exec(lines[0]);
  const method = /方法[:：]\s*([^;；,，]*)/.exec(meta)?.[1].trim() || '方法未注明';
  const confidence = /置信度[:：]\s*([^;；,，]*)/.exec(meta)?.[1].trim() || '未注明';
  const refs = Array.from(meta.matchAll(CITE_RE), ([, id]) => citation(id, ctx.numberFor?.(id) || { n: id })).join('');
  return `<div class="inference" data-inf="${infSeq}">` +
    `<div class="inf-head"><span class="inf-badge">推断</span>` +
    `<span class="inf-meta">${escapeHtml(method)} · 置信度 ${escapeHtml(confidence)}</span>` +
    `<span class="inf-audit" data-audit="${infSeq}"></span></div>` +
    `<div class="inf-body">${renderInline(body, ctx)}</div>` +
    (refs ? `<div class="inf-refs">依据 ${refs}</div>` : '') + '</div>';
}

export function renderMarkdown(text, ctx = {}) {
  const out = [];
  let infSeq = 0;
  function add(block) {
    out.push(renderMarkdownBlock(block, ctx, infSeq));
    if (block.kind === 'inference') infSeq++;
  }
  const parser = createMarkdownParser(add);
  parser.append(text ?? '');
  parser.pending(add);
  return out.join('\n');
}
