/**
 * RAG 层：带版本与许可溯源的专业全文语料；显式 legacy-csl 模式兼容旧库。
 *
 * 两套后端：
 *   - MySQL：ngram 全文索引做召回（40k 全量），再用自研 BM25 + 覆盖率重排。
 *   - 文件：紧凑倒排索引（Int32Array 存 docId，Uint8Array 存 tf）做 BM25。
 *
 * 命中后定位到原文单元中的最佳句子，返回字符区间，供前端高亮。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { query } from './db.mjs';
import { tokenize, termWeights } from '../agent/text.js';
import { locateNormalizedQuote } from './quote.mjs';
import { formalExpansion, formalConceptCoverage, missingFormalConcepts } from './formal-query.mjs';

const K1 = 1.2;
const B = 0.75;
const SENTENCE_END = /[。！？；\n]/;

/* ---------------------------------------------------------------- 文献记录 */

export function buildContent(p) {
  // Editorial search tags are metadata, never presented as quotations from the source.
  const kw = p.keywords && !p.sourceUrl ? `\n\n关键词：${p.keywords}` : '';
  return `${p.title}\n\n${p.abstract}${kw}`;
}

export function sourceMetadata(p) {
  const fields = ['sourceUrl', 'canonicalUrl', 'sourceTitle', 'sourceRevision', 'authors', 'translators', 'publisher', 'license', 'licenseUrl', 'language', 'chapter', 'section', 'contentSha256', 'sourceSha256', 'recordType', 'sourcePath', 'sourceStartLine', 'sourceEndLine', 'translationStatus', 'proofStatus', 'containsExercises', 'containsCode', 'contentRole', 'volumeVersion', 'sourceEdition', 'sourceEditionDate', 'corpusId'];
  fields.push('doi', 'year', 'publishedAt', 'venue', 'volume', 'issue', 'page', 'evidenceLevel');
  return Object.fromEntries(fields.filter((key) => p[key] != null).map((key) => [key, p[key]]));
}

function toPaper(r) {
  return {
    evidenceLevel: 'abstract',
    id: r.id,
    title: r.title,
    abstract: r.abstract,
    keywords: r.keywords || '',
    discipline: r.discipline || '',
    category: r.category || '',
  };
}

