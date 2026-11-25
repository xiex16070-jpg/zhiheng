/**
 * Phase C3：web 检索与抓取（轻形态——只取正文，不做 GUI 自动化）。
 *
 * 安全要点（见 docs/integration/three-way-agent-comparison.md §3.3）：
 * - **SSRF 闸**：仅 http/https；DNS 解析后对**每个 IP** 再校验（拒环回/私网/链路本地/元数据 169.254.169.254），
 *   重定向手动跟随（≤3 跳），每跳重新校验；
 * - 缓存 15 分钟（同 URL 不发第二次请求）；
 * - 正文超预算时截断；只有显式信任项目才自动落盘，ask/只读项目不产生文件；
 * - 抓回的内容一律视为不可信数据：工具返回文本里带身份声明，模型不得当指令执行。
 */
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { config } from './config.mjs';
import { writeFile as wsWrite } from './workspace.mjs';
import { readFilePermission, withFileMutation } from './file-permissions.mjs';
import { isBlockedIp, pinnedLookup, resolveHost } from './netguard.mjs';

/* ------------------------------------------------------------------ SSRF 校验 */

export { isBlockedIp };

/** URL 形态校验（不含 DNS） */
export function validateUrlShape(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'URL 解析失败' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: `仅支持 http/https（收到 ${u.protocol}）` };
  if (u.username || u.password) return { ok: false, reason: 'URL 不允许携带凭据' };
  if (!u.hostname) return { ok: false, reason: 'URL 缺少主机名' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, reason: '内网/本地主机名被拒绝' };
  }
  return { ok: true, url: u };
}

/** DNS 解析 + 逐 IP 校验。注入 lookup 供离线测试。 */
export async function assertPublicHost(hostname, lookup = dns.lookup) {
  return resolveHost(hostname, { lookup, allowLoopback: false });
}

/* ------------------------------------------------------------------ HTML → 文本 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** 极简 readability：去脚本/样式/导航噪声，块级标签转换行，压缩空白 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|canvas|template|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<(nav|footer|header|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '· ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\r/g, '');
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.trim();
}

function metaOf(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/* ------------------------------------------------------------------ 缓存 */

const cache = new Map(); // url -> {ts, value}

export function clearWebCache() {
  cache.clear();
}

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.ts > config.web.cacheTtlMs) {
    cache.delete(url);
    return null;
  }
  return hit.value;
}

function cacheSet(url, value) {
  if (cache.size > 300) cache.clear();
  cache.set(url, { ts: Date.now(), value });
}

function pinnedFetch(urlString, { signal, headers }, ips) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const url = new URL(urlString);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
      lookup: pinnedLookup(ips),
      agent: false,
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > config.web.maxBytes) {
          const err = new Error('response_too_large');
          err.code = 'RESPONSE_TOO_LARGE';
          res.destroy(err);
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const headersMap = new Map(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : v || '']));
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: { get: (name) => headersMap.get(String(name).toLowerCase()) || null },
          arrayBuffer: async () => body,
        });
      });
      res.on('error', reject);
    });
    req.setTimeout(config.web.fetchTimeoutMs, () => req.destroy(new Error('fetch_timeout')));
    req.on('error', reject);
    const onAbort = () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.end();
  });
}

async function presentCached(value, { cap, userId, workspaceCache = true, cached = false }) {
  let text = value.body;
  let truncated = false;
  let savedPath = null;
  if (text.length > cap) {
    truncated = true;
    text = text.slice(0, cap);
    if (userId && workspaceCache) {
      // Cache hits must obey the current project policy too. The URL cache is
      // memory-only; fetching a long page must not become a hidden write bypass.
      try {
        const policy = await readFilePermission(userId);
        if (policy.mode === 'trusted') {
          const host = new URL(value.finalUrl).hostname.replace(/[^a-z0-9.-]/gi, '_');
          const destination = `web-cache/${host}-${Date.now().toString(36)}.txt`;
          const result = await withFileMutation('write_file', { path: destination, content: value.body },
            { userId, workspaceId: policy.workspaceId }, () => wsWrite(userId, destination, value.body));
          if (result.ok) savedPath = result.path;
        }
      } catch { /* Unreadable/revoked permissions leave only the in-memory excerpt. */ }
    }
  }
  return { ...value, body: undefined, text, truncated, savedPath, cached };
}

/* ------------------------------------------------------------------ 抓取 */

/**
 * 抓取一个 URL 的正文。测试可注入 fetchImpl/lookup。
 * @returns {Promise<{ok:boolean, url?:string, finalUrl?:string, title?:string, text?:string, truncated?:boolean, savedPath?:string, reason?:string}>}
 */
