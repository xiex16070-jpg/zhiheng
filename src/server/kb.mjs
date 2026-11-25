/**
 * 用户知识库：上传文档的解析、分块、存储与检索。
 *
 * 与 CSL 论文库并列存在，但归属到具体用户（私有）。检索时作为独立通道，
 * 与论文通道、向量通道一起做 RRF 融合。
 *
 * 存储：MySQL 可用时写 kb_docs / kb_chunks；否则落到 data/kb.json 并建进程内索引。
 */

import { config } from './config.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { query, transaction } from './db.mjs';
import { extractText } from './extract/index.mjs';
import { chunkText, indexTextOf } from './chunker.mjs';
import { tokenize, termWeights } from '../agent/text.js';
import { upsertVectors } from './vector.mjs';
import { readJsonOrQuarantine, withFileLock, writeJsonAtomic } from './fsutil.mjs';
import { locateNormalizedQuote } from './quote.mjs';
import { publishKnowledgeSourceChange } from './kb-events.mjs';

const K1 = 1.2;
const B = 0.75;

const state = {
  engine: 'none',
  docs: [],
  sections: [],
  chunks: [],
  userIndexes: new Map(),
};

/* ---------------------------------------------------------------- 进程内索引 */

class ChunkIndex {
  constructor(chunks) {
    this.chunks = chunks;
    this.N = chunks.length;
    this.scores = new Float64Array(this.N);
    this.lengths = [];
    this.postings = new Map();
    this._build();
  }

  _build() {
    const tmp = new Map();
    for (let d = 0; d < this.N; d++) {
      const toks = tokenize(indexTextOf(this.chunks[d]));
      this.lengths[d] = toks.length || 1;
      const counts = new Map();
      for (const { term } of toks) counts.set(term, (counts.get(term) || 0) + 1);
      for (const [term, tf] of counts) {
        if (!tmp.has(term)) tmp.set(term, []);
        tmp.get(term).push(d, tf);
      }
    }
    this.avgdl = this.N ? this.lengths.reduce((a, b) => a + b, 0) / this.N : 1;
    for (const [term, flat] of tmp) this.postings.set(term, flat);
  }