/** 在原文单元（兼容字段 abstract）中找最贴合查询的句子，返回内容区间。 */
export function locateSentence(paper, queryTerms, content) {
  const start = content.indexOf(paper.abstract);
  if (start < 0) return { text: paper.abstract.slice(0, 160), start: 0, end: 0 };

  const sentences = [];
  let cursor = 0;
  let buf = '';
  for (const ch of paper.abstract) {
    buf += ch;
    cursor += ch.length;
    if (SENTENCE_END.test(ch)) {
      if (buf.trim().length > 6) sentences.push({ text: buf.trim(), offset: cursor - buf.length + buf.search(/\S/) });
      buf = '';
    }
  }
  if (buf.trim().length > 6) sentences.push({ text: buf.trim(), offset: cursor - buf.length + buf.search(/\S/) });
  if (!sentences.length) sentences.push({ text: paper.abstract, offset: 0 });

  let best = sentences[0];
  let bestScore = -1;
  for (const s of sentences) {
    const toks = new Set(tokenize(s.text).map((t) => t.term));
    let score = 0;
    for (const t of queryTerms) if (toks.has(t)) score += 1;
    score = score / Math.max(1, Math.sqrt(s.text.length));
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  const absStart = start + best.offset;
  return {
    text: best.text,
    start: absStart,
    end: absStart + best.text.length,
  };
}

/* ---------------------------------------------------------------- 紧凑索引 */

class CompactIndex {
  constructor(papers) {
    this.papers = papers;
    this.N = papers.length;
    this.byId = new Map(papers.map(p => [Number(p.id), p]));
    this.lengths = new Int32Array(this.N);
    this.scores = new Float64Array(this.N);
    this.matched = new Float64Array(this.N);
    this.postings = new Map();
    this.df = new Map();
    this._build();
  }

  _build() {
    const tmp = new Map();
    for (let d = 0; d < this.N; d++) {
      const p = this.papers[d];
      const title = tokenize(p.title);
      const body = tokenize(`${p.keywords} ${p.abstract}`);
      this.lengths[d] = 2 * title.length + body.length;
      const counts = new Map();
      for (const { term } of title) counts.set(term, (counts.get(term) || 0) + 2);
      for (const { term } of body) counts.set(term, (counts.get(term) || 0) + 1);
      for (const [term, tf] of counts) {
        let arr = tmp.get(term);
        if (!arr) {
          arr = [];
          tmp.set(term, arr);
        }
        arr.push(d, Math.min(255, tf));
      }
    }

    let total = 0;
    for (let d = 0; d < this.N; d++) total += this.lengths[d];
    this.avgdl = this.N ? total / this.N : 1;

    for (const [term, flat] of tmp) {
      const n = flat.length / 2;
      const docs = new Int32Array(n);
      const tfs = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        docs[i] = flat[i * 2];
        tfs[i] = flat[i * 2 + 1];
      }
      this.postings.set(term, { docs, tfs });
      this.df.set(term, n);
    }
  }

  idf(term) {
    const df = this.df.get(term) || 0;
    if (!df) return 0;
    return Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
  }

  search(weights, topK, predicate = null) {
    // Accumulation and result materialization are synchronous.
    const scores = this.scores.fill(0);
    const matched = this.matched.fill(0);
    let totalIdf = 0;
    const unseenIdf = Math.log(1 + (this.N + 0.5) / 0.5);

    for (const [term] of weights) {
      const idf = this.idf(term);
      if (idf > 0) totalIdf += idf;
      else if (/^[a-z0-9_]/.test(term)) totalIdf += unseenIdf;
    }

    for (const [term, qw] of weights) {
      const post = this.postings.get(term);
      if (!post) continue;
      const idf = this.idf(term);
      const { docs, tfs } = post;
      for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        const tf = tfs[i];
        const dl = this.lengths[d] || 1;
        const denom = tf + K1 * (1 - B + (B * dl) / (this.avgdl || 1));
        scores[d] += qw * idf * ((tf * (K1 + 1)) / (denom || 1));
        matched[d] += idf;
      }
    }

    const idx = [];
    for (let d = 0; d < this.N; d++) {
      if (scores[d] > 0 && (!predicate || predicate(this.papers[d]))) idx.push(d);
    }
    idx.sort((a, b) => scores[b] - scores[a]);
    return idx.slice(0, topK).map((d) => ({
      paper: this.papers[d],
      score: scores[d],
      coverage: totalIdf > 0 ? Math.min(1, matched[d] / totalIdf) : 0,
    }));
  }
}

/* ---------------------------------------------------------------- 状态 */

const state = {
  engine: 'none',
  papers: [],
  index: null,
  count: 0,
  disciplines: [],
  loadedAt: null,
  corpusId: null,
  manifest: null,
};

export function ragStatus() {
  return {
    engine: state.engine,
    papers: state.count,
    disciplines: state.disciplines.length,
    loadedAt: state.loadedAt,
    profile: config.corpus.profile,
    corpusId: state.corpusId,
    name: state.manifest?.name || (config.corpus.profile === 'legacy-csl' ? 'CSL 中文期刊摘要库' : config.corpus.profile === 'formal' ? '计算机科学与形式逻辑全文库' : '自定义文献库'),
    description: state.manifest?.description || '',
    sourceCount: state.manifest?.sourceCount || 0,
    chapterCount: state.manifest?.chapterCount || 0,
    licenses: state.manifest?.licenses || [],
    unit: config.corpus.profile === 'formal' ? '全文片段' : '篇',
  };
}

