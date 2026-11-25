/**
 * 外部文献检索（keyless 公共 API）：Europe PMC（含 PubMed/PMC/预印本）与 arXiv。
 *
 * 为什么单独成模块：
 * - 本地计算机科学与形式逻辑文献库 + 用户文档，需要补充外部与新近研究；
 * - Hermes 的 `arxiv`、Codex 的 `life-science-research`（NCBI/PMC/bioRxiv）都指向这一需求；
 * - 两者都是无需 Key 的公共 REST，适合默认开启（可关）。
 *
 * 边界：
 * - 只查固定端点，不接受用户给 URL（不引入新的 SSRF 面）；
 * - 通用工具返回外部记录；联合研究模式另行纳入统一引用快照；
 * - 超时 15s、条数上限 10、摘要截断，避免把上下文塞爆。
 */
import { config } from './config.mjs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const TIMEOUT_MS = 15000;
const MAX_BYTES = 2 * 1024 * 1024;
const responseCache = new Map(), cooldowns = new Map();
export function clearScholarCache() { responseCache.clear(); cooldowns.clear(); }

function clip(s, n) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
}

// Keep contributor boundaries when the provider supplies them. The display string
// is sometimes clipped or comma-delimited and cannot reliably be split back into names.
function contributors(names, convert) {
  if (!Array.isArray(names) || !names.length) return {};
  const authorList = names.slice(0, 32).map(convert).filter(name => name.literal || name.family || name.given);
  return { authorList, authorsTruncated: names.length > 32 };
}
const namedContributor = name => ({ literal: clip(name, 160) });

export async function fetchScholarBody(url, fetchImpl, signal, accept, headers = {}, { cacheResponse = true } = {}) {
  signal?.throwIfAborted();
  const cached = fetchImpl === globalThis.fetch;
  const identity = new URL(url).origin + ':' + crypto.createHash('sha256').update(headers.authorization || headers['x-api-key'] || '').digest('hex');
  const cacheKey = crypto.createHash('sha256').update(url + JSON.stringify(headers)).digest('hex');
  const entry = responseCache.get(cacheKey);
  if (cacheResponse && cached && entry?.until > Date.now()) return entry.text;
  const cooldown = cooldowns.get(identity);
  if (cached && cooldown?.until > Date.now()) throw Object.assign(new Error('HTTP ' + cooldown.status), { status: cooldown.status, retryAfter: Math.ceil((cooldown.until - Date.now()) / 1000) });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const request = () => fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept, 'user-agent': 'CSL-KB-Agent/1.0 (literature search)', ...headers },
    });
    let res = await request();
    if ([502, 503, 504].includes(res.status)) {
      await res.body?.cancel?.();
      await delay(400, undefined, { signal: controller.signal });
      res = await request();
    }
    if (!res.ok) {
      const retry = res.headers?.get('retry-after');
      const seconds = Math.min(3600, Math.max(1, Number(retry) || Math.ceil((Date.parse(retry) - Date.now()) / 1000) || (res.status === 429 ? 60 : 20)));
      if (cached && [429, 503].includes(res.status)) {
        if (cooldowns.size > 32) cooldowns.delete(cooldowns.keys().next().value);
        cooldowns.set(identity, { until: Date.now() + seconds * 1000, status: res.status });
      }
      await res.body?.cancel?.();
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status, retryAfter: seconds });
    }
    if (Number(res.headers?.get('content-length')) > MAX_BYTES) {
      controller.abort();
      throw new Error('响应体超过 2 MiB');
    }
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('响应体超过 2 MiB');
      signal?.throwIfAborted();
      return text;
    }
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new Error('响应体超过 2 MiB');
        }
        chunks.push(value);
      }
      signal?.throwIfAborted();
      const text = Buffer.concat(chunks).toString('utf8');
      if (cacheResponse && cached) {
        if (responseCache.size >= 32) responseCache.delete(responseCache.keys().next().value);
        responseCache.set(cacheKey, { text, until: Date.now() + 300000 });
      }
      return text;
    } finally { reader.releaseLock(); }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Europe PMC：覆盖 PubMed/PMC/预印本/专利，keyless */
