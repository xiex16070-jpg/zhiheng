import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const operationTypes = new Map([
  ['agent.task', 'agent'], ['model.call', 'generation'],
  ['tool.execute', 'tool'], ['retrieval.search', 'retriever'], ['retrieval.authority', 'retriever'],
]);
const toolNames = new Set([
  'search_knowledge', 'read_source', 'verify_quote', 'logic_evaluate', 'logic_run_assumptions', 'logic_evaluate_grounded', 'remember',
  'write_file', 'read_file', 'search_files', 'list_files', 'patch_file', 'update_plan',
  'update_preferences', 'run_command', 'web_fetch', 'web_search',
  'find_files', 'read_document', 'list_skills', 'skill_view', 'search_history', 'current_time', 'scholar_search',
  'ask_user', 'delegate_task', 'create_visualization', 'pdf_inspect', 'pdf_fill', 'pdf_split', 'pdf_merge',
  'notebook_read', 'notebook_edit', 'artifact_scan', 'latex_compile', 'view_image', 'zotero_search', 'zotero_export', 'generate_image',
  'exec_start', 'exec_write', 'exec_poll', 'exec_close', 'tool_search', 'tool_describe', 'tool_call',
  'create_document', 'list_extensions', 'extension_tools', 'call_extension',
]);
const failures = new Set(['error', 'timeout', 'denied', 'invalid', 'unavailable', 'rate_limited', 'output_limit']);
const outcomes = new Set([...failures, 'ok', 'cancelled', 'awaiting_approval', 'empty', 'weak', 'degraded']);
const noopSpan = Object.freeze({ setOutcome() {}, setTool() {} });
const MAX_PENDING = 128;
const TIMEOUT_MS = 2000;

function readDestination(env) {
  if (!/^(true|1)$/i.test(env.LANGFUSE_TRACING_ENABLED || '')) return { state: 'disabled' };
  try {
    const url = new URL(env.LANGFUSE_BASE_URL);
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
    const publicKey = env.LANGFUSE_PUBLIC_KEY;
    const secretKey = env.LANGFUSE_SECRET_KEY;
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.pathname !== '/' || url.username || url.password || url.search || url.hash ||
        !publicKey?.trim() || !secretKey?.trim() || publicKey.includes(':')) {
      return { state: 'misconfigured' };
    }
    url.pathname = '/api/public/otel/v1/traces';
    const authorization = 'Basic ' + Buffer.from(publicKey + ':' + secretKey).toString('base64');
    return { state: 'enabled', url, authorization };
  } catch {
    return { state: 'misconfigured' };
  }
}

function errorOutcome(error) {
  // Provider codes can contain raw HTTP bodies. Only return fixed categories.
  if (error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' ||
      error?.message === 'llm_timeout' || error?.message === 'llm_total_timeout') return 'timeout';
  if (error?.name === 'AbortError' || error?.code === 'aborted' || error?.message === 'aborted') return 'cancelled';
  if (error?.status === 429) return 'rate_limited';
  if (error?.status === 401 || error?.status === 403) return 'denied';
  if (error?.status >= 500 || error?.code === 'network_error' || error?.code === 'breaker_open') return 'unavailable';
  if (error?.status === 400 || error?.code === 'invalid_max_tokens') return 'invalid';
  return 'error';
}

function attribute(key, value) {
  return { key, value: { stringValue: value } };
}