export async function initRag({ mysqlReady }) {
  Object.assign(state, { engine: 'none', papers: [], index: null, count: 0, disciplines: [], loadedAt: null, corpusId: null, manifest: null });
  // A running MySQL instance must not silently reactivate the replaced CSL table.
  if (mysqlReady && config.corpus.profile === 'legacy-csl') {
    try {
      const rows = await query(`SELECT COUNT(*) AS n FROM papers`);
      state.count = Number(rows[0]?.n || 0);
      const d = await query(`SELECT discipline, COUNT(*) AS n FROM papers GROUP BY discipline ORDER BY n DESC`);
      state.disciplines = d.map((r) => ({ name: r.discipline, count: Number(r.n) }));
      state.engine = state.count > 0 ? 'mysql-fulltext' : 'empty';
      state.corpusId = 'legacy-csl:mysql';
      state.loadedAt = new Date().toISOString();
      return ragStatus();
    } catch (err) {
      console.warn(`[rag] MySQL 文献库不可用：${err.message}`);
    }
  }

  try {
    const raw = await fs.readFile(config.corpus.jsonl, 'utf8');
    state.corpusId = crypto.createHash('sha256').update(raw.replace(/\r\n?/g, '\n')).digest('hex');
    if (config.corpus.manifest) {
      state.manifest = JSON.parse(await fs.readFile(config.corpus.manifest, 'utf8'));
      if (config.corpus.profile === 'formal' && (state.manifest.profile !== 'formal' || !/^[a-f0-9]{64}$/.test(state.manifest.contentSha256 || '') || !Number.isSafeInteger(state.manifest.sectionCount) || state.manifest.sectionCount <= 0)) throw new Error('corpus_manifest_invalid');
      if (state.manifest.contentSha256 && state.manifest.contentSha256 !== state.corpusId) throw new Error('corpus_manifest_hash_mismatch');
    }
    // 无数据库时用进程内索引，控制规模避免托管环境内存溢出
    const limit = config.corpus.profile === 'formal' ? Infinity : Number(process.env.FILE_INDEX_LIMIT || 6000);
    const indexed = [];
    for (const line of raw.split('\n')) {
      if (indexed.length >= limit) break;
      if (!line.trim()) continue;
      try {
        const paper = JSON.parse(line);
        if (!Number.isSafeInteger(Number(paper.id)) || typeof paper.title !== 'string' || typeof paper.abstract !== 'string') throw new Error('invalid_corpus_record');
        if (config.corpus.profile === 'legacy-csl') paper.evidenceLevel = 'abstract';
        indexed.push(paper);
      } catch (err) {
        if (config.corpus.profile === 'formal') throw err;
        /* 跳过坏行 */
      }
    }
    if (new Set(indexed.map((p) => String(Number(p.id)))).size !== indexed.length) throw new Error('duplicate_corpus_id');
    if (config.corpus.profile === 'formal' && indexed.length !== state.manifest.sectionCount) throw new Error('corpus_manifest_count_mismatch');
    state.papers = indexed;
    state.count = indexed.length;
    state.index = new CompactIndex(indexed);
    const counts = new Map();
    for (const p of indexed) counts.set(p.discipline, (counts.get(p.discipline) || 0) + 1);
    state.disciplines = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    state.engine = indexed.length ? 'file-bm25' : 'empty';
    state.loadedAt = new Date().toISOString();
  } catch (err) {
    console.warn(`[rag] 语料加载失败：${err.message}`);
    Object.assign(state, { papers: [], count: 0, index: null, disciplines: [], corpusId: null, manifest: null });
    state.engine = 'empty';
  }
  return ragStatus();
}

/* ---------------------------------------------------------------- 检索 */

/** 查询中的 CJK 字符有多大比例真的出现在这篇文献里（对分词噪声更稳健） */
export function charCoverage(query, text) {
  const chars = new Set();
  for (const ch of query) if (/[\u3400-\u9fff]/.test(ch)) chars.add(ch);
  if (!chars.size) {
    if (/<->|->|\/\\|\\\/|:=|\|-/.test(query)) {
      const terms = termWeights(tokenize(query)), hay = termWeights(tokenize(text));
      return [...terms.keys()].filter(term => hay.has(term)).length / Math.max(terms.size, 1);
    }
    const terms = [...new Set(String(query).toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || [])];
    if (!terms.length) return 0;
    const hayTerms = new Set(String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) || []);
    return terms.filter((term) => hayTerms.has(term)).length / terms.length;
  }
  const hay = text;
  let hit = 0;
  for (const ch of chars) if (hay.includes(ch)) hit += 1;
  return hit / chars.size;
}

