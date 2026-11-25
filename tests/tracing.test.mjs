import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createTracing } from '../src/server/tracing.mjs';

async function collector(t, respond = (_request, response) => response.end('{}')) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const record = {
      url: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(record);
    respond(record, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return {
    requests,
    env: {
      LANGFUSE_TRACING_ENABLED: 'true', LANGFUSE_BASE_URL: 'http://127.0.0.1:' + server.address().port,
      LANGFUSE_PUBLIC_KEY: 'test-public', LANGFUSE_SECRET_KEY: 'test-secret',
    },
  };
}

function exportedSpans(requests) {
  return requests.flatMap(({ body }) => JSON.parse(body).resourceSpans[0].scopeSpans[0].spans);
}

function attr(span, key) {
  return span.attributes.find((item) => item.key === key)?.value.stringValue;
}

test('authority retrieval adds a metadata-only child span without exporting source text or queries', async t => {
  const { env, requests } = await collector(t);
  const tracer = createTracing(env);
  await tracer.withTraceSpan('agent.task', async () => tracer.withTraceSpan('retrieval.authority', span => {
    span.setOutcome('degraded');
    return { question: 'PRIVATE_QUESTION', content: 'PRIVATE_DOCUMENT', sourceUrl: 'https://source.invalid/private-url' };
  }));
  await tracer.flush();
  const spans = exportedSpans(requests);
  const parent = spans.find(s => s.name === 'agent.task');
  const child = spans.find(s => s.name === 'retrieval.authority');
  assert.equal(child.parentSpanId, parent.spanId);
  assert.equal(attr(child, 'langfuse.observation.type'), 'retriever');
  assert.equal(attr(child, 'langfuse.observation.metadata.outcome'), 'degraded');
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_QUESTION|PRIVATE_DOCUMENT|private-url/);
});

test('tracing requires opt-in, explicit safe origin and both keys; business callback always runs', async (t) => {
  const { env, requests } = await collector(t);
  for (const [overrides, state] of [
    [{ LANGFUSE_TRACING_ENABLED: '' }, 'disabled'], [{ LANGFUSE_TRACING_ENABLED: 'false' }, 'disabled'],
    [{ LANGFUSE_BASE_URL: '' }, 'misconfigured'], [{ LANGFUSE_SECRET_KEY: '' }, 'misconfigured'],
    [{ LANGFUSE_PUBLIC_KEY: '' }, 'misconfigured'], [{ LANGFUSE_BASE_URL: 'http://example.com' }, 'misconfigured'],
    [{ LANGFUSE_BASE_URL: 'ftp://127.0.0.1' }, 'misconfigured'],
    [{ LANGFUSE_BASE_URL: 'https://token@example.com' }, 'misconfigured'],
    [{ LANGFUSE_BASE_URL: env.LANGFUSE_BASE_URL + '/user-doc' }, 'misconfigured'],
    [{ LANGFUSE_BASE_URL: env.LANGFUSE_BASE_URL + '/?key=token' }, 'misconfigured'],
  ]) {
    const tracer = createTracing({ ...env, ...overrides });
    const result = await tracer.withTraceSpan('agent.task', (span) => {
      assert.equal(span.traceId, undefined);
      span.setTool('test-secret');
      span.setOutcome('timeout');
      return 42;
    });
    assert.equal(result, 42);
    await tracer.flush();
    assert.deepEqual(tracer.status(), { state, pending: 0, exported: 0, failed: 0, dropped: 0 });
  }
  assert.equal(requests.length, 0);
});