export async function searchEuropePmc(query, { limit = 8, fetchImpl = fetch, signal, abstractChars = 600 } = {}) {
  signal?.throwIfAborted();
  const q = String(query || '').trim();
  if (!q || q.length > 500) return { ok: false, reason: 'query 需为 1–500 字符' };
  const n = Math.max(1, Math.min(10, Math.floor(Number(limit)) || 8));
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(q)}&format=json&pageSize=${n}&resultType=core`;
  try {
    const data = JSON.parse(await fetchScholarBody(url, fetchImpl, signal, 'application/json'));
    if (!Array.isArray(data?.resultList?.result)) throw new Error('文献结果结构无效');
    const rows = data.resultList.result.slice(0, n).filter(r => typeof r?.title === 'string').map((r) => {
      const doi = typeof r.doi === 'string' ? clip(r.doi, 200) : '';
      const source = typeof r.source === 'string' && /^[A-Za-z][A-Za-z0-9]{1,11}$/.test(r.source) ? r.source.toUpperCase() : '';
      const rawId = typeof r.id === 'string' || Number.isSafeInteger(r.id) ? String(r.id) : '';
      const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rawId) ? rawId : '';
      // The core API identifies PubMed records by source=MED and id; pmid is
      // optional. A numeric identifier from another source is not a PMID.
      const pmidValue = r.pmid || (source === 'MED' ? id : '');
      const pmid = /^[1-9]\d{0,19}$/.test(String(pmidValue)) ? String(pmidValue) : '';
      const pmcidValue = String(r.pmcid || (source === 'PMC' ? id : '')).toUpperCase();
      const pmcid = /^PMC[1-9]\d{0,19}$/.test(pmcidValue) ? pmcidValue : '';
      let url = '';
      if (doi) url = `https://doi.org/${encodeURIComponent(doi).replace(/%2F/gi, '/')}`;
      else if (pmid) url = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
      else if (pmcid) url = `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`;
      else if (source && id && !['MED', 'PMC'].includes(source)) url = `https://europepmc.org/article/${source}/${encodeURIComponent(id)}`;
      return {
        title: clip(r.title, 300),
        authors: clip(r.authorString, 200),
        ...contributors(r.authorList?.author, a => a.lastName ? { family: clip(a.lastName, 160), given: clip(a.firstName, 160) } : namedContributor(a.collectiveName || a.fullName)),
        venue: clip(r.journalInfo?.journal?.title || r.journalTitle, 120),
        volume: clip(r.journalInfo?.volume, 24), issue: clip(r.journalInfo?.issue, 24), page: clip(r.pageInfo, 60),
        year: String(r.pubYear || '').slice(0, 4),
        doi,
        pmid,
        pmcid,
        id,
        source,
        type: clip((r.pubTypeList?.pubType || []).join(', ') || r.pubType, 100),
        publishedAt: clip(r.firstPublicationDate, 10),
        isRetracted: (r.pubTypeList?.pubType || []).some(t => /retract/i.test(t)),
        url,
        abstract: clip(r.abstractText, Math.min(4000, Math.max(600, abstractChars))),
      };
    });
    return { ok: true, source: 'europepmc', results: rows.filter((x) => x.title) };
  } catch (err) {
    signal?.throwIfAborted();
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'unavailable', status: err.status, retryAfter: err.retryAfter,
      reason: err.name === 'AbortError' ? '检索超时' : /HTTP \d{3}/.exec(err.message)?.[0] || 'Europe PMC 网络连接失败' };
  }
}

/** arXiv：Atom XML，keyless */
export function parseArxivAtom(xml, { abstractChars = 600 } = {}) {
  const out = [];
  const entries = String(xml || '').split(/<entry[\s>]/).slice(1);
  for (const raw of entries) {
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(raw);
      return m ? m[1] : '';
    };
    const decode = (s) =>
      String(s)
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const id = decode(get('id')).trim();
    if (/^https?:\/\/arxiv\.org\/api\/errors#/i.test(id)) {
      throw new Error('arXiv 查询无效：' + clip(decode(get('summary')), 200));
    }
    const authors = [...raw.matchAll(/<name[^>]*>([\s\S]*?)<\/name>/g)].map((m) => decode(m[1]).trim()).filter(Boolean);
    const title = clip(decode(get('title')), 300);
    if (!title) continue;
    out.push({
      title,
      authors: clip(authors.slice(0, 8).join(', ') + (authors.length > 8 ? ' 等' : ''), 200),
      ...contributors(authors, namedContributor),
      venue: 'arXiv',
      year: (decode(get('published')).match(/\d{4}/) || [''])[0],
      doi: clip(decode(get('arxiv:doi')), 200),
      pmid: '',
      type: 'preprint',
      publishedAt: clip(decode(get('published')), 10),
      updatedAt: clip(decode(get('updated')), 10),
      url: id.length <= 300 && /^https?:\/\/arxiv\.org\/abs\/[^\s]+$/i.test(id) ? id.replace(/^http:/i, 'https:') : '',
      abstract: clip(decode(get('summary')), Math.min(4000, Math.max(600, abstractChars))),
    });
  }
  return out;
}