function decorate(paper, score, coverage, queryTerms) {
  const content = buildContent(paper);
  const snippet = locateSentence(paper, queryTerms, content);
  return {
    id: paper.id,
    title: paper.title,
    abstract: paper.abstract,
    discipline: paper.discipline,
    category: paper.category,
    keywords: paper.keywords,
    score: Number(score.toFixed(3)),
    coverage: Number(coverage.toFixed(3)),
    snippet: snippet.text,
    start: snippet.start,
    end: snippet.end,
    content,
    ...sourceMetadata(paper),
    corpusId: state.corpusId,
  };
}

/**
 * @param {string} q
 * @param {{k?:number, discipline?:string}} opts
 */
export async function searchPapers(q, { k = 8, discipline = '' } = {}) {
  const formal = config.corpus.profile === 'formal';
  const weights = termWeights([...tokenize(q), ...(formal ? formalExpansion(q) : [])]);
  const queryTerms = [...weights.keys()];
  if (!queryTerms.length) return { results: [], engine: state.engine, weak: true };

  if (state.engine === 'mysql-fulltext') {
    const like = `%${q.slice(0, 40)}%`;
    const params = [q, q];
    let sql = `SELECT id, title, abstract, keywords, discipline, category,
                 MATCH(title, abstract, keywords) AGAINST (? IN NATURAL LANGUAGE MODE) AS ft
               FROM papers
               WHERE MATCH(title, abstract, keywords) AGAINST (? IN NATURAL LANGUAGE MODE)`;
    if (discipline) {
      sql += ` AND discipline = ?`;
      params.push(discipline);
    }
    sql += ` ORDER BY ft DESC LIMIT 60`;

    let rows = [];
    try {
      rows = await query(sql, params);
    } catch {
      rows = [];
    }

    // ngram 对单字查询无效，退化为 LIKE
    if (!rows.length) {
      const likeParams = [`${like}`];
      let likeSql = `SELECT id, title, abstract, keywords, discipline, category, 0 AS ft FROM papers
                     WHERE (title LIKE ? OR abstract LIKE ? OR keywords LIKE ?)`;
      likeParams.push(like, like);
      if (discipline) {
        likeSql += ` AND discipline = ?`;
        likeParams.push(discipline);
      }
      likeSql += ` LIMIT 40`;
      rows = await query(likeSql, likeParams).catch(() => []);
    }

    const scored = rows.map((r) => {
      const paper = toPaper(r);
      const toks = new Set(tokenize(`${paper.title} ${paper.keywords} ${paper.abstract}`).map((t) => t.term));
      let hit = 0;
      let total = 0;
      for (const t of queryTerms) {
        total += 1;
        if (toks.has(t)) hit += 1;
      }
      const idfCoverage = total ? hit / total : 0;
      const ftScore = Number(r.ft) || 0;
      // 与文件模式对齐：字符覆盖率参与重排，避免「么做」命中「怎么做」这类巧合
      const charCov = charCoverage(q, `${paper.title}${paper.keywords}${paper.abstract}`);
      const score = (ftScore * (0.5 + idfCoverage) + idfCoverage * 2) * (0.35 + 0.65 * charCov);
      return { paper, score, coverage: charCov };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, k);
    const weak = !top.length || top[0].coverage < 0.6;
    return {
      engine: state.engine,
      weak,
      coverage: top[0]?.coverage || 0,
      results: top.map((s) => decorate(s.paper, s.score, s.coverage, queryTerms)),
    };
  }

  if (state.engine === 'file-bm25') {
    let candidates = state.index.search(
      weights,
      k * 4,
      discipline ? (paper) => paper.discipline === discipline : null
    );
    // 用字符覆盖率重排并判定相关性，避免「么做」命中「怎么做」这类巧合
    for (const c of candidates) {
      c.charCov = charCoverage(q, `${c.paper.title}${c.paper.keywords}${c.paper.abstract}`);
      c.score = c.score * (0.35 + 0.65 * c.charCov);
      if (formal) {
        const titleCoverage = charCoverage(q, c.paper.title);
        c.score *= 1 + 0.5 * titleCoverage;
        const conceptCoverage = formalConceptCoverage(q, `${c.paper.title}\n${c.paper.abstract}`);
        if (conceptCoverage != null) {
          c.score *= 0.15 + 1.85 * conceptCoverage;
          c.score *= 1 + (formalConceptCoverage(q, c.paper.title) || 0);
          c.conceptCoverage = conceptCoverage;
        }
        if (c.paper.contentRole === 'exercise') c.score *= /练习|习题|exercise/i.test(q) ? 1 : 0.45;
      }
    }
    // Zero concept coverage is already a 0.15 score penalty above; dropping those
    // candidates would also drop sections that use a synonym missing from the
    // concept list. missingConcepts below still marks such results as weak.
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, k);
    const missingConcepts = formal ? missingFormalConcepts(q, top.slice(0, 3).map((c) => `${c.paper.title}\n${c.paper.abstract}`)) : [];
    const concepts = formal ? formalConceptCoverage(q, top.slice(0, 3).map((c) => c.paper.abstract).join('\n')) : null;
    const cov = concepts != null ? (concepts + (top[0]?.charCov || 0)) / 2 : top[0]?.charCov || 0;
    const weak = !top.length || cov < 0.6 || missingConcepts.length > 0;
    return {
      engine: state.engine,
      weak,
      coverage: cov,
      ...(formal ? { missingConcepts, relevanceMethod: 'lexical-with-curated-terminology' } : {}),
      results: top.map((c) => decorate(c.paper, c.score, c.charCov, queryTerms)),
    };
  }

  return { engine: 'empty', weak: true, coverage: 0, results: [] };
}

