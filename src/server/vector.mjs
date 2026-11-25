/**
 * 向量检索层。
 *
 * 存储：Qdrant（HTTP REST，无 SDK 依赖）。Qdrant 不可用时退化为进程内向量表，
 *       保证没有向量数据库的环境也能跑通「存储 + 检索」的语义。
 * 嵌入：OpenAI 兼容的 /embeddings（OpenAI、通义、硅基流动、Ollama 均支持）。
 *
 * 出站请求统一走 node:http/https 直连，避免系统代理劫持本机服务。
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { tokenize } from '../agent/text.js';
import { readJsonOrQuarantine, withFileLock, writeJsonAtomic } from './fsutil.mjs';

const state = {
  engine: 'off', // qdrant | local | off
  ready: false,
  dim: 0,
  error: '',
  local: new Map(), // ref -> {vector, payload}
  fingerprint: '',
};

/* ---------------------------------------------------------------- HTTP */

function request(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = []; let bytes = 0;
        res.on('data', (c) => { bytes += c.length; if (bytes > 16 * 1024 * 1024) req.destroy(new Error('vector_response_too_large')); else chunks.push(c); });
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* 非 JSON 响应 */
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------------------------------------------------------- 嵌入 */

export function embeddingEnabled() {
  return config.embedding.provider !== 'off' && (config.embedding.provider === 'local' || Boolean(config.embedding.baseUrl));
}
export const vectorChannelWeight = () => config.embedding.provider === 'local' && !config.embedding.baseUrl ? 0.3 : 1;

/**
 * 内置哈希嵌入：把分词结果哈希到固定维度并做 L2 归一化。
 * 它不是语义模型，只能反映词面重合度，但让向量通道在完全离线时依然可用；
 * 配好 EMBEDDING_BASE_URL 后会自动切换为真正的语义嵌入。
 */
function localEmbed(texts, dim) {
  return texts.map((text) => {
    const vec = new Float64Array(dim);
    const counts = new Map();
    // Versioned separately from remote embeddings: CJK line-wrap normalization
    // changes this lexical hash space even with formal syntax tokens disabled.
    for (const { term } of tokenize(String(text || ''), { formalSyntax: false })) counts.set(term, (counts.get(term) || 0) + 1);
    for (const [term, tf] of counts) {
      let h = 0x811c9dc5;
      for (let i = 0; i < term.length; i++) {
        h ^= term.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      const idx = h % dim;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      vec[idx] += sign * (1 + Math.log(tf));
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Array(dim);
    for (let i = 0; i < dim; i++) out[i] = vec[i] / norm;
    return out;
  });
}

/**
 * 把 ref 映射成 Qdrant 可接受的整数 ID。
 * 压到 52 位以内，保证 JSON 数值不丢精度（Qdrant 只收无符号整数或 UUID）。
 */
function pointId(ref) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (const ch of Buffer.from(String(ref), 'utf8')) {
    h ^= BigInt(ch);
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return Number(h & 0x1fffffffffffffn);
}

/**
 * 批量嵌入。
 * @param {string[]} texts
 * @param {{baseUrl?:string, apiKey?:string, model?:string, dim?:number}} override
 */
export async function embed(texts, override = {}) {
  const baseUrl = (override.baseUrl || config.embedding.baseUrl || '').replace(/\/$/, '');
  const apiKey = override.apiKey ?? config.embedding.apiKey;
  const model = override.model || config.embedding.model;
  if (!texts.length) return [];

  const provider = override.provider || config.embedding.provider;
  // Never silently turn a failed semantic model into hash vectors in the same index.
  if (!baseUrl) {
    if (provider !== 'local') throw new Error('embedding_not_configured');
    const vecs = localEmbed(texts, config.embedding.dim);
    if (!state.dim) state.dim = config.embedding.dim;
    return vecs;
  }

  const out = [];
  const batch = Math.max(1, config.embedding.batch);
  for (let i = 0; i < texts.length; i += batch) {
    const slice = texts.slice(i, i + batch);
    const res = await request(`${baseUrl}/${provider === 'service' ? 'embed' : 'embeddings'}`, {
      method: 'POST',
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      body: { model, input: slice, ...(provider === 'service' && config.embedding.revision ? { revision: config.embedding.revision } : {}) },
      timeout: 60000,
    });
    if (provider === 'service' && res.status === 200 && (res.json?.model !== model || (config.embedding.revision && res.json?.revision !== config.embedding.revision))) throw new Error('embedding_model_identity_mismatch');
    if (res.status < 200 || res.status >= 300) {
      const msg = res.json?.error?.message || res.text.slice(0, 160) || `HTTP ${res.status}`;
      throw new Error(`embedding_failed: ${msg}`);
    }
    const raw = res.json?.data || res.json?.embeddings || [];
    if (!Array.isArray(raw)) throw new Error('embedding_invalid_response');
    const indexed = raw.some((item) => item && !Array.isArray(item) && Object.hasOwn(item, 'index'));
    if (indexed && !raw.every((item) => Number.isInteger(item?.index))) {
      throw new Error('embedding_invalid_index');
    }
    const data = indexed ? [...raw].sort((a, b) => a.index - b.index) : raw;
    if (data.length !== slice.length) throw new Error(`embedding_count_mismatch: ${data.length}/${slice.length}`);
    if (indexed && data.some((item, index) => item.index !== index)) throw new Error('embedding_index_mismatch');
    for (const item of data) {
      const vec = item.embedding || item;
      if (!Array.isArray(vec) || !vec.length || vec.some((n) => !Number.isFinite(n))) {
        throw new Error('embedding_invalid_vector');
      }
      out.push(vec);
    }
  }
  if (out.length !== texts.length) throw new Error(`embedding_count_mismatch: ${out.length}/${texts.length}`);
  if (out.some((v) => v.length !== out[0].length)) throw new Error('embedding_dimension_mismatch');
  if (!state.dim) state.dim = out[0].length;
  return out;
}

/* ---------------------------------------------------------------- Qdrant */

const qHeaders = () => (config.qdrant.apiKey ? { 'api-key': config.qdrant.apiKey } : {});

async function qdrant(pathname, opts = {}) {
  const res = await request(`${config.qdrant.url}${pathname}`, {
    timeout: 8000,
    ...opts,
    headers: { ...qHeaders(), ...(opts.headers || {}) },
  });
  if (res.status >= 400) {
    const msg = res.json?.status?.error || res.text.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(`qdrant: ${msg}`);
  }
  return res.json;
}

async function ensureCollection(dim) {
  const name = config.qdrant.collection;
  const info = await qdrant(`/collections/${encodeURIComponent(name)}`).catch(() => null);
  if (info?.result) {
    const size = info.result.config?.params?.vectors?.size;
    if (size && size !== dim) {
      throw new Error(`向量维度不匹配：集合 ${name} 为 ${size}，当前模型输出 ${dim}`);
    }
    return;
  }
  await qdrant(`/collections/${encodeURIComponent(name)}`, {
    method: 'PUT',
    body: { vectors: { size: dim, distance: 'Cosine' } },
  });
}

/* ---------------------------------------------------------------- 本地兜底 */

async function loadLocal() {
  const data = await readJsonOrQuarantine(config.vectorFile, null);
  if (!data) return;
  if (data.version === 2 && data.points && typeof data.points === 'object') {
    state.fingerprint = String(data.fingerprint || '');
    state.dim = Number(data.dim || 0);
    for (const [k, v] of Object.entries(data.points)) state.local.set(k, v);
  } else {
    state.error = '检测到旧版无模型指纹的向量索引，请执行“重建向量”';
  }
}

async function saveLocal(next = state.local, fingerprint = state.fingerprint, dim = state.dim) {
  await writeJsonAtomic(config.vectorFile, {
    version: 2,
    fingerprint,
    dim,
    points: Object.fromEntries(next),
  });
}

function embeddingFingerprint(override = {}, dim = 0) {
  const baseUrl = String(override.baseUrl || config.embedding.baseUrl || '').replace(/\/$/, '').toLowerCase();
  const provider = baseUrl ? String(override.provider || config.embedding.provider || 'remote') : 'local-hash';
  const model = baseUrl ? String(override.model || config.embedding.model || '') : `hash-${config.embedding.dim}`;
  // PDF-wrap tokenization changed in F7: preserve the old file but never mix its
  // old hash space with new vectors. Semantic deployments can pin a revision.
  const preprocessing = baseUrl ? 'preprocess-v1' : 'preprocess-v2-cjk-linewrap';
  const descriptor = `${provider}\n${baseUrl}\n${model}\n${dim}\n${preprocessing}${config.embedding.revision ? '\n' + config.embedding.revision : ''}`;
  return crypto.createHash('sha256').update(descriptor).digest('hex').slice(0, 24);
}

/* ---------------------------------------------------------------- 初始化 */

export async function initVector() {
  if (config.qdrant.enabled) {
    try {
      const r = await qdrant('/', { timeout: 3000 });
      state.engine = 'qdrant';
      state.ready = true;
      state.error = '';
      return { ...vectorStatus(), version: r?.version || '' };
    } catch (err) {
      state.error = String(err.message || err);
      console.warn(`[vector] Qdrant 不可用，退化为本地向量表：${state.error}`);
    }
  }
  await loadLocal();
  state.engine = state.local.size || embeddingEnabled() ? 'local' : 'off';
  state.ready = embeddingEnabled();
  return vectorStatus();
}

export function vectorStatus() {
  const expectedFingerprint=embeddingFingerprint({},state.dim || config.embedding.dim);
  const stalePoints=state.engine==='local'?[...state.local.values()].filter(point=>point.payload?._embeddingFingerprint!==expectedFingerprint).length:undefined;
  return {
    engine: state.engine,
    ready: state.ready,
    dim: state.dim || config.embedding.dim,
    collection: config.qdrant.collection,
    embedding: embeddingEnabled()
      ? config.embedding.baseUrl
        ? config.embedding.model
        : `local-hash-${config.embedding.dim}`
      : null,
    provider: config.embedding.provider,
    fingerprint: state.fingerprint || undefined,
    points: state.engine === 'local' ? state.local.size : undefined,
    error: state.error || undefined,
    semantic: vectorChannelWeight() === 1 && embeddingEnabled(),
    channelWeight: vectorChannelWeight(),
    requiresReindex: Boolean(stalePoints || (state.fingerprint && state.fingerprint !== expectedFingerprint)),
    stalePoints,
  };
}

/* ---------------------------------------------------------------- 写入 */

/**
 * 写入向量。
 * @param {Array<{ref:string, text:string, payload:object}>} items
 * @param {{baseUrl?:string, apiKey?:string, model?:string}} embedOverride
 */
export async function upsertVectors(items, embedOverride = {}) {
  if (!items.length) return { upserted: 0 };
  if (!embeddingEnabled() && !embedOverride.baseUrl) throw new Error('embedding_not_configured');

  const vectors = await embed(items.map((x) => x.text), embedOverride);
  const dim = vectors[0].length;
  const fingerprint = embeddingFingerprint(embedOverride, dim);

  if (state.engine === 'qdrant') {
    await ensureCollection(dim);
    const points = items.map((it, i) => ({
      id: pointId(it.ref),
      vector: vectors[i],
      payload: { ...it.payload, ref: it.ref, _embeddingFingerprint: fingerprint },
    }));
    await qdrant(`/collections/${encodeURIComponent(config.qdrant.collection)}/points?wait=true`, {
      method: 'PUT',
      body: { points },
    });
    return { upserted: points.length, dim };
  }

  if (state.engine === 'local') {
    await withFileLock(config.vectorFile, async () => {
      const next = new Map(state.local);
      for (let i = 0; i < items.length; i++) {
        next.set(items[i].ref, {
          vector: vectors[i],
          payload: { ...items[i].payload, ref: items[i].ref, _embeddingFingerprint: fingerprint },
        });
      }
      await saveLocal(next, fingerprint, dim);
      state.local = next;
      state.fingerprint = fingerprint;
      state.dim = dim;
      state.error = '';
    });
    return { upserted: items.length, dim };
  }

  throw new Error('vector_engine_unavailable');
}

/* ---------------------------------------------------------------- 检索 */

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = a.length;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * 向量检索。
 * @param {string} q
 * @param {{userId?:string, k?:number, kind?:string, baseUrl?:string, apiKey?:string, model?:string, paperCorpusId?:string}} opts
 */
export async function searchVectors(q, opts = {}) {
  const { userId = null, k = 20, kind = null, minScore = 0.12, paperCorpusId, docIds = null, includePublicPapers = false } = opts;
  if (docIds?.length === 0) return { results: [], engine: state.engine };
  if (!embeddingEnabled() && !opts.baseUrl) return { results: [], engine: state.engine };

  const [vec] = await embed([q], opts);
  if (!vec) return { results: [], engine: state.engine };
  const fingerprint = embeddingFingerprint(opts, vec.length);

  if (state.engine === 'qdrant') {
    const must = [];
    if (userId) must.push(includePublicPapers ? {should:[{key:'userId',match:{value:userId}},{key:'kind',match:{value:'paper'}}]} : { key: 'userId', match: { value: userId } });
    if (kind) must.push({ key: 'kind', match: { value: kind } });
    if (docIds) must.push({ key: 'docId', match: { any: docIds } });
    must.push({ key: '_embeddingFingerprint', match: { value: fingerprint } });
    // Exclude stale paper vectors before top-k selection, while retaining private documents.
    const mustNot = paperCorpusId === undefined ? [] : paperCorpusId
      ? [{ must: [{ key: 'kind', match: { value: 'paper' } }], must_not: [{ key: 'corpusId', match: { value: paperCorpusId } }] }]
      : [{ key: 'kind', match: { value: 'paper' } }];
    const body = {
      vector: vec,
      limit: k,
      with_payload: true,
      filter: { must, ...(mustNot.length ? { must_not: mustNot } : {}) },
    };
    const r = await qdrant(`/collections/${encodeURIComponent(config.qdrant.collection)}/points/search`, {
      method: 'POST',
      body,
    });
    return {
      engine: 'qdrant',
      results: (r?.result || [])
        .filter((x) => x.score >= minScore)
        .map((x) => ({ ref: x.payload?.ref, score: x.score, payload: x.payload })),
    };
  }

  const scored = [];
  const allowedDocs = docIds && new Set(docIds);
  for (const [ref, v] of state.local) {
    if (v.payload?._embeddingFingerprint !== fingerprint) continue;
    if (userId && v.payload?.userId !== userId && !(includePublicPapers && v.payload?.kind === 'paper')) continue;
    if (kind && v.payload?.kind !== kind) continue;
    if (allowedDocs && !allowedDocs.has(v.payload?.docId)) continue;
    if (paperCorpusId !== undefined && v.payload?.kind === 'paper' && (!paperCorpusId || v.payload.corpusId !== paperCorpusId)) continue;
    scored.push({ ref, score: cosine(vec, v.vector), payload: v.payload });
  }
  scored.sort((a, b) => b.score - a.score);
  return { engine: 'local', results: scored.filter((x) => x.score >= minScore).slice(0, k) };
}

/** 删除某文档的全部向量 */
export async function deleteVectorsByDoc(docId) {
  if (state.engine === 'qdrant') {
    await qdrant(`/collections/${encodeURIComponent(config.qdrant.collection)}/points/delete?wait=true`, {
      method: 'POST',
      body: { filter: { must: [{ key: 'docId', match: { value: docId } }] } },
    });
    return true;
  }
  if (state.engine === 'local') {
    return withFileLock(config.vectorFile, async () => {
      const next = new Map(state.local);
      let n = 0;
      for (const [ref, v] of [...next]) {
        if (v.payload?.docId === docId) {
          next.delete(ref);
          n += 1;
        }
      }
      if (n) {
        await saveLocal(next);
        state.local = next;
      }
      return n > 0;
    });
  }
  return false;
}

export const __test = { pointId, cosine };