export async function searchArxiv(query, { limit = 8, fetchImpl = fetch, signal, abstractChars = 600 } = {}) {
  signal?.throwIfAborted();
  const q = String(query || '').trim();
  if (!q || q.length > 500) return { ok: false, reason: 'query 需为 1–500 字符' };
  const n = Math.max(1, Math.min(10, Math.floor(Number(limit)) || 8));
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`all:${q}`)}&start=0&max_results=${n}`;
  try {
    const xml = await fetchScholarBody(url, fetchImpl, signal, 'application/atom+xml');
    const results = parseArxivAtom(xml, { abstractChars }).slice(0, n);
    return { ok: true, source: 'arxiv', results };
  } catch (err) {
    signal?.throwIfAborted();
    return { ok: false, reason: err.name === 'AbortError' ? '检索超时' : `arXiv 检索失败：${err.message}` };
  }
}

/** 统一入口 */
export async function searchScholar(query, { source = 'europepmc', limit = 8, fetchImpl = fetch, signal } = {}) {
  signal?.throwIfAborted();
  if (!config.scholar?.enabled) return { ok: false, reason: '外部文献检索未启用（SCHOLAR_SEARCH=0）' };
  if (source === 'europepmc' && config.scholar.europePmcEnabled === false) return { ok: false, reason: 'Europe PMC 已在设置中关闭' };
  if (source === 'openalex' && config.scholar.openAlexEnabled === false) return { ok: false, reason: 'OpenAlex 已在设置中关闭' };
  const sources = { europepmc: searchEuropePmc, arxiv: searchArxiv, openalex: searchOpenAlex, crossref: searchCrossref, semanticscholar: searchSemanticScholar };
  if (!sources[source]) return { ok: false, reason: '未知文献源' };
  if (Array.isArray(config.scholar.sources) && !config.scholar.sources.includes(source)) return { ok: false, reason: '该文献源未启用' };
  return sources[source](query, { limit, fetchImpl, signal });
}

const cleanDoi = s => {
  const value = String(s || '').replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]{1,200}$/.test(value) ? value : '';
};
const publicUrl = s => { try { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; } };
const limitCount = n => Math.max(1, Math.min(10, Math.floor(Number(n)) || 6));
const dateValue = v => /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : '';
function sourceError(err, signal) {
  signal?.throwIfAborted();
  return { ok: false, error: err.name === 'AbortError' ? 'timeout' : 'unavailable', status: err.status, retryAfter: err.retryAfter,
    reason: /HTTP \d{3}/.exec(err.message)?.[0] || (err.name === 'AbortError' ? 'timeout' : 'unavailable') };
}
function invertedAbstract(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return '';
  const words = [];
  for (const [word, places] of Object.entries(index).slice(0, 6000)) {
    if (!Array.isArray(places)) continue;
    for (const p of places.slice(0, 200)) if (Number.isInteger(p) && p >= 0 && p < 3000) words[p] = word;
  }
  return clip(words.join(' '), 3000);
}
export async function searchOpenAlex(query, { signal, fetchImpl = fetch, limit = 6, apiKey = config.scholar.openAlexKey } = {}) {
  const q = clip(query, 501); if (!q || q.length > 500) return { ok: false, reason: 'query 需为 1–500 字符' };
  const n = limitCount(limit), url = new URL('https://api.openalex.org/works');
  url.searchParams.set('search', q); url.searchParams.set('per_page', String(n));
  url.searchParams.set('filter', 'is_retracted:false');
  url.searchParams.set('select', 'id,doi,title,authorships,publication_date,type,primary_location,biblio,abstract_inverted_index,is_retracted');
  try {
    const data = JSON.parse(await fetchScholarBody(url.href, fetchImpl, signal, 'application/json', apiKey ? { authorization: `Bearer ${apiKey}` } : {}));
    if (!Array.isArray(data.results)) throw new Error('invalid_results');
    return { ok: true, source: 'openalex', results: data.results.slice(0, n).map(r => {
      const loc = r.primary_location || {}, doi = cleanDoi(r.doi), publishedAt = dateValue(r.publication_date);
      return { title: clip(r.title, 300), doi, abstract: invertedAbstract(r.abstract_inverted_index),
        authors: (r.authorships || []).slice(0, 8).map(a => clip(a.author?.display_name, 80)).join(', '),
        ...contributors(r.authorships, a => namedContributor(a.author?.display_name)),
        venue: clip(loc.source?.display_name, 120), publisher: clip(loc.source?.host_organization_name, 120),
        publicationType: r.type === 'article' && loc.source?.type === 'journal' ? 'journal-article' : r.type,
        volume: clip(r.biblio?.volume, 24), issue: clip(r.biblio?.issue, 24),
        page: [...new Set([r.biblio?.first_page, r.biblio?.last_page].filter(Boolean))].map(p => clip(p, 30)).join('-'),
        type: r.type === 'preprint' || loc.version === 'submittedVersion' || /(?:arxiv|biorxiv|medrxiv)/i.test(loc.source?.display_name || '') ? 'preprint' : r.type,
        publishedAt, year: publishedAt.slice(0, 4), isRetracted: r.is_retracted === true,
        url: doi ? `https://doi.org/${doi}` : publicUrl(loc.landing_page_url), openAccessUrl: loc.is_oa ? publicUrl(loc.pdf_url || loc.landing_page_url) : '', catalog: 'OpenAlex' };
    }) };
  } catch (err) { return sourceError(err, signal); }
}
export async function searchCrossref(query, { signal, fetchImpl = fetch, limit = 6 } = {}) {
  const q = clip(query, 501); if (!q || q.length > 500) return { ok: false, reason: 'query 需为 1–500 字符' };
  const n = limitCount(limit), url = new URL('https://api.crossref.org/works');
  url.searchParams.set('query.bibliographic', q); url.searchParams.set('rows', String(n));
  try {
    const data = JSON.parse(await fetchScholarBody(url.href, fetchImpl, signal, 'application/json'));
    if (!Array.isArray(data.message?.items)) throw new Error('invalid_results');
    return { ok: true, source: 'crossref', results: data.message.items.slice(0, n).map(r => {
      const doi = cleanDoi(r.DOI), parts = r.published?.['date-parts']?.[0] || [];
      return { title: clip(r.title?.[0], 300), authors: (r.author || []).slice(0, 8).map(a => clip([a.given, a.family].filter(Boolean).join(' ') || a.name, 80)).join(', '),
        ...contributors(r.author, a => a.name ? namedContributor(a.name) : { family: clip(a.family, 160), given: clip(a.given, 160) }),
        venue: clip(r['container-title']?.[0], 120), publisher: clip(r.publisher, 120), year: String(parts[0] || ''),
        volume: clip(r.volume, 24), issue: clip(r.issue, 24), page: clip(r.page, 60),
        publishedAt: parts.length >= 3 ? `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')}` : '',
        doi, url: doi ? `https://doi.org/${doi}` : publicUrl(r.URL), abstract: clip(String(r.abstract || '').replace(/<[^>]*>/g, ' '), 3000),
        openAccessUrl: '', type: r.type === 'posted-content' ? 'preprint' : r.type, catalog: 'Crossref' };
    }) };
  } catch (err) { return sourceError(err, signal); }
}
export async function searchSemanticScholar(query, { signal, fetchImpl = fetch, limit = 6, apiKey = config.scholar.semanticScholarKey } = {}) {
  const q = clip(query, 501); if (!q || q.length > 500) return { ok: false, reason: 'query 需为 1–500 字符' };
  const n = limitCount(limit), url = new URL('https://api.semanticscholar.org/graph/v1/paper/search');
  url.searchParams.set('query', q); url.searchParams.set('limit', String(n));
  url.searchParams.set('fields', 'title,authors,year,abstract,url,externalIds,venue,publicationDate,openAccessPdf,publicationTypes');
  try {
    const data = JSON.parse(await fetchScholarBody(url.href, fetchImpl, signal, 'application/json', apiKey ? { 'x-api-key': apiKey } : {}));
    if (!Array.isArray(data.data)) throw new Error('invalid_results');
    return { ok: true, source: 'semanticscholar', results: data.data.slice(0, n).map(r => {
      const doi = cleanDoi(r.externalIds?.DOI);
      return { title: clip(r.title, 300), authors: (r.authors || []).slice(0, 8).map(a => clip(a.name, 80)).join(', '),
        ...contributors(r.authors, a => namedContributor(a.name)),
        year: String(r.year || ''), publishedAt: dateValue(r.publicationDate), venue: clip(r.venue, 120), doi,
        url: doi ? `https://doi.org/${doi}` : publicUrl(r.url), abstract: clip(r.abstract, 3000), openAccessUrl: publicUrl(r.openAccessPdf?.url),
        type: r.publicationTypes?.includes('JournalArticle') ? 'journal-article' : 'review-unverified', catalog: 'Semantic Scholar' };
    }) };
  } catch (err) { return sourceError(err, signal); }
}