export async function getPaper(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return null;

  if (state.engine === 'mysql-fulltext') {
    const rows = await query(`SELECT * FROM papers WHERE id = ?`, [n]);
    if (!rows.length) return null;
    const p = toPaper(rows[0]);
    return { ...p, content: buildContent(p), corpusId: state.corpusId };
  }

  const p = state.index?.byId.get(n);
  if (!p) return null;
  return { ...p, content: buildContent(p), corpusId: state.corpusId };
}

export function listDisciplines() {
  return state.disciplines;
}

export async function questionPaperTopics(discipline, round, limit) {
  if (!limit) return [];
  if (state.engine === 'mysql-fulltext') {
    const count = discipline ? state.disciplines.find(d => d.name === discipline)?.count : state.count;
    if (!count) return [];
    const take = Math.min(count, limit);
    const where = discipline ? 'WHERE discipline = ?' : '';
    return query(`SELECT id, title, keywords, category FROM papers ${where} ORDER BY id LIMIT ? OFFSET ?`,
      [...(discipline ? [discipline] : []), take, round % (count - take + 1)]);
  }
  const papers = state.papers.filter(p => (!discipline || p.discipline === discipline) && p.contentRole !== 'exercise'
    && !/^(?:引言|前言|目录|致谢|习题|练习|补充练习|参考文献)$/.test(p.section));
  const chapters = new Map();
  for (const p of papers) {
    const key = p.sourcePath || p.title;
    if (!chapters.has(key)) chapters.set(key, []);
    chapters.get(key).push(p);
  }
  const groups = [...chapters.values()];
  return groups.slice(0, limit).map((_, i) => {
    const chapter = groups[(round + i) % groups.length];
    return chapter[round % chapter.length];
  });
}

/** File names come from the indexed source manifest, never from client paths. */
export function listCorpusFiles() {
  if (state.engine === 'mysql-fulltext') {
    return [{ name: 'CSL 文献表', collection: 'MySQL', count: state.count, records: [] }];
  }
  const files = new Map();
  for (const paper of state.papers) {
    const key = paper.sourcePath || path.basename(config.corpus.jsonl);
    if (!files.has(key)) files.set(key, { name: key, collection: paper.sourceTitle || ragStatus().name, count: 0, records: [] });
    const file = files.get(key);
    file.count++;
    // Legacy CSL is a single large JSONL file. Only send its count to the catalogue.
    if (paper.sourcePath) file.records.push({ ref: String(paper.id), title: paper.title });
  }
  return [...files.values()];
}

/** 逐字校验引文是否在文献正文中 */
export async function verifyQuote(paperId, quote) {
  const paper = await getPaper(paperId);
  if (!paper) return { found: false, reason: 'paper_not_found' };
  return locateNormalizedQuote(paper.content, quote, { minLength: 6 });
}
