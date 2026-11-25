/** Optional cross-encoder reranking. The service can reorder existing evidence only. */
import { config } from './config.mjs';

const RESPONSE_MAX_BYTES = 128 * 1024;

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

export function rerankSettings(overrides = {}) {
  const settings = { ...(config.rerank || {}), ...overrides };
  return {
    enabled: settings.enabled === true || settings.enabled === 'auto',
    mode: settings.enabled === 'auto' ? 'auto' : settings.enabled === true ? 'on' : 'off',
    url: String(settings.url || ''),
    apiKey: String(settings.apiKey || ''),
    model: String(settings.model || 'BAAI/bge-reranker-v2-m3'),
    candidateK: boundedInt(settings.candidateK, 30, 1, 100),
    timeoutMs: boundedInt(settings.timeoutMs, 5000, 50, 120000),
    maxChars: boundedInt(settings.maxChars, 6000, 128, 12000),
  };
}

const healthCache = new Map();
/** Read-only health probe, cached for 30 seconds. No document is sent to probes. */
export async function rerankAvailable(settings) {
  const key = settings.url + '\n' + settings.model + '\n' + settings.apiKey;
  const cached = healthCache.get(key); if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = (async () => {
    try {
      const url = new URL(settings.url); url.pathname = url.pathname.replace(/\/rerank\/?$/, '/health');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(Math.min(800, settings.timeoutMs)), headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {} });
      if (!response.ok) { await response.body?.cancel(); return false; }
      const body = await boundedJson(response); return body.ready === true && body.model === settings.model;
    } catch { return false; }
  })();
  if (healthCache.size > 32) healthCache.clear();
  healthCache.set(key, { promise, expires: Date.now() + 30000 }); return promise;
}

async function boundedJson(response) {
  if (!response.body) throw new Error('rerank_empty_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_MAX_BYTES) throw new Error('rerank_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Preserve source objects and offsets. Never accept replacement text or IDs from a service. */
export async function rerankCandidates(query, candidates, { signal = null, settings: overrides = {} } = {}) {
  const settings = rerankSettings(overrides);
  const started = Date.now();
  const fallback = (reason) => ({ results: candidates, applied: false, reason, ms: Date.now() - started });
  if (!settings.enabled) return fallback('disabled');
  if (candidates.length < 2) return fallback('too_few_candidates');
  if (signal?.aborted) return fallback('cancelled');
  if (!settings.url) return fallback('not_configured');
  if (settings.mode === 'auto' && !await rerankAvailable(settings)) return fallback('auto_service_unavailable');
  if (candidates.length > 100) return fallback('too_many_candidates');

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const url = new URL(settings.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return fallback('invalid_service_url');
    }
    // URL comes exclusively from operator configuration, never from a query/tool argument.
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        query: String(query || '').slice(0, 4000),
        documents: candidates.map((item) => [item.title, item.heading, item.content || item.snippet]
          .filter(Boolean).join('\n').slice(0, settings.maxChars)),
        top_n: candidates.length,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return fallback(`http_${response.status}`);
    }
    const payload = await boundedJson(response);
    const rows = payload?.results;
    if (!Array.isArray(rows) || rows.length !== candidates.length) return fallback('invalid_result_count');
    const seen = new Set();
    for (const row of rows) {
      if (!Number.isInteger(row?.index) || row.index < 0 || row.index >= candidates.length ||
          seen.has(row.index) || !Number.isFinite(row.relevance_score)) return fallback('invalid_result');
      seen.add(row.index);
    }
    const results = [...rows]
      .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
      .map((row) => ({ ...candidates[row.index], rerankScore: row.relevance_score }));
    return { results, applied: true, model: settings.model, ms: Date.now() - started };
  } catch (err) {
    return fallback(signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' :
      err instanceof SyntaxError ? 'invalid_json' : 'service_error');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