  idf(term) {
    const df = (this.postings.get(term)?.length || 0) / 2;
    if (!df) return 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  search(weights, topK, allowedDocs) {
    const scores = this.scores.fill(0);
    for (const [term, qw] of weights) {
      const flat = this.postings.get(term);
      if (!flat) continue;
      const idf = this.idf(term);
      for (let i = 0; i < flat.length; i += 2) {
        const d = flat[i];
        const tf = flat[i + 1];
        const dl = this.lengths[d];
        const denom = tf + K1 * (1 - B + (B * dl) / this.avgdl);
        scores[d] += qw * idf * ((tf * (K1 + 1)) / denom);
      }
    }
    const out = [];
    for (let d = 0; d < this.N; d++) {
      if (scores[d] > 0 && (!allowedDocs || allowedDocs.has(this.chunks[d].docId))) {
        out.push({ chunk: this.chunks[d], score: scores[d] });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, topK);
  }
}

/* ---------------------------------------------------------------- 文件存储 */

async function loadFileState() {
  const data = await readJsonOrQuarantine(config.kbFile, { docs: [], chunks: [] });
  state.docs = Array.isArray(data.docs) ? data.docs : [];
  state.sections = Array.isArray(data.sections) ? data.sections : [];
  state.chunks = Array.isArray(data.chunks) ? data.chunks : [];
  // Each owner gets a lazy index below; do not rebuild an unused global index
  // over everybody's entire library on every small import or deletion.
  state.userIndexes.clear();
}

/* ---------------------------------------------------------------- 初始化 */

export async function initKb({ mysqlReady }) {
  if (mysqlReady) {
    try {
      await query(`SELECT 1 FROM kb_docs LIMIT 1`);
      state.engine = 'mysql';
      return kbStatus();
    } catch (err) {
      console.warn(`[kb] MySQL 知识库表不可用：${err.message}`);
    }
  }
  await loadFileState();
  state.engine = 'file';
  return kbStatus();
}

export function kbStatus() {
  return {
    engine: state.engine,
    docs: state.engine === 'mysql' ? undefined : state.docs.length,
    chunks: state.engine === 'mysql' ? undefined : state.chunks.length,
  };
}

/* ---------------------------------------------------------------- 写入 */

/**
 * 导入一份文档。
 * @param {{userId:string, name:string, mime?:string, buffer:Buffer}} input
 */
export async function importDocument({ userId, name, mime = '', buffer }) {
  const t0 = Date.now();
  const extracted = await extractText(buffer, name);
  const text = extracted.text;
  if (!text || text.trim().length < 10) {
    // 扫描件（整本都是图片）和「内容确实为空」要分开报，否则用户不知道该做什么
    if (extracted.kind === 'pdf' && extracted.pages > 0 && (extracted.textPages || 0) === 0) {
      throw new Error(
        `这份 PDF 没有文字层（共 ${extracted.pages} 页，全是图片，属于扫描件），需要先做 OCR 转成可复制文字的 PDF 再导入`
      );
    }
    throw new Error('未能从文件中提取到正文，可能是空文件或格式不支持');
  }

  if (text.length > config.upload.maxTextChars) {
    throw new Error(
      `正文约 ${(text.length / 10000).toFixed(0)} 万字，超过单文档上限 ` +
        `${(config.upload.maxTextChars / 10000).toFixed(0)} 万字，请按章节拆分后分别导入`
    );
  }

  const chunks = chunkText(text, {sourceMap:extracted.sourceMap || []});
  if (!chunks.length) throw new Error('正文过短，无法分块');

  const docId = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const doc = {
    id: docId,
    userId,
    name: String(name).slice(0, 255),
    mime: String(mime || '').slice(0, 100),
    sizeBytes: buffer.length,
    charCount: text.length,
    chunkCount: chunks.length,
    kind: extracted.kind,
    extraction: { parser: extracted.parser || 'lightweight', parserVersion: extracted.parserVersion || null,
      pages: extracted.pages || 0, sourceMap: extracted.sourceMap || [], warnings: extracted.warnings || [] },
    status: 'ready',
    text,
    createdAt: new Date().toISOString(),
  };

  const rows = chunks.map((c, i) => ({
    id: `${docId}_${i}`,
    docId,
    userId,
    idx: c.idx,
    heading: c.heading.slice(0, 200),
    text: c.text,
    start: c.start,
    end: c.end,
  }));

  if (state.engine === 'mysql') {
    await transaction(async (tx) => {
      const count = await tx(`SELECT COUNT(*) AS n FROM kb_docs WHERE user_id = ? FOR UPDATE`, [doc.userId]);
      if (Number(count[0]?.n || 0) >= config.upload.maxDocs) throw new Error('too_many_docs');
      await tx(
        `INSERT INTO kb_docs (id, user_id, name, mime, size_bytes, char_count, chunk_count, text, kind, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
        [doc.id, doc.userId, doc.name, doc.mime, doc.sizeBytes, doc.charCount, doc.chunkCount, text, doc.kind]
      );
      await tx('INSERT INTO kb_extractions (doc_id, metadata) VALUES (?, ?)', [doc.id, JSON.stringify(doc.extraction)]);
      for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(',');
        const params = batch.flatMap((r) => [r.id, r.docId, r.userId, r.idx, r.heading, r.text, r.start, r.end]);
        await tx(
          `INSERT INTO kb_chunks (id, doc_id, user_id, idx, heading, text, char_start, char_end) VALUES ${placeholders}`,
          params
        );
      }
    });
  } else {
    await withFileLock(config.kbFile, async () => {
      if (state.docs.filter((item) => item.userId === userId).length >= config.upload.maxDocs) {
        throw new Error('too_many_docs');
      }
      const docs = [...state.docs, doc];
      const allChunks = [...state.chunks, ...rows];
      await writeJsonAtomic(config.kbFile, { docs, chunks: allChunks, sections: state.sections });
      state.docs = docs;
      state.chunks = allChunks;
      state.userIndexes.delete(userId);
      state.userIndexes.delete('*');
    });
  }

  // 向量索引是增强项：失败不影响文档可用性
  let vectorIndexed = 0;
  try {
    const r = await indexDocumentVectors(doc.id, userId);
    vectorIndexed = r.indexed;
  } catch (err) {
    console.warn(`[kb] 向量索引失败（不影响检索）：${err.message}`);
  }

  publishKnowledgeSourceChange({ userId, docId: doc.id, action: 'import' });
  return {
    doc,
    ms: Date.now() - t0,
    chars: text.length,
    chunks: chunks.length,
    kind: extracted.kind,
    vectorIndexed,
  };
}

export async function listDocuments(userId, { limit = config.upload.maxDocs, offset = 0 } = {}) {
  const all = userId === '*';
  if (state.engine === 'mysql') {
    const rows = all
      ? await query(
          `SELECT id, name, mime, size_bytes, char_count, chunk_count, kind, status, created_at
           FROM kb_docs ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [Number(limit), Number(offset)]
        )
      : await query(
          `SELECT id, name, mime, size_bytes, char_count, chunk_count, kind, status, created_at
           FROM kb_docs WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          [userId, Number(limit), Number(offset)]
        );
    return rows.map(mapDocRow);
  }
  return state.docs
    .filter((d) => all || d.userId === userId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(offset, offset + limit)
    .map(({ text, ...rest }) => rest);
}

export async function countDocuments(userId) {
  const all = userId === '*';
  if (state.engine === 'mysql') {
    const rows = all
      ? await query(`SELECT COUNT(*) AS n FROM kb_docs`)
      : await query(`SELECT COUNT(*) AS n FROM kb_docs WHERE user_id = ?`, [userId]);
    return Number(rows[0]?.n || 0);
  }
  return state.docs.filter((d) => all || d.userId === userId).length;
}

// Read only one short passage per displayed file. Loading getDocument here would
// repeatedly pull entire PDFs and their extraction maps into the home-page request.
export async function questionPassages(userId, docIds, round, limit) {
  if (!userId || userId === '*' || !limit || docIds?.length === 0) return [];
  const allowed = docIds && new Set(docIds);
  const docs = (await listDocuments(userId, { limit: 2147483647 }))
    .filter(d => d.chunkCount > 0 && (!allowed || allowed.has(d.id)));
  if (!docs.length) return [];
  // Keep the newest import visible and rotate through the remaining documents.
  const others = docs.slice(1);
  const offset = others.length ? round % others.length : 0;
  const picked = [docs[0], ...others.slice(offset), ...others.slice(0, offset)].slice(0, limit);
  const indices = new Map(picked.map(d => [d.id, round % d.chunkCount]));
  const chunks = state.engine === 'mysql'
    ? await query(`SELECT id, doc_id AS docId, heading, LEFT(text, 260) AS sample FROM kb_chunks
        WHERE user_id = ? AND (doc_id, idx) IN (?)`, [userId, [...indices]])
    : state.chunks.filter(c => c.userId === userId && indices.get(c.docId) === c.idx)
      .map(c => ({ id: c.id, docId: c.docId, heading: c.heading, sample: c.text.slice(0, 260) }));
  return picked.flatMap(d => {
    const c = chunks.find(item => item.docId === d.id);
    return c ? [{ ...c, name: d.name }] : [];
  });
}

function mapDocRow(r) {
  return {
    id: r.id,
    name: r.name,
    mime: r.mime,
    sizeBytes: r.size_bytes,
    charCount: r.char_count,
    chunkCount: r.chunk_count,
    kind: r.kind,
    status: r.status,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

export async function getDocument(id, userId) {
  if (state.engine === 'mysql') {
    const rows = await query(`SELECT * FROM kb_docs WHERE id = ?`, [id]);
    if (!rows.length) return null;
    if (userId && rows[0].user_id !== userId) return null;
    const r = rows[0];
    const extractionRows = await query('SELECT metadata FROM kb_extractions WHERE doc_id = ?', [id]);
    const metadata = extractionRows[0]?.metadata;
    const extraction = typeof metadata === 'string' ? JSON.parse(metadata) : metadata || null;
    const chunks = await query(
      `SELECT id, idx, heading, text, char_start, char_end FROM kb_chunks WHERE doc_id = ? ORDER BY idx ASC`,
      [id]
    );
    return {
      ...mapDocRow(r),
      userId: r.user_id,
      extraction,
      text: r.text,
      chunks: chunks.map((c) => ({
        id: c.id,
        idx: c.idx,
        heading: c.heading,
        text: c.text,
        start: c.char_start,
        end: c.char_end,
      })),
    };
  }

  const doc = state.docs.find((d) => d.id === id);
  if (!doc) return null;
  if (userId && doc.userId !== userId) return null;
  return { ...doc, chunks: state.chunks.filter((c) => c.docId === id).sort((a, b) => a.idx - b.idx) };
}

export async function deleteDocument(id, userId) {
  let removed;
  if (state.engine === 'mysql') {
    removed = await transaction(async (tx) => {
      const rows = await tx(`SELECT user_id FROM kb_docs WHERE id = ? FOR UPDATE`, [id]);
      if (!rows.length || rows[0].user_id !== userId) return false;
      await tx(`DELETE FROM kb_chunks WHERE doc_id = ?`, [id]);
      await tx('DELETE FROM kb_extractions WHERE doc_id = ?', [id]);
      await tx(`DELETE FROM kb_docs WHERE id = ?`, [id]);
      return true;
    });
  } else removed = await withFileLock(config.kbFile, async () => {
    const doc = state.docs.find((d) => d.id === id && d.userId === userId);
    if (!doc) return false;
    const docs = state.docs.filter((d) => d.id !== id);
    const chunks = state.chunks.filter((c) => c.docId !== id);
    const sections = state.sections.map(s => s.userId === userId
      ? { ...s, docIds: s.docIds.filter(docId => docId !== id) } : s);
    await writeJsonAtomic(config.kbFile, { docs, chunks, sections });
    state.sections = sections;
    state.docs = docs;
    state.chunks = chunks;
    state.userIndexes.delete(userId);
    state.userIndexes.delete('*');
    return true;
  });
  if (removed) publishKnowledgeSourceChange({ userId, docId: id, action: 'delete' });
  return removed;
}

/* ---------------------------------------------------------------- 检索 */

export const isSectionId = value => typeof value === 'string' && /^kb:[a-f0-9-]{36}$/.test(value);

function invalidSection(message, status = 400) {
  return Object.assign(new Error(message), { code: 'invalid_section', status });
}

export async function listSections(userId) {
  if (state.engine !== 'mysql') {
    return state.sections.filter(s => s.userId === userId).map(({ userId: owner, ...section }) => section);
  }
  const rows = await query(`SELECT s.id, s.name, s.summary, m.doc_id FROM kb_sections s
    LEFT JOIN kb_section_docs m ON m.section_id = s.id WHERE s.user_id = ? ORDER BY s.name, m.doc_id`, [userId]);
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.id)) groups.set(row.id, { id: row.id, name: row.name, summary: row.summary, docIds: [] });
    if (row.doc_id) groups.get(row.id).docIds.push(row.doc_id);
  }
  return [...groups.values()];
}

// null means unrestricted; an unknown or emptied private section always means zero documents.
export async function sectionDocIds(userId, discipline) {
  if (!isSectionId(discipline)) return null;
  if (!userId || userId === '*') return [];
  return (await listSections(userId)).find(s => s.id === discipline)?.docIds || [];
}

function selectedIds(input) {
  if (!Array.isArray(input) || !input.length || input.length > 10000 ||
    input.some(id => typeof id !== 'string' || !/^[\w-]{1,32}$/.test(id))) {
    throw invalidSection('请至少选择一个已导入的文件。');
  }
  return [...new Set(input)];
}

async function sectionSources(userId, ids, read = query, lock = false) {
  const documents = state.engine === 'mysql'
    ? await read(`SELECT id, name, LEFT(text, 1600) AS sample FROM kb_docs
      WHERE user_id = ? AND id IN (?)${lock ? ' FOR UPDATE' : ''}`, [userId, ids])
    : state.docs.filter(d => d.userId === userId && ids.includes(d.id))
      .map(d => ({ id: d.id, name: d.name, sample: d.text.slice(0, 1600) }));
  if (documents.length !== ids.length) throw invalidSection('选中的文件有变动，请刷新文件列表。', 404);
  return documents;
}

export async function suggestSection(userId, docIds) {
  const docs = await sectionSources(userId, selectedIds(docIds));
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const stems = docs.map(d => d.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
  const generic = /^(?:[\d\s]+|scan\d*|扫描件?|文件|教材|版本|导读|讲义|资料|笔记|复习|文档|本章|本文|以下|包括|可以|进行|通过|以及|一个|the|and|that|this|with|from)$/iu;
  function keywords(texts) {
    const counts = new Map();
    for (const sample of texts) {
      const unique = new Set();
      for (const { segment, isWordLike } of segmenter.segment(sample)) {
        if (isWordLike && segment.length >= 2 && !generic.test(segment)) unique.add(segment);
      }
      for (const word of unique) counts.set(word, (counts.get(word) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }
  const titles = keywords(stems);
  const shared = titles.filter(([, n]) => n > 1).map(([word]) => word);
  const topics = keywords(docs.map(d => d.sample)).filter(([, n]) => n > 1 || !titles.length).map(([word]) => word);
  const name = (shared.slice(0, 3).join(' · ') || (docs.length === 1 && titles.length ? stems[0] : '') ||
    topics.slice(0, 3).join(' · ') || stems.slice(0, 2).join(' · ')).slice(0, 64) || '文献分区';
  const excerpts = docs.map(d => {
    const lines = d.sample.split(/(?<=[。！？.!?])\s*|\r?\n/u).map(s => s.trim());
    const candidates = lines.filter(s => s.length >= 12 && !/^(?:#{1,6}\s|ISBN\b|copyright\b)/iu.test(s));
    const themes = [...shared, ...topics].slice(0, 6);
    const score = sentence => themes.filter(word => sentence.includes(word)).length;
    const passage = candidates.sort((a, b) => score(b) - score(a))[0] || d.sample.trim();
    return `《${d.name}》${passage.slice(0, 118)}${passage.length > 118 ? '…' : ''}`;
  });
  return { name, summary: excerpts.join('\n').slice(0, 2000) };
}

export async function saveSection(userId, id, body) {
  const docIds = selectedIds(body?.docIds);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const summary = body.summary ?? '';
  if (!name || name.length > 64 || typeof summary !== 'string' || summary.length > 2000) {
    throw invalidSection('分区名称须为 1 至 64 字，摘要上限为 2000 字。');
  }
  const section = { id: id || `kb:${randomUUID()}`, name, summary: summary.trim(), docIds };
  if (state.engine === 'mysql') {
    await transaction(async tx => {
      if (id) {
        const rows = await tx('SELECT id FROM kb_sections WHERE id = ? AND user_id = ? FOR UPDATE', [id, userId]);
        if (!rows.length) throw invalidSection('分区不存在。', 404);
      }
      await sectionSources(userId, docIds, tx, true);
      if (id) {
        await tx('UPDATE kb_sections SET name = ?, summary = ? WHERE id = ?', [name, section.summary, id]);
        await tx('DELETE FROM kb_section_docs WHERE section_id = ?', [id]);
      } else {
        await tx('INSERT INTO kb_sections (id, user_id, name, summary) VALUES (?, ?, ?, ?)', [section.id, userId, name, section.summary]);
      }
      await tx('INSERT INTO kb_section_docs (section_id, doc_id) VALUES ?', [docIds.map(docId => [section.id, docId])]);
    });
  } else {
    await withFileLock(config.kbFile, async () => {
      if (id && !state.sections.some(s => s.id === id && s.userId === userId)) throw invalidSection('分区不存在。', 404);
      await sectionSources(userId, docIds);
      const sections = [...state.sections.filter(s => s.id !== id), { userId, ...section }];
      await writeJsonAtomic(config.kbFile, { docs: state.docs, chunks: state.chunks, sections });
      state.sections = sections;
    });
  }
  return section;
}

/**
 * 在用户自己的知识库里检索片段。
 * @returns {Promise<Array<{id,docId,docName,heading,text,start,end,score}>>}
 */
export async function searchChunks(q, { userId, k = 8, docIds = null } = {}) {
  const query0 = String(q || '').trim();
  if (!query0 || !userId || docIds?.length === 0) return [];

  // userId='*' 表示跨用户检索（仅限本机 MCP 通道，由调用方负责鉴权）
  const all = userId === '*';

  if (state.engine === 'mysql') {
    const scope = [all ? '1=1' : 'c.user_id = ?', ...(docIds ? ['c.doc_id IN (?)'] : [])].join(' AND ');
    const scopeParams = [...(all ? [] : [userId]), ...(docIds ? [docIds] : [])];
    const sql = `SELECT c.id, c.doc_id, c.idx, c.heading, c.text, c.char_start, c.char_end,
                        d.name AS doc_name,
                        MATCH(c.text, c.heading) AGAINST (? IN NATURAL LANGUAGE MODE) AS ft
                 FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
                 WHERE ${scope} AND MATCH(c.text, c.heading) AGAINST (? IN NATURAL LANGUAGE MODE)
                 ORDER BY ft DESC LIMIT ?`;
    const params = [query0, ...scopeParams, query0, k * 4];
    let rows = await query(sql, params).catch(() => []);

    // ngram 对极短查询失效时退化为 LIKE
    if (!rows.length && query0.length <= 4) {
      const like = `%${query0}%`;
      rows = await query(
        `SELECT c.id, c.doc_id, c.idx, c.heading, c.text, c.char_start, c.char_end,
                d.name AS doc_name, 0 AS ft
         FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
         WHERE ${scope} AND (c.text LIKE ? OR c.heading LIKE ?)
         LIMIT ?`,
        [...scopeParams, like, like, k * 4]
      ).catch(() => []);
    }

    return rows.slice(0, k).map((r) => ({
      id: r.id,
      docId: r.doc_id,
      docName: r.doc_name,
      idx: r.idx,
      heading: r.heading,
      text: r.text,
      start: r.char_start,
      end: r.char_end,
      score: Number(r.ft) || 0,
    }));
  }

  if (state.engine !== 'file') return [];
  const cacheKey = all ? '*' : userId;
  let idx = state.userIndexes.get(cacheKey);
  if (!idx) {
    const mine = state.chunks.filter((c) => all || c.userId === userId);
    if (!mine.length) return [];
    idx = new ChunkIndex(mine);
    state.userIndexes.set(cacheKey, idx);
  }
  return idx.search(termWeights(tokenize(query0)), k, docIds && new Set(docIds)).map(({ chunk, score }) => ({
    id: chunk.id,
    docId: chunk.docId,
    docName: state.docs.find((d) => d.id === chunk.docId)?.name || '',
    idx: chunk.idx,
    heading: chunk.heading,
    text: chunk.text,
    start: chunk.start,
    end: chunk.end,
    score,
  }));
}

/** 供向量化使用：取某用户（或全体）的片段 */
export async function listChunksForIndex(userId = null) {
  if (state.engine === 'mysql') {
    const rows = userId
      ? await query(`SELECT id, doc_id, user_id, idx, heading, text FROM kb_chunks WHERE user_id = ?`, [userId])
      : await query(`SELECT id, doc_id, user_id, idx, heading, text FROM kb_chunks`);
    return rows.map((r) => ({
      id: r.id,
      docId: r.doc_id,
      userId: r.user_id,
      idx: r.idx,
      heading: r.heading,
      text: r.text,
    }));
  }
  return state.chunks
    .filter((c) => !userId || c.userId === userId)
    .map((c) => ({ id: c.id, docId: c.docId, userId: c.userId, idx: c.idx, heading: c.heading, text: c.text }));
}

/** 按片段 ID 取片段（含所属文档名与全文），用于 read_source */
export async function getChunkById(chunkId, userId = null) {
  if (state.engine === 'mysql') {
    const rows = await query(
      `SELECT c.id, c.doc_id, c.user_id, c.idx, c.heading, c.text, c.char_start, c.char_end, d.name AS doc_name, d.text AS doc_text
       FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.id = ?`,
      [chunkId]
    );
    if (!rows.length) return null;
    const r = rows[0];
    if (userId && r.user_id !== userId) return null;
    return {
      id: r.id,
      docId: r.doc_id,
      userId: r.user_id,
      docName: r.doc_name,
      docText: r.doc_text,
      idx: r.idx,
      heading: r.heading,
      text: r.text,
      start: r.char_start,
      end: r.char_end,
    };
  }
  const chunk = state.chunks.find((c) => c.id === chunkId);
  if (!chunk) return null;
  if (userId && chunk.userId !== userId) return null;
  const doc = state.docs.find((d) => d.id === chunk.docId);
  return { ...chunk, docName: doc?.name || '', docText: doc?.text || '' };
}

/** 校验引文是否逐字出现在上传文档中 */
/** An owner-scoped passage snapshot without loading the full document or extraction map. */
export async function getChunkSnapshot(chunkId, userId) {
  if (!userId || userId === '*' || typeof chunkId !== 'string' || chunkId.length > 100) return null;
  let chunk;
  if (state.engine === 'mysql') {
    const rows = await query(`SELECT c.id, c.doc_id, c.user_id, c.idx, c.heading, c.text,
      c.char_start, c.char_end, d.name AS doc_name FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
      WHERE c.id = ? AND c.user_id = ? AND d.user_id = ? LIMIT 1`, [chunkId, userId, userId]);
    const r = rows[0];
    if (!r) return null;
    chunk = { id: r.id, docId: r.doc_id, userId: r.user_id, idx: r.idx, heading: r.heading,
      text: r.text, start: r.char_start, end: r.char_end, docName: r.doc_name };
  } else {
    const found = state.chunks.find(c => c.id === chunkId && c.userId === userId);
    const doc = found && state.docs.find(d => d.id === found.docId && d.userId === userId);
    if (!doc) return null;
    chunk = { ...found, docName: doc.name };
  }
  const sourceVersion = createHash('sha256').update(JSON.stringify([chunk.docId, chunk.id, chunk.heading || '', chunk.text, chunk.start, chunk.end])).digest('hex');
  return { ...chunk, sourceVersion };
}

export async function verifyDocQuote(docId, quote, userId = null) {
  const doc = await getDocument(docId, userId);
  if (!doc) return { found: false, reason: 'document_not_found' };
  return locateNormalizedQuote(doc.text, quote, { minLength: 4 });
}

/** Restrict verification to the cited chunk, then translate to document offsets. */
export async function verifyChunkQuote(chunkId, userId, quote) {
  const chunk = await getChunkById(chunkId, userId);
  if (!chunk) return { found: false, reason: 'source_not_found' };
  const local = locateNormalizedQuote(chunk.text, quote, { minLength: 4 });
  if (!local.found) return local;
  return {
    ...local,
    start: Number(chunk.start || 0) + local.start,
    end: Number(chunk.start || 0) + local.end,
  };
}

/** 为某文档的全部片段建立向量索引 */
export async function indexDocumentVectors(docId, userId) {
  const doc = await getDocument(docId, userId);
  if (!doc) return { indexed: 0 };
  const items = doc.chunks.map((c) => ({
    ref: c.id,
    text: indexTextOf({ heading: c.heading, text: c.text }),
    payload: {
      kind: 'doc',
      docId: doc.id,
      userId: doc.userId || userId,
      docName: doc.name,
      heading: c.heading || '',
      text: c.text,
      start: c.start,
      end: c.end,
      locatable: true,
    },
  }));
  const r = await upsertVectors(items);
  return { indexed: r.upserted || 0, dim: r.dim };
}
