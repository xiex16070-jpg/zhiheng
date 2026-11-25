/** Promptfoo provider against the real authenticated HTTP search/chat APIs. */
export async function readEvents(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (block) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (data) events.push(JSON.parse(data));
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop();
      blocks.forEach(consume);
      if (done) break;
    }
    if (buffer.trim()) consume(buffer);
  } finally { reader.releaseLock(); }
  if (!events.some((e) => ['done', 'error', 'approval_required'].includes(e.type))) throw new Error('incomplete_sse');
  return events;
}

export default class AgentProvider {
  constructor({ config = {} } = {}) { this.config = config; }
  id() { return `logic-kb-${this.config.mode || 'live'}`; }
  async callApi(question, context) {
    const { baseUrl, mode = 'live', modelProvider } = this.config;
    const test = context.vars.case;
    const signal = AbortSignal.timeout(Number(process.env.EVAL_TIMEOUT_MS || 180000));
    const boot = await fetch(`${baseUrl}/api/bootstrap`, { signal });
    if (!boot.ok) throw new Error(`bootstrap HTTP ${boot.status}`);
    const cookie = boot.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('missing_eval_identity');
    const request = (route, body, method = 'POST') => fetch(`${baseUrl}${route}`, {
      method, signal, headers: { cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Every case has a fresh identity/conversation; no learning or memory bleed.
    const preferences = await request('/api/preferences', { preferences: { learning: 'off', inference: 'off' } });
    if (!preferences.ok) throw new Error(`preferences HTTP ${preferences.status}`);
    const saved = (await preferences.json()).preferences;
    if (saved?.learning !== 'off' || saved?.inference !== 'off') throw new Error('eval_preferences_not_applied');
    if (test.document) {
      const form = new FormData();
      form.append('file', new Blob([test.document], { type: 'text/plain' }), 'eval-source.txt');
      const upload = await fetch(`${baseUrl}/api/kb/import`, { method: 'POST', body: form, signal, headers: { cookie } });
      const imported = await upload.json();
      if (!upload.ok || imported.imported !== 1) throw new Error('eval_document_import_failed');
    }
    const searchStart = performance.now();
    const searchResponse = await request('/api/search', { query: question, k: 5, rewrite: false });
    if (!searchResponse.ok) throw new Error(`search HTTP ${searchResponse.status}`);
    const retrieval = await searchResponse.json();
    const timings = { retrievalMs: Math.round(performance.now() - searchStart) };
    const requireRerank = this.config.requireRerank === true;
    if (mode === 'retrieval') return { output: JSON.stringify({ mode, retrieval, timings, requireRerank }) };
    const chatStart = performance.now();
    const events = await readEvents(await request('/api/chat', { message: question, provider: modelProvider, mode:'knowledge' }));
    const completed = events.findLast((e) => e.type === 'done');
    timings.chatMs = Math.round(performance.now() - chatStart);
    if (!completed) throw new Error(events.findLast((e) => e.type === 'error')?.message || 'unexpected_approval');
    const sources = [];
    for (const citation of completed.result.citations || []) {
      const sourceRes = await request(`/api/source/${encodeURIComponent(citation.ref || citation.id)}`, undefined, 'GET');
      if (!sourceRes.ok) { sources.push({ ref: String(citation.ref || citation.id), missing: true }); continue; }
      const source = await sourceRes.json();
      const chunk = source.chunks?.find((c) => c.id === String(citation.ref || citation.id));
      const inBounds = Number.isInteger(citation.start) && Number.isInteger(citation.end) &&
        citation.start >= 0 && citation.end > citation.start && citation.end <= source.content.length;
      const offsetValid = inBounds && (chunk && !citation.quoteVerified
        ? citation.start === chunk.start && citation.end === chunk.end
        : source.content.slice(citation.start, citation.end) === citation.snippet &&
          (!chunk || (citation.start >= chunk.start && citation.end <= chunk.end)));
      sources.push({ ref: String(citation.ref || citation.id), content: chunk ? source.content.slice(chunk.start, chunk.end) : source.content,
        quote: citation.snippet || '', start: citation.start, end: citation.end,
        offsetValid });
    }
    return { output: JSON.stringify({ mode, retrieval, result: completed.result, sources, timings, requireRerank,
      actions: events.filter((e) => e.type === 'tool').map((e) => e.name) }) };
  }
}
