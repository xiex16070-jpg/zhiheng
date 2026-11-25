/**
 * 文档分块。
 *
 * 原则：分块文本必须是原文的连续切片，`start`/`end` 指向原文的绝对字符位置。
 * 这样引用才能精确回到原文，而不是「大致在某个段落」。
 *
 * 切分顺序：段落 → 句子 → 超长句硬切。章节标题作为元数据，不进入切片，
 * 但在索引文本里前置，用来提升检索命中率。
 */

const HEADING_RE = /^(#{1,6}\s|第[一二三四五六七八九十百]+[章节篇]|[一二三四五六七八九十]+、|\d+(\.\d+)*[\s、.．]|[（(][一二三四五六七八九十]+[)）])/;
const SENT_END = /[。！？；!?;]/;

export const DEFAULT_CHUNK = { target: 420, max: 900, overlapSentences: 1 };

// 一次正则扫描完成切句。之前是逐字符 test，10MB 文本要跑一千万次正则，
// 会把事件循环堵死（表现为上传大文件时整个服务无响应）。
const SENT_RE = /[。！？；!?;]+[”"』」）)]*/g;

function splitSentences(paragraph, base) {
  const out = [];
  let start = 0;
  SENT_RE.lastIndex = 0;
  let m;
  while ((m = SENT_RE.exec(paragraph))) {
    const end = m.index + m[0].length;
    const text = paragraph.slice(start, end);
    if (text.trim()) out.push({ text, start: base + start, end: base + end });
    start = end;
    SENT_RE.lastIndex = end;
  }
  if (start < paragraph.length) {
    const text = paragraph.slice(start);
    if (text.trim()) out.push({ text, start: base + start, end: base + paragraph.length });
  }
  return out;
}

function hardSplit(unit, max) {
  const parts = [];
  let s = 0;
  while (s < unit.text.length) {
    let e = Math.min(unit.text.length, s + max);
    // 尽量在逗号/空格处断开
    if (e < unit.text.length) {
      const window = unit.text.slice(s + Math.floor(max * 0.6), e);
      const cut = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(' '));
      if (cut > 0) e = s + Math.floor(max * 0.6) + cut + 1;
    }
    parts.push({ text: unit.text.slice(s, e), start: unit.start + s, end: unit.start + e });
    s = e;
  }
  return parts;
}

// 页眉页脚：第 4 页 / 4 / - 4 - / 共 12 页
const PAGE_MARK_RE = /^(第?\s*\d+\s*页(\s*[,，/]?\s*共\s*\d+\s*页)?|[-—–\s]*\d{1,3}[-—–\s]*|page\s*\d+(\s*of\s*\d+)?)$/i;

function looksLikeHeading(line) {
  const t = line.trim();
  if (!t || t.length > 48) return false;
  if (PAGE_MARK_RE.test(t)) return false;
  if (HEADING_RE.test(t)) return true;
  // 短行且不以句末标点结尾，视为小标题
  return t.length <= 24 && !/[。！？；，,：:]$/.test(t);
}

/** Suppress repeated page-edge furniture as headings without removing a single
 * source character. Requires actual parser page ranges, never guessed pages. */
export function pageFurnitureStarts(text, sourceMap = []) {
  const pages = new Map();
  for (const row of sourceMap) {
    if (!Number.isInteger(row.page) || !Number.isInteger(row.start) || !Number.isInteger(row.end) || row.start < 0 || row.end > text.length || row.end <= row.start) continue;
    const old=pages.get(row.page);pages.set(row.page,{start:Math.min(old?.start ?? row.start,row.start),end:Math.max(old?.end ?? row.end,row.end)});
  }
  if(pages.size<3)return new Set();
  const occurrences=new Map();
  for(const [page,range] of pages){
    const lines=[];let offset=range.start;
    for(const line of text.slice(range.start,range.end).split('\n')){if(line.trim())lines.push({text:line.trim(),start:offset});offset+=line.length+1;}
    for(const line of [...lines.slice(0,2),...lines.slice(-2)]){
      if(line.text.length>48)continue;
      const list=occurrences.get(line.text)||[];list.push({...line,page});occurrences.set(line.text,list);
    }
  }
  const out=new Set();
  for(const rows of occurrences.values())if(new Set(rows.map(x=>x.page)).size>=Math.max(3,Math.ceil(pages.size*.6)))for(const row of rows)out.add(row.start);
  return out;
}

/**
 * @param {string} text 原文
 * @param {{target?:number,max?:number,overlapSentences?:number}} opts
 * @returns {Array<{idx:number,text:string,start:number,end:number,heading:string}>}
 */
export function chunkText(text, opts = {}) {
  const { target, max, overlapSentences } = { ...DEFAULT_CHUNK, ...opts };
  if (!text || !text.trim()) return [];

  // 1) 拆段并记录偏移
  const paragraphs = [];
  let cursor = 0;
  for (const line of text.split('\n')) {
    paragraphs.push({ text: line, start: cursor, end: cursor + line.length });
    cursor += line.length + 1;
  }

  // 2) 段落 → 句子单元，同时跟踪章节标题
  const units = [];
  const furniture = pageFurnitureStarts(text, opts.sourceMap);
  let heading = '';
  for (const p of paragraphs) {
    const t = p.text.trim();
    if (!t) {
      if (units.length) units.push({ text: '', start: p.start, end: p.start, blank: true });
      continue;
    }
    if (!furniture.has(p.start) && looksLikeHeading(t)) {
      heading = t.replace(/^#{1,6}\s*/, '').slice(0, 120);
      units.push({ text: t, start: p.start, end: p.end, heading, isHeading: true });
      continue;
    }
    for (const s of splitSentences(p.text, p.start)) {
      units.push({ ...s, heading });
    }
  }

  // 3) 贪心打包
  const chunks = [];
  let buf = [];
  let len = 0;

  const flush = () => {
    if (!buf.length) return;
    const start = buf[0].start;
    const end = buf[buf.length - 1].end;
    const slice = text.slice(start, end);
    if (slice.trim().length >= 12) {
      chunks.push({
        idx: chunks.length,
        text: slice,
        start,
        end,
        heading: buf.find((u) => u.heading)?.heading || '',
      });
    }
    // 保留末尾若干句作为下一块的重叠上下文
    const keep = overlapSentences > 0 ? buf.slice(-overlapSentences) : [];
    buf = keep;
    len = keep.reduce((a, u) => a + u.text.length, 0);
  };

  for (const u of units) {
    if (u.isHeading) {
      // 标题单独成块时价值低，作为上下文并入下一块
      buf.push(u);
      len += u.text.length;
      continue;
    }
    if (!u.text) {
      if (len >= target) flush();
      continue;
    }
    if (u.text.length > max) {
      flush();
      for (const part of hardSplit(u, max)) {
        chunks.push({
          idx: chunks.length,
          text: part.text,
          start: part.start,
          end: part.end,
          heading: u.heading || '',
        });
      }
      buf = [];
      len = 0;
      continue;
    }
    buf.push(u);
    len += u.text.length;
    if (len >= target) flush();
  }
  flush();

  // 4) 去重（重叠可能导致完全相同的切片）
  const seen = new Set();
  return chunks.filter((c) => {
    const key = `${c.start}:${c.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 索引文本：标题 + 正文，用于提升主题词权重 */
export function indexTextOf(chunk) {
  return chunk.heading ? `${chunk.heading}\n${chunk.text}` : chunk.text;
}
