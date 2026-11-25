import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';
import { resolveHost, pinnedLookup } from './netguard.mjs';

/** Fixed destination per request, no redirects, bounded buffered responses. */
export async function pinnedRequest(raw, { method = 'GET', headers = {}, body, signal, allowLoopback = false, maxBytes = 2 * 1024 * 1024 } = {}) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('invalid_url');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  const result = await resolveHost(url.hostname, { allowLoopback: allowLoopback && loopback });
  if (!result.ok) throw new Error('private_network_blocked');
  signal?.throwIfAborted();
  const requestSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method, headers,
      lookup: pinnedLookup(result.ips), signal: requestSignal }, res => {
      let bytes = 0; const chunks = [];
      res.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) { req.destroy(new Error('response_too_large')); return; } chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          let body = Buffer.concat(chunks);
          const decode = { gzip: gunzipSync, deflate: inflateSync, br: brotliDecompressSync }[res.headers['content-encoding']];
          if (decode) body = decode(body, { maxOutputLength: maxBytes });
          else if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw new Error('unsupported_encoding');
          resolve({ status: res.statusCode, headers: res.headers, body });
        } catch { reject(new Error('response_decode_failed')); }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

export function mcpFetch(endpoint, token = '', outerSignal) {
  const origin = new URL(endpoint).origin;
  return async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin !== origin || url.href !== new URL(endpoint).href) throw new Error('mcp_endpoint_changed');
    // Notifications are received in POST streams; do not leave an idle GET open.
    if (options.method === 'GET') return new Response(null, { status: 405 });
    const headers = Object.fromEntries(new Headers(options.headers));
    if (token) headers.authorization = 'Bearer ' + token;
    const signal = AbortSignal.any([AbortSignal.timeout(20000), ...(outerSignal ? [outerSignal] : []), ...(options.signal ? [options.signal] : [])]);
    const r = await pinnedRequest(url.href, { method: options.method || 'GET', headers, body: options.body, signal, allowLoopback: true });
    if (r.status >= 300 && r.status < 400) throw new Error('mcp_redirect_blocked');
    const h = new Headers();
    for (const [k,v] of Object.entries(r.headers)) if (!['content-encoding','transfer-encoding','content-length'].includes(k) && v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    return new Response([204,205,304].includes(r.status) ? null : r.body, { status: r.status, headers: h });
  };
}