export async function webFetch(rawUrl, { maxChars, fetchImpl = fetch, lookup = dns.lookup, userId = null, signal = null, urlPolicy = null, workspaceCache = true } = {}) {
  if (signal?.aborted) return { ok: false, reason: '抓取已取消' };
  if (!config.web.fetchEnabled) return { ok: false, reason: '网页读取未启用' };
  const shape = validateUrlShape(rawUrl);
  if (!shape.ok) return { ok: false, reason: shape.reason };
  if (urlPolicy && !urlPolicy(shape.url.href)) return { ok: false, reason: '来源不在允许范围' };

  const url = shape.url.toString();
  const cap = Math.max(500, Math.min(Number(maxChars) || config.web.extractMaxChars, 60000));
  const cached = cacheGet(url);
  if (cached) return urlPolicy && !urlPolicy(cached.finalUrl) ? { ok: false, reason: '缓存来源不在允许范围' } : presentCached(cached, { cap, userId, workspaceCache, cached: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.web.fetchTimeoutMs);
  const onOuterAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    let current = url;
    let res = null;
    for (let hop = 0; hop <= 3; hop += 1) {
      const gate = await assertPublicHost(new URL(current).hostname, lookup);
      if (!gate.ok) return { ok: false, reason: gate.reason };
      const request = fetchImpl === fetch ? pinnedFetch : fetchImpl;
      const requestArgs = {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; CSL-KB-Agent/1.0; +https://localhost)',
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
          'accept-encoding': 'identity',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        },
      };
      res = request === pinnedFetch
        ? await request(current, requestArgs, gate.ips)
        : await request(current, requestArgs);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, reason: `重定向 ${res.status} 缺少 Location` };
        const next = new URL(loc, current);
        const nextShape = validateUrlShape(next.toString());
        if (!nextShape.ok) return { ok: false, reason: `重定向目标被拒绝：${nextShape.reason}` };
        if (urlPolicy && !urlPolicy(next.href)) return { ok: false, reason: '重定向来源不在允许范围' };
        current = next.toString();
        continue;
      }
      break;
    }
    if (!res) return { ok: false, reason: '抓取失败' };
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct && !/text\/|application\/(xhtml|json|xml)|html/.test(ct)) {
      return { ok: false, reason: `不支持的内容类型 ${ct.split(';')[0]}` };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > config.web.maxBytes) {
      return { ok: false, reason: `响应体过大（>${Math.round(config.web.maxBytes / 1024 / 1024)}MB）` };
    }
    const raw = buf.toString('utf8');
    const isHtml = /html|xml/.test(ct) || /<html[\s>]/i.test(raw.slice(0, 400));
    const body = isHtml ? htmlToText(raw) : raw.trim();
    const title = isHtml ? (metaOf(raw, 'og:title') || titleOf(raw)) : '';

    const publishedAt = isHtml ? metaOf(raw, 'article:published_time') || metaOf(raw, 'citation_publication_date') || metaOf(raw, 'date') : '';
    const value = { ok: true, url, finalUrl: current, title, body, publishedAt, bytes: buf.length };
    cacheSet(url, value);
    if (current !== url) cacheSet(current, value);
    return presentCached(value, { cap, userId, workspaceCache });
  } catch (err) {
    if (err.code === 'RESPONSE_TOO_LARGE') return { ok: false, reason: `响应体过大（>${Math.round(config.web.maxBytes / 1024 / 1024)}MB）` };
    if (err.name === 'AbortError') return { ok: false, reason: signal?.aborted ? '抓取已取消' : `抓取超时（>${config.web.fetchTimeoutMs}ms）` };
    return { ok: false, reason: `抓取失败：${err.code || err.message}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/* ------------------------------------------------------------------ 检索 */

const SEARCH_ENDPOINTS = {
  tavily: 'https://api.tavily.com/search',
  serper: 'https://google.serper.dev/search',
  bing: 'https://api.bing.microsoft.com/v7.0/search',
};

export function searchAvailable() {
  return Boolean(config.web.searchConnections?.some(c => c.apiKey && SEARCH_ENDPOINTS[c.provider]) ||
    (config.web.searchProvider && config.web.searchKey && SEARCH_ENDPOINTS[config.web.searchProvider]));
}

/**
 * 联网检索。无后端/无 Key 时直接拒绝（schema 层也不会注册该工具）。
 * @returns {Promise<{ok:boolean, results?:Array<{title:string,url:string,snippet:string}>, reason?:string}>}
 */
export async function webSearch(query, { count = 5, fetchImpl = fetch, signal, domains = [], connection = null } = {}) {
  signal?.throwIfAborted();
  const q = String(query || '').trim().slice(0, 1500);
  if (!q) return { ok: false, reason: 'query 不能为空' };
  const connections = !connection && config.web.searchConnections?.filter(c => c.apiKey && SEARCH_ENDPOINTS[c.provider]);
  if (connections?.length) {
    const replies = await Promise.all(connections.map(c => webSearch(q, { count, fetchImpl, signal, domains, connection: c })));
    signal?.throwIfAborted();
    const seen = new Set(), results = [];
    // Round-robin avoids giving whichever engine is first all of the evidence budget.
    for (let i = 0; i < Math.max(0, ...replies.map(r => r.results?.length || 0)); i++) {
      for (const [j, reply] of replies.entries()) {
        const row = reply.results?.[i];
        if (!row) continue;
        const id = row.url.split('#')[0];
        if (seen.has(id)) continue;
        seen.add(id); results.push({ ...row, engine: connections[j].provider });
      }
    }
    const providers = replies.map((r, i) => ({ provider: connections[i].provider, ok: r.ok, count: r.results?.length || 0, ...(!r.ok ? { code: r.error, status: r.status } : {}) }));
    return replies.some(r => r.ok) ? { ok: true, results: results.slice(0, Math.max(1, Math.min(10, Number(count) || 5))), providers }
      : { ...replies[0], providers };
  }
  // Capture credentials before the first await. Testing a draft never mutates
  // live settings, and an in-flight request cannot mix two saved providers.
  const provider = connection?.provider ?? config.web.searchProvider;
  const key = connection?.apiKey ?? config.web.searchKey;
  if (!key || !SEARCH_ENDPOINTS[provider]) return { ok: false, error: 'unconfigured', reason: '未配置检索后端（WEB_SEARCH_PROVIDER / WEB_SEARCH_KEY）' };
  const n = Math.max(1, Math.min(Number(count) || 5, 10));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.web.fetchTimeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const allowed = [...new Set(domains)].filter(d => typeof d === 'string' && /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d)).slice(0, 100);
  if (domains.length && !allowed.length) { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); return { ok: false, reason: '无有效来源范围' }; }
  const scopedQuery = allowed.length ? `${q} (${allowed.map(d => 'site:' + d).join(' OR ')})` : q;
  try {
    let res;
    if (provider === 'tavily') {
      res = await fetchImpl(SEARCH_ENDPOINTS.tavily, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query: q, max_results: n, search_depth: 'basic', ...(allowed.length ? { include_domains: allowed, include_domains_mode: 'restrict' } : {}) }),
      });
    } else if (provider === 'serper') {
      res = await fetchImpl(SEARCH_ENDPOINTS.serper, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', 'X-API-KEY': key },
        body: JSON.stringify({ q: scopedQuery, num: n }),
      });
    } else {
      const u = new URL(SEARCH_ENDPOINTS.bing);
      u.searchParams.set('q', scopedQuery);
      u.searchParams.set('count', String(n));
      res = await fetchImpl(u.toString(), { redirect: 'error', signal: controller.signal, headers: { 'Ocp-Apim-Subscription-Key': key } });
    }
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      return { ok: false, error: 'upstream_http', status: res.status, reason: `检索后端 HTTP ${res.status}` };
    }
    if (Number(res.headers?.get('content-length')) > config.web.maxBytes) { controller.abort(); throw new Error('response_too_large'); }
    let data;
    const reader = res.body?.getReader();
    if (reader) {
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read(); if (done) break;
          bytes += value.byteLength;
          if (bytes > config.web.maxBytes) { await reader.cancel(); throw new Error('response_too_large'); }
          chunks.push(value);
        }
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } finally { reader.releaseLock(); }
    } else data = await res.json();
    signal?.throwIfAborted();
    let results = [];
    if (provider === 'tavily') {
      if (!Array.isArray(data.results)) throw new Error('invalid_results');
      results = (data.results || []).map((r) => ({ title: r.title || '', url: r.url || '', snippet: (r.content || '').slice(0, 300) }));
    } else if (provider === 'serper') {
      if (!Array.isArray(data.organic)) throw new Error('invalid_results');
      results = (data.organic || []).map((r) => ({ title: r.title || '', url: r.link || '', snippet: (r.snippet || '').slice(0, 300) }));
    } else {
      results = ((data.webPages && data.webPages.value) || []).map((r) => ({ title: r.name || '', url: r.url || '', snippet: (r.snippet || '').slice(0, 300) }));
    }
    return { ok: true, results: results.filter(r => {
      const shape = validateUrlShape(r.url);
      return shape.ok && (!allowed.length || allowed.some(d => shape.url.hostname === d || shape.url.hostname.endsWith('.' + d)));
    }).slice(0, n) };
  } catch (err) {
    signal?.throwIfAborted();
    if (err.name === 'AbortError') return { ok: false, error: 'timeout', reason: '检索超时' };
    const code = ['response_too_large', 'invalid_results'].includes(err.message) ? err.message : err instanceof SyntaxError ? 'invalid_results' : 'network_error';
    return { ok: false, error: code, reason: { response_too_large: '检索响应超过大小限制', invalid_results: '检索服务返回的数据无效', network_error: '无法连接检索服务' }[code] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