async function exportBatch(destination, spans, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(destination.url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: {
        'content-type': 'application/json', authorization: destination.authorization,
        'x-langfuse-ingestion-version': '4',
      },
      body: JSON.stringify({ resourceSpans: [{
        resource: { attributes: [attribute('service.name', 'zhiheng-agent')] },
        scopeSpans: [{ scope: { name: 'zhiheng-agent' }, spans }],
      }] }),
    });
    if (!response.ok) return spans.length;
    // OTLP can acknowledge a batch with partialSuccess. Never log a collector response.
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body || []) {
      bytes += chunk.length;
      if (bytes > 8192) return spans.length;
      chunks.push(chunk);
    }
    const reply = bytes ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const rejected = Number(reply?.partialSuccess?.rejectedSpans ?? 0);
    return Number.isSafeInteger(rejected) && rejected >= 0 && rejected <= spans.length ? rejected : spans.length;
  } catch {
    return spans.length;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// Independent instances also let tests exercise the wire protocol without process-wide configuration.
export function createTracing(env = process.env) {
  const destination = readDestination(env);
  const context = new AsyncLocalStorage();
  const queue = [];
  const counters = { exported: 0, dropped: 0, failed: 0 };
  let inFlight = 0;
  let sending;
  let timer;

  function schedule() {
    if (!queue.length || sending || timer) return;
    timer = setTimeout(() => sendPending(), 100);
    timer.unref();
  }

  function sendPending(timeout = TIMEOUT_MS) {
    clearTimeout(timer);
    timer = undefined;
    if (sending || !queue.length) return sending;
    const batch = queue.splice(0);
    inFlight = batch.length;
    sending = exportBatch(destination, batch, timeout).then((failed) => {
      counters.failed += failed;
      counters.exported += batch.length - failed;
    }).finally(() => {
      sending = undefined;
      inFlight = 0;
      schedule();
    });
    return sending;
  }

  async function flush() {
    const deadline = performance.now() + TIMEOUT_MS;
    if (sending) await sending;
    const remaining = Math.floor(deadline - performance.now());
    if (remaining > 0) await sendPending(remaining);
  }

  async function withTraceSpan(name, fn) {
    if (destination.state !== 'enabled' || !operationTypes.has(name)) return fn(noopSpan);
    const parent = liveContext();
    const traceId = parent?.traceId ?? randomBytes(16).toString('hex');
    const spanId = randomBytes(8).toString('hex');
    const traceName = parent?.traceName ?? name;
    const frame = { traceId, spanId, traceName, closed: false };
    const start = process.hrtime.bigint();
    const startUnixNano = BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
    let outcome = 'ok';
    let tool;
    const handle = {
      traceId,
      setOutcome(value) { outcome = outcomes.has(value) ? value : 'error'; },
      setTool(value) { if (name === 'tool.execute') tool = toolNames.has(value) ? value : 'unknown'; },
    };
    try {
      return await context.run(frame, fn, handle);
    } catch (error) {
      outcome = 'error';
      // Even an unusual thrown object with a throwing getter must propagate unchanged.
      try { outcome = errorOutcome(error); } catch {}
      throw error;
    } finally {
      frame.closed = true;
      if (queue.length + inFlight >= MAX_PENDING) {
        counters.dropped++;
      } else {
        const attributes = [
          attribute('langfuse.trace.name', traceName),
          attribute('langfuse.observation.type', operationTypes.get(name)),
          attribute('langfuse.observation.metadata.outcome', outcome),
        ];
        if (tool) attributes.push(attribute('langfuse.observation.metadata.tool', tool));
        queue.push({
          traceId, spanId, ...(parent && { parentSpanId: parent.spanId }), name, kind: 1,
          startTimeUnixNano: String(startUnixNano),
          endTimeUnixNano: String(startUnixNano + (process.hrtime.bigint() - start)),
          attributes, status: { code: failures.has(outcome) ? 2 : outcome === 'ok' ? 1 : 0 },
        });
        schedule();
      }
    }
  }

  function liveContext() {
    const frame = context.getStore();
    // A detached review can start after its originating task has already ended.
    return frame?.closed ? undefined : frame;
  }

  return {
    withTraceSpan, flush,
    status: () => ({ state: destination.state, pending: queue.length + inFlight, ...counters }),
  };
}

// .env is loaded by the server bootstrap; read it once when tracing is first used.
let instance;
const active = () => instance ??= createTracing();
export const withTraceSpan = (name, fn) => active().withTraceSpan(name, fn);
export const tracingStatus = () => active().status();
export const flushTracing = () => active().flush();
