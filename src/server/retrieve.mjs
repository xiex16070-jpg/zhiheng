/**
 * 多通道检索与融合。
 *
 * 四个通道各自独立召回，再用 RRF（Reciprocal Rank Fusion）合并：
 *   paper   —— CSL 4 万篇论文（MySQL ngram 全文索引）
 *   kb      —— 用户上传文档的片段（ngram 全文索引，句/段级）
 *   vector  —— Qdrant 向量召回（或本地向量表）
 *   external—— RAGFlow 外部知识源（MCP / REST）
 *
 * RRF 的好处是不用关心各通道分数量纲：只看排名，天然抗分数尺度差异。
 */

import { config } from './config.mjs';
import { searchPapers, charCoverage, getPaper, ragStatus, sourceMetadata, locateSentence } from './rag.mjs';
import { getDocument, getChunkById, searchChunks, isSectionId, sectionDocIds } from './kb.mjs';
import { searchVectors, embeddingEnabled, vectorChannelWeight } from './vector.mjs';
import { searchExternal, ragflowStatus } from './ragflow.mjs';
import { streamChat, isRateLimited } from './llm.mjs';
import { clip, tokenize } from '../agent/text.js';
import { rerankCandidates, rerankSettings } from './rerank.mjs';
import { formalConceptCoverage, missingFormalConcepts } from './formal-query.mjs';
import { withTraceSpan } from './tracing.mjs';
import { searchConclusionSources } from './knowledge-conclusions.mjs';

/* ---------------------------------------------------------------- 归一化 */

function fromPaper(p) {
  return {
    ref: String(p.id),
    kind: 'paper',
    title: p.title,
    docName: p.title,
    heading: '',
    snippet: p.snippet,
    content: p.content,
    start: p.start,
    end: p.end,
    locatable: true,
    discipline: p.discipline,
    category: p.category,
    keywords: p.keywords,
    ...sourceMetadata(p),
    corpusId: p.corpusId,
    docId: p.sourcePath ? `${p.sourceRevision}:${p.sourcePath}` : undefined,
    coverage: p.coverage,
    rawScore: p.score,
  };
}

function fromChunk(c) {
  return {
    ref: c.id,
    kind: 'doc',
    title: c.docName || '上传文档',
    docName: c.docName || '',
    heading: c.heading || '',
    snippet: clip(c.text, 260),
    content: c.text,
    start: c.start,
    end: c.end,
    locatable: true,
    docId: c.docId,
    rawScore: c.score,
  };
}

function fromVector(hit) {
  const p = hit.payload || {};
  // MCP 记忆（qdrant-store 写入的笔记）不属于知识库证据，
  // 混进问答证据里等于允许通过 MCP 向用户的回答注入内容
  if (p.kind === 'memory') return null;
  if (p.kind === 'paper') {
    return {
      ref: String(p.parentRef || p.ref),
      kind: 'paper',
      title: p.title || '',
      docName: p.title || '',
      heading: '',
      snippet: clip(p.text || '', 260),
      content: p.text || '',
      start: p.start || 0,
      end: p.end || 0,
      locatable: Boolean(p.start || p.end),
      discipline: p.discipline || '',
      corpusId: p.corpusId,
      vectorWindow: p.parentRef ? { start: p.start, end: p.end, text: p.text } : undefined,
      rawScore: hit.score,
    };
  }
  return {
    ref: p.ref || hit.ref,
    kind: p.kind === 'external' ? 'external' : 'doc',
    title: p.docName || p.title || '上传文档',
    docName: p.docName || '',
    heading: p.heading || '',
    snippet: clip(p.text || '', 260),
    content: p.text || '',
    start: p.start || 0,
    end: p.end || 0,
    locatable: p.locatable !== false && Boolean(p.start || p.end),
    docId: p.docId,
    source: p.source,
    rawScore: hit.score,
  };
}

/* ---------------------------------------------------------------- 查询改写 */

const REWRITE_PROMPT = `你是中文文献检索的查询改写器。
把用户问题改写成 3 条更适合检索的查询：保留专业术语，去掉口语虚词，可补充同义表述。
若问题是多跳的（如「A 通过什么机制导致 B」「X 的方法能否用于 Y」），其中至少一条要检索中间概念/桥接术语（机制、方法、影响因素本身），而不是只检索首尾两端。
只输出 JSON 字符串数组，例如 ["查询1","查询2","查询3"]，不要任何解释。`;