test('nested spans use random IDs scoped to concurrent tasks, never exporting arbitrary values', async (t) => {
  const { env, requests } = await collector(t);
  const tracer = createTracing(env);
  const privateText = 'private-chat-or-file-contents';
  const thrown = new Error(privateText);
  thrown.code = privateText;
  thrown.status = 429;
  const ids = await Promise.all(Array.from({ length: 3 }, (_, i) => tracer.withTraceSpan('agent.task', async (task) => {
    await new Promise((resolve) => setImmediate(resolve));
    const value = await tracer.withTraceSpan('tool.execute', async (tool) => {
      tool.setTool(i === 0 ? privateText : 'search_knowledge');
      return tracer.withTraceSpan('retrieval.search', (retrieval) => {
        retrieval.setOutcome(i === 0 ? privateText : 'empty');
        return privateText;
      });
    });
    assert.equal(value, privateText);
    await assert.rejects(tracer.withTraceSpan('model.call', () => { throw thrown; }), (error) => error === thrown);
    return task.traceId;
  })));
  // Instrumentation mistakes must not permit caller-controlled span names.
  assert.equal(await tracer.withTraceSpan(privateText, () => 7), 7);
  await tracer.flush();
  assert.equal(new Set(ids).size, ids.length);
  for (const request of requests) {
    assert.equal(request.url, '/api/public/otel/v1/traces');
    assert.equal(request.headers['x-langfuse-ingestion-version'], '4');
    assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('test-public:test-secret').toString('base64'));
    assert.doesNotMatch(request.body, /private-chat|test-secret|test-public|stack/);
  }
  const spans = exportedSpans(requests);
  assert.equal(spans.length, 12);
  for (const [i, traceId] of ids.entries()) {
    assert.match(traceId, /^[0-9a-f]{32}$/);
    const byName = Object.fromEntries(spans.filter((s) => s.traceId === traceId).map((s) => [s.name, s]));
    const task = byName['agent.task'];
    const tool = byName['tool.execute'];
    const retrieval = byName['retrieval.search'];
    const model = byName['model.call'];
    assert.equal(task.parentSpanId, undefined);
    assert.equal(tool.parentSpanId, task.spanId);
    assert.equal(retrieval.parentSpanId, tool.spanId);
    assert.equal(model.parentSpanId, task.spanId);
    assert.match(task.spanId, /^[0-9a-f]{16}$/);
    assert.ok(BigInt(task.endTimeUnixNano) >= BigInt(task.startTimeUnixNano));
    assert.equal(attr(task, 'langfuse.observation.type'), 'agent');
    assert.equal(attr(tool, 'langfuse.observation.metadata.tool'), i === 0 ? 'unknown' : 'search_knowledge');
    assert.equal(attr(retrieval, 'langfuse.observation.metadata.outcome'), i === 0 ? 'error' : 'empty');
    assert.equal(attr(model, 'langfuse.observation.metadata.outcome'), 'rate_limited');
    assert.equal(model.status.code, 2);
  }
});

test('work that begins after its originating span closes starts a fresh trace', async (t) => {
  const { env } = await collector(t);
  const tracer = createTracing(env);
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  let detached;
  const first = await tracer.withTraceSpan('agent.task', (span) => {
    detached = gate.then(() => tracer.withTraceSpan('model.call', (model) => model.traceId));
    return span.traceId;
  });
  resume();
  assert.notEqual(await detached, first);
  await tracer.flush();
});

test('collector redirects and rejected spans count as failures without forwarding secrets', async (t) => {
  const target = await collector(t);
  const source = await collector(t, (_request, response) => {
    response.writeHead(307, { location: target.env.LANGFUSE_BASE_URL + '/secret' });
    response.end();
  });
  const tracer = createTracing(source.env);
  assert.equal(await tracer.withTraceSpan('model.call', () => 123), 123);
  await tracer.flush();
  assert.deepEqual(tracer.status(), { state: 'enabled', pending: 0, exported: 0, failed: 1, dropped: 0 });
  assert.equal(source.requests.length, 1);
  assert.equal(target.requests.length, 0);

  const partial = await collector(t, (_request, response) => response.end('{"partialSuccess":{"rejectedSpans":"1"}}'));
  const partialTracer = createTracing(partial.env);
  await partialTracer.withTraceSpan('agent.task', () => partialTracer.withTraceSpan('model.call', () => true));
  await partialTracer.flush();
  assert.deepEqual(partialTracer.status(), { state: 'enabled', pending: 0, exported: 1, failed: 1, dropped: 0 });
});

test('a stalled collector cannot block task completion or accumulate unbounded spans/retries', async (t) => {
  const { env, requests } = await collector(t, (_request, response) => {
    response.writeHead(200);
    response.write('{'); // Deliberately leave the body unfinished until the exporter aborts.
  });
  const tracer = createTracing(env);
  await Promise.all(Array.from({ length: 200 }, () => tracer.withTraceSpan('retrieval.search', () => 'done')));
  assert.deepEqual(tracer.status(), { state: 'enabled', pending: 128, exported: 0, failed: 0, dropped: 72 });
  await tracer.flush();
  assert.deepEqual(tracer.status(), { state: 'enabled', pending: 0, exported: 0, failed: 128, dropped: 72 });
  assert.equal(requests.length, 1);
});
