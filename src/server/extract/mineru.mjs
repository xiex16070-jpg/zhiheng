/** MinerU 4.1 Tasks API adapter. Only the explicitly configured self-hosted origin is contacted. */
import zlib from 'node:zlib';
import crypto from 'node:crypto';

function boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function endpoint(base, target) {
  const url = new URL(target, `${base.href.replace(/\/$/, '')}/`);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== base.origin || url.username || url.password) {
    throw new Error('mineru_cross_origin_url');
  }
  return url;
}

async function request(url, { method = 'GET', body, headers = {}, signal, maxBytes, apiKey, fetchImpl }) {
  const response = await fetchImpl(url, {
    method, body, signal, redirect: 'error',
    headers: { ...headers, ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`mineru_http_${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('mineru_response_too_large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('mineru_response_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('mineru_invalid_json'); }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Read one bounded ZIP member in memory; never unpack service-supplied paths to disk. */
export function readStructuredZip(bytes, maxBytes = 64 * 1024 * 1024) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
      end = i;
      break;
    }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('mineru_invalid_zip');
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  let offset = bytes.readUInt32LE(end + 16);
  const centralEnd = offset + centralSize;
  if (count === 0xffff || centralEnd > end) throw new Error('mineru_invalid_zip');
  let result = null;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > centralEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('mineru_invalid_zip');
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const expectedCrc = bytes.readUInt32LE(offset + 16);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const plainSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > centralEnd) throw new Error('mineru_invalid_zip');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset = next;
    if (name !== 'structured_content.json') continue;
    if (result || flags & 1 || plainSize > maxBytes || compressedSize > maxBytes) throw new Error('mineru_invalid_zip_member');
    if (local + 30 > centralEnd || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('mineru_invalid_zip');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    if (start + compressedSize > centralEnd) throw new Error('mineru_invalid_zip');
    const raw = bytes.subarray(start, start + compressedSize);
    if (method === 0) result = raw;
    else if (method === 8) result = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    else throw new Error('mineru_unsupported_zip_compression');
    if (result.length !== plainSize || result.length > maxBytes || crc32(result) !== expectedCrc) {
      throw new Error('mineru_corrupt_zip_member');
    }
  }
  if (!result) throw new Error('mineru_structured_content_missing');
  return parseJson(result);
}

/** Reconstruct one canonical text and map its UTF-16 offsets to original PDF pages/blocks. */
export function normalizeStructuredContent(document, { maxTextChars = 5_000_000 } = {}) {
  if (!Array.isArray(document?.pages) || !document.pages.length) throw new Error('mineru_invalid_structured_content');
  if (document.is_full_document === false) throw new Error('mineru_partial_document');
  const pieces = [];
  const sourceMap = [];
  let length = 0;
  const seen = new Set();
  for (const page of document.pages) {
    if (!Number.isInteger(page.page_idx) || page.page_idx < 0 || !Array.isArray(page.blocks) || seen.has(page.page_idx)) {
      throw new Error('mineru_invalid_page');
    }
    seen.add(page.page_idx);
    for (const [index, block] of page.blocks.entries()) {
      if (!block || typeof block !== 'object') throw new Error('mineru_invalid_block');
      const parts = [
        ...(Array.isArray(block.captions) ? block.captions.map((part, n) => ({ ...part, part: `caption${n}` })) : []),
        { content: block.content, bbox: block.bbox, part: 'body' },
        ...(Array.isArray(block.footnotes) ? block.footnotes.map((part, n) => ({ ...part, part: `footnote${n}` })) : []),
      ];
      for (const part of parts) {
        if (part.content != null && typeof part.content !== 'string') throw new Error('mineru_invalid_block_content');
        const text = String(part.content || '').replace(/\r\n?/g, '\n').trim();
        if (!text) continue;
        if (pieces.length) { pieces.push('\n\n'); length += 2; }
        const start = length;
        length += text.length;
        if (length > maxTextChars) throw new Error('mineru_text_too_large');
        pieces.push(text);
        const bbox = Array.isArray(part.bbox) && part.bbox.length === 4 && part.bbox.every(Number.isFinite) ? [...part.bbox] : null;
        sourceMap.push({
          page: page.page_idx + 1, pageIndex: page.page_idx,
          blockId: `p${page.page_idx}:b${index}:${part.part}`, type: String(block.type || 'text'),
          start, end: length, ...(bbox ? { bbox } : {}),
        });
      }
    }
  }
  if (!length) throw new Error('mineru_empty_text');
  return {
    text: pieces.join(''), pages: document.pages.length, kind: 'pdf', parser: 'mineru', sourceMap,
    parserVersion: String(document.metadata?.producer?.version || ''),
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('mineru_aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export async function extractMineru(buffer, filename, options = {}) {
  const settings = options.settings || {};
  const base = new URL(String(settings.baseUrl || ''));
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('mineru_invalid_base_url');
  }
  const name = String(filename || 'document.pdf').split(/[\\/]/).pop().replace(/[:\x00-\x1f\x7f]/g, '_').slice(-255);
  const timeoutMs = boundedNumber(settings.timeoutMs, 120000, 50, 600000);
  const maxBytes = boundedNumber(settings.maxResponseBytes, 64 * 1024 * 1024, 1024, 128 * 1024 * 1024);
  const pollMs = boundedNumber(settings.pollMs, 1000, 10, 10000);
  const controller = new AbortController();
  const onAbort = () => controller.abort(new Error('mineru_aborted'));
  const timer = setTimeout(() => controller.abort(new Error('mineru_timeout')), timeoutMs);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  const common = { signal: controller.signal, apiKey: settings.apiKey || '', fetchImpl: options.fetchImpl || fetch, maxBytes };
  const jsonRequest = async (url, init = {}) => parseJson(await request(url, { ...common, maxBytes: Math.min(maxBytes, 2 * 1024 * 1024), ...init }));
  let taskUrl = null;
  let completed = false;
  try {
    const receipt = await jsonRequest(endpoint(base, 'v1/tasks'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        files: [{ file_name: name, bytes: buffer.length, sha256sum: crypto.createHash('sha256').update(buffer).digest('hex') }],
        tier: settings.tier || 'standard', ocr_mode: settings.ocrMode || 'auto', output_formats: ['default'],
      }),
    });
    if (typeof receipt.task_id !== 'string' || !receipt.task_id || !Array.isArray(receipt.files) || receipt.files.length !== 1 || !receipt.files[0]?.file_id) {
      throw new Error('mineru_invalid_task_receipt');
    }
    taskUrl = endpoint(base, `v1/tasks/${encodeURIComponent(receipt.task_id)}`);
    const fileId = receipt.files[0].file_id;
    let snapshot = receipt;
    let uploaded = false;
    for (;;) {
      if (controller.signal.aborted) throw controller.signal.reason;
      const file = snapshot.files?.find((item) => item.file_id === fileId);
      if (!file) throw new Error('mineru_file_missing');
      if (['failed', 'canceled'].includes(file.status)) throw new Error(`mineru_parse_${file.status}`);
      if (file.status === 'completed' && file.result_url) {
        const zip = await request(endpoint(base, file.result_url), common);
        const normalized = normalizeStructuredContent(readStructuredZip(zip, maxBytes), { maxTextChars: options.maxTextChars });
        completed = true;
        return normalized;
      }
      if (!uploaded && file.status === 'waiting-file' && file.upload?.url) {
        // This adapter deliberately supports self-hosted, same-origin uploads only.
        await request(endpoint(base, file.upload.url), {
          ...common, method: 'PUT', body: buffer,
          headers: { ...(file.upload.headers || {}), 'content-type': 'application/octet-stream' },
        });
        uploaded = true;
      } else {
        await delay(pollMs, controller.signal);
      }
      snapshot = await jsonRequest(taskUrl);
      if (snapshot.task_id !== receipt.task_id) throw new Error('mineru_task_mismatch');
    }
  } catch (err) {
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    if (!completed && taskUrl) {
      const cancel = new AbortController();
      const cancelTimer = setTimeout(() => cancel.abort(), 2000);
      try { await request(new URL(`${taskUrl.href}/cancel`), { ...common, method: 'POST', signal: cancel.signal, maxBytes: 64 * 1024 }); }
      catch { /* A failed cancellation does not replace the original failure. */ }
      finally { clearTimeout(cancelTimer); }
    }
  }
}