/** 用 LLM 生成查询变体；失败或超时一律返回空数组，不影响主流程 */
export async function rewriteQueries(question, provider, signal, timeoutMs = 12000) {
  if (!provider) return [];
  // 账号刚被限流时跳过改写：这是可选调用，把配额留给主回答
  if (isRateLimited(provider)) return [];
  const q = String(question || '').trim();
  if (!q || q.length < 2) return [];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  let timerId;
  const timer = new Promise((resolve) => {
    timerId = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const run = streamChat({
    provider,
    messages: [
      { role: 'system', content: REWRITE_PROMPT },
      { role: 'user', content: q },
    ],
    temperature: 0.3,
    signal: controller.signal,
  }).catch(() => null);

  const res = await Promise.race([run, timer]);
  clearTimeout(timerId);
  signal?.removeEventListener('abort', onAbort);
  if (!res?.content) return [];

  const text = res.content.trim();
  const jsonMatch = /\[[\s\S]*\]/.exec(text);
  if (!jsonMatch) return [];
  try {
    const arr = JSON.parse(jsonMatch[0]);
    return [...new Set(arr
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim())
      .filter((x) => x.length >= 2 && x.length <= 60 && x !== q))]
      .slice(0, 3);
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------- 融合 */

export function fuse(lists, rrfK, k, maxPerDoc = 3) {
  const merged = new Map();
  for (const list of lists) {
    list.items.forEach((item, i) => {
      const cur = merged.get(item.ref) || { item, rrf: 0, votes: new Map() };
      // Query rewrites from one channel contribute that channel's best rank.
      const vote = (list.weight ?? 1) / (rrfK + i + 1);
      const prior = cur.votes.get(list.name) || 0;
      if (vote > prior) {
        cur.votes.set(list.name, vote);
        cur.rrf += vote - prior;
      }
      // 保留信息更全的那份（片段比向量 payload 更准）
      if ((item.content?.length || 0) > (cur.item.content?.length || 0)) cur.item = item;
      merged.set(item.ref, cur);
    });
  }

  const ordered = [...merged.values()].sort((a, b) => b.rrf - a.rrf);
  const perDoc = new Map();
  const out = [];
  for (const entry of ordered) {
    const docKey = entry.item.docId || entry.item.ref;
    const n = perDoc.get(docKey) || 0;
    if (n >= maxPerDoc) continue; // 默认同一文档最多保留 3 段
    perDoc.set(docKey, n + 1);
    out.push({ ...entry.item, rrf: Number(entry.rrf.toFixed(5)), channels: [...entry.votes.keys()] });
    if (out.length >= k) break;
  }
  return out;
}

/* ---------------------------------------------------------------- 主入口 */

/**
 * @param {string} question
 * @param {{userId?:string, k?:number, discipline?:string, provider?:object,
 *          signal?:AbortSignal, rewrite?:boolean, channels?:string[], sourceKind?:'paper'|'doc'|null}} opts
 */
export function retrieveAll(question, opts = {}) {
  return withTraceSpan('retrieval.search', (span) => retrieve(question, opts, span));
}

async function retrieve(question, opts, span) {
  const {
    userId = null,
    k = 8,
    discipline = '',
    provider = null,
    signal = null,
    rewrite = true,
    channels = ['paper', 'kb', 'vector', 'external'],
    sourceKind = null,
  } = opts;

  const q = String(question || '').trim();
  const stats = new Map(); // name -> {name, hits, ms, lists, error}
  const lists = [];
  if (!q) {
    span.setOutcome('empty');
    return { results: [], channels: [], coverage: 0, weak: true, queries: [] };
  }

  const want = new Set(channels);
  const docIds = Array.isArray(opts.scopedDocIds) ? opts.scopedDocIds : isSectionId(discipline) ? await sectionDocIds(userId, discipline) : null;
  if (docIds) {
    want.delete('paper');
    want.delete('external');
    if (sourceKind === 'paper') want.clear();
  }
  const rerankConfig = rerankSettings();
  const finalK = Math.max(1, Math.min(100, Number(k) || 8));
  const candidateK = rerankConfig.enabled ? Math.max(finalK, rerankConfig.candidateK) : finalK;

  // 查询变体：原问题 + LLM 改写
  let variants = [q];
  if (rewrite && provider) {
    const t0 = Date.now();
    const extra = await rewriteQueries(q, provider, signal);
    stats.set('rewrite', { name: 'rewrite', hits: extra.length, ms: Date.now() - t0, note: extra.join(' | ') });
    variants = [q, ...extra];
  }

  const runList = async (name, ordinal, fn) => {
    const t0 = Date.now();
    try {
      if (signal?.aborted) throw new Error('aborted');
      const items = await fn();
      return { name, ordinal, items, ms: Date.now() - t0 };
    } catch (err) {
      return { name, ordinal, items: [], ms: Date.now() - t0, error: String(err.message || err) };
    }
  };

  // 各通道独立并发；ordinal 保证完成先后不会改变 RRF 的稳定排序。
  const jobs = [];
  let ordinal = 0;
  if (want.has('paper') && sourceKind !== 'doc') {
    for (const v of variants) {
      jobs.push(runList('paper', ordinal++, async () => {
        const r = await searchPapers(v, { k: config.retrieval.paperTopK, discipline });
        return r.results.map(fromPaper);
      }));
    }
  }

  if (want.has('kb') && userId && sourceKind !== 'paper') {
    for (const v of variants) {
      jobs.push(runList('kb', ordinal++, async () => {
        const r = await searchChunks(v, { userId, k: config.retrieval.chunkTopK, docIds });
        return r.map(fromChunk);
      }));
    }
    // Summaries are routing hints only. The derived index revalidates the owned
    // dialogue and exact source version, then returns the original passages.
    jobs.push(runList('kb', ordinal++, async () => (await searchConclusionSources(q, { userId, docIds, k: 4 })).map(fromChunk)));
  }

  // 向量通道：只对原问题做一次（嵌入成本较高）
  if (want.has('vector') && embeddingEnabled()) {
    jobs.push(runList('vector', ordinal++, async () => {
      const r = await searchVectors(q, {
        userId: sourceKind === 'paper' ? null : userId,
        kind: docIds ? 'doc' : sourceKind || null,
        docIds,
        paperCorpusId: ragStatus().corpusId || '',
        includePublicPapers: !docIds && sourceKind !== 'doc',
        k: config.retrieval.vectorTopK,
      });
      const normalized = r.results.map(fromVector).filter(Boolean);
      const checked = await Promise.all(normalized.map(async (item) => {
        if (docIds && (item.kind !== 'doc' || !docIds.includes(item.docId))) return null;
        if (sourceKind && item.kind !== sourceKind) return null;
        if (item.kind === 'paper' && discipline && item.discipline !== discipline) return null;
        if (item.kind === 'paper') {
          // Vectors outlive corpus replacements. Only current, resolvable sources may be evidence.
          if (item.corpusId !== ragStatus().corpusId) return null;
          const paper = await getPaper(item.ref);
          if (!paper) return null;
          const w = item.vectorWindow;
          // Children are search-only: citations keep the existing parent ID and
          // offsets must still resolve exactly against the current parent text.
          if (w && (!Number.isInteger(w.start) || !Number.isInteger(w.end) || w.start < 0 || w.end > paper.content.length || paper.content.slice(w.start, w.end) !== w.text)) return null;
          const location = w ? {text:w.text,start:w.start,end:w.end} : locateSentence(paper, tokenize(q).map((term) => term.term), paper.content);
          return fromPaper({ ...paper, snippet: location.text, start: location.start, end: location.end, score: item.rawScore });
        }
        if (item.kind !== 'doc') return item;
        if (!item.docId || !userId) return null;
        if (docIds) {
          const chunk = await getChunkById(item.ref, userId);
          return chunk && chunk.docId === item.docId ? fromChunk({ ...chunk, score: item.rawScore }) : null;
        }
        return (await getDocument(item.docId, userId === '*' ? null : userId)) ? item : null;
      }));
      return checked.filter(Boolean);
    }));
  }

  // 外部知识源
  if (want.has('external') && !sourceKind && ragflowStatus().ready) {
    jobs.push(runList('external', ordinal++, async () => {
      const r = await searchExternal(q, { k: config.retrieval.externalTopK });
      return r.results;
    }));
  }

  const completed = (await Promise.all(jobs)).sort((a, b) => a.ordinal - b.ordinal);
  for (const entry of completed) {
    lists.push({ name: entry.name, items: entry.items, weight: entry.name === 'vector' ? vectorChannelWeight() : 1 });
    const cur = stats.get(entry.name) || { name: entry.name, hits: 0, ms: 0, lists: 0 };
    cur.hits += entry.items.length;
    cur.ms += entry.ms;
    cur.lists += 1;
    if (entry.error) cur.error = entry.error;
    if (entry.name === 'vector') { cur.weight = vectorChannelWeight(); cur.semantic = cur.weight === 1; if (entry.error) cur.note = '向量服务不可用，本轮已回退到其他检索通道。'; }
    stats.set(entry.name, cur);
  }

  const baseline = fuse(lists, config.retrieval.rrfK, finalK);
  const candidates = [...baseline];
  if (rerankConfig.enabled && candidates.length < candidateK) {
    // Reserve the diverse baseline before adding deeper matches. Otherwise one
    // document can fill the pool and the final per-document cap leaves holes.
    const selected = new Set(candidates.map((item) => item.ref));
    for (const item of fuse(lists, config.retrieval.rrfK, candidateK, Infinity)) {
      if (candidates.length >= candidateK) break;
      if (selected.has(item.ref)) continue;
      selected.add(item.ref);
      candidates.push(item);
    }
  }
  const reranked = await rerankCandidates(q, candidates, { signal });
  // All successful results have a semantic score; failures keep the RRF baseline.
  const ranked = reranked.applied ? reranked.results : baseline;
  const perDoc = new Map();
  const results = [];
  for (const item of ranked) {
    const key = item.docId || item.ref;
    const count = perDoc.get(key) || 0;
    if (count >= 3) continue;
    perDoc.set(key, count + 1);
    results.push(item);
    if (results.length >= finalK) break;
  }
  const rerank = {
    enabled: rerankConfig.enabled,
    applied: reranked.applied,
    candidates: candidates.length,
    ms: reranked.ms,
    ...(reranked.model ? { model: reranked.model } : {}),
    ...(reranked.reason ? { reason: reranked.reason } : {}),
  };
  if (rerankConfig.enabled) stats.set('rerank', { name: 'rerank', hits: results.length, ...rerank });
  for (const item of results) item.coverage = Number(charCoverage(q, `${item.title}${item.keywords || ''}${item.content}`).toFixed(3));
  const leading = results.slice(0, 3);
  let coverage = leading.length ? Math.max(...leading.map((r) => r.coverage)) : 0;
  const formalOnly = ragStatus().profile === 'formal' && leading.every((r) => r.kind === 'paper');
  const missingConcepts = formalOnly ? missingFormalConcepts(q, leading.map((r) => r.content)) : [];
  const conceptCoverage = formalOnly ? formalConceptCoverage(q, leading.map((r) => r.content).join('\n')) : null;
  if (conceptCoverage != null) coverage = (coverage + conceptCoverage) / 2;
  const weak = !leading.length || coverage < 0.55 || missingConcepts.length > 0;

  if (signal?.aborted) span.setOutcome('cancelled');
  else if (completed.some((entry) => entry.error) ||
    (rerank.enabled && !rerank.applied && rerank.reason !== 'too_few_candidates')) span.setOutcome('degraded');
  else if (!results.length) span.setOutcome('empty');
  else if (weak) span.setOutcome('weak');

  return {
    results,
    channels: [...stats.values()],
    coverage: Number(coverage.toFixed(3)),
    weak,
    ...(formalOnly ? { missingConcepts } : {}),
    queries: variants,
    engine: reranked.applied ? 'rrf+rerank' : 'rrf',
    rerank,
  };
}

/** 供 UI / 工具层展示的通道概况 */
export function retrievalStatus() {
  return {
    engine: 'rrf',
    rrfK: config.retrieval.rrfK,
    vector: embeddingEnabled(),
    external: ragflowStatus(),
    rerank: { enabled: rerankSettings().enabled, model: rerankSettings().model, candidateK: rerankSettings().candidateK },
  };
}
