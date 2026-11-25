import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-llm-stream-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTH_SECRET = ['llm', 'stream', 'test'].join('-');

let mode = 'crlf';
let hits = 0;
const received = [];
const mock = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  received.push(JSON.parse(body));
  hits += 1;
  if (mode === 'schema-error' || mode === 'tools-unsupported' || (mode === 'stream-options-unsupported' && JSON.parse(body).stream_options)) {
    const message = mode === 'schema-error' ? 'Invalid parameter tools[0].function.parameters: missing properties' : mode === 'tools-unsupported' ? 'This model does not support function calling' : 'Unsupported parameter: stream_options';
    res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message } })); return;
  }
  if(mode==='parameter-error'){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'temperature must be 1'}}));return;}
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  if(mode==='stream-error'){res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: {"error":{"code":"generation_failed","message":"private error"}}\n\ndata: [DONE]\n\n');return;}
  if (mode === 'crlf' || mode === 'stream-options-unsupported') {
    const event = Buffer.from('data: {"choices":\r\ndata: [{"delta":{"content":"你🙂"},"finish_reason":"stop"}]}\r\n\r\n');
    const emojiAt = event.indexOf(Buffer.from('🙂'));
    res.write(event.subarray(0, emojiAt + 1));
    res.write(event.subarray(emojiAt + 1));
    res.end('data: [DONE]\r\n\r\n');
    return;
  }
  if (mode === 'malformed') {
    res.end('data: {not-json}\r\n\r\n');
    return;
  }
  res.end('data: {"choices":[{"delta":{"content":"半截"},"finish_reason":null}]}\r\n\r\n');
});

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));

const { streamChat } = await import('../src/server/llm.mjs');
const provider = {
  baseUrl: `http://127.0.0.1:${mock.address().port}/v1`,
  apiKey: 'stream-key',
  model: 'mock',
};

after(() => {
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LLM SSE 支持 CRLF、多行 data 与 UTF-8 分片', async () => {
  mode = 'crlf';
  let streamed = '';
  const r = await streamChat({
    provider,
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (text) => { streamed += text; },
  });
  assert.equal(r.content, '你🙂');
  assert.equal(streamed, '你🙂');
  assert.equal(r.finishReason, 'stop');
});

test('LLM SSE 畸形 JSON 不再被静默吞掉', async () => {
  mode = 'malformed';
  await assert.rejects(
    streamChat({ provider, messages: [{ role: 'user', content: 'hi' }] }),
    /无法解析/
  );
});

test('LLM SSE 无 DONE 且无 finish_reason 时判定为不完整并重试', async () => {
  mode = 'incomplete';
  const before = hits;
  await assert.rejects(
    streamChat({ provider, messages: [{ role: 'user', content: 'hi' }] }),
    /提前结束/
  );
  assert.ok(hits - before >= 2, '可重试的不完整流应按策略重试');
});

test('explicit one-call budget includes parameter fallbacks and network retries',async()=>{
  mode='parameter-error';const before=hits;
  await assert.rejects(streamChat({provider:{...provider,model:'judge-one-call'},messages:[{role:'user',content:'test'}],maxAttempts:1}));
  assert.equal(hits-before,1);
  await assert.rejects(streamChat({provider,messages:[],maxAttempts:0}),/调用次数上限/);
});

test('an upstream SSE error cannot turn partial output into a successful answer',async()=>{
  mode='stream-error';const before=hits;
  await assert.rejects(streamChat({provider:{...provider,model:'native-stream-error'},messages:[{role:'user',content:'hi'}]}),error=>error.code==='generation_failed'&&!error.message.includes('private error'));
  assert.equal(hits-before,1);
});

test('schema errors are not retried without optional fields or silently converted into text-only answers', async () => {
  mode = 'schema-error'; const before = hits;
  await assert.rejects(streamChat({ provider: { ...provider, model: 'schema' }, messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'read_file' } }] }), /Invalid parameter/);
  assert.equal(hits - before, 1);
  assert.ok(received.at(-1).tools); assert.ok(received.at(-1).stream_options);
});

test('unsupported tools stop on the first rejection and the scoped TTL cache prevents blind repeats', async () => {
  mode = 'tools-unsupported'; const before = hits, selected = { ...provider, model: 'unsupported' };
  const request = { provider: selected, messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'read_file' } }] };
  await assert.rejects(streamChat(request), error => error.code === 'backend_capability_unsupported');
  await assert.rejects(streamChat(request), error => error.code === 'backend_capability_unsupported');
  assert.equal(hits - before, 1); assert.ok(received.at(-1).tools);
});

test('only explicit stream_options rejection retries, preserving tools and exposing unknown capabilities', async () => {
  mode = 'stream-options-unsupported'; const before = hits;
  const result = await streamChat({ provider: { ...provider, model: 'stream-options' }, messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'read_file' } }] });
  assert.equal(hits - before, 2); assert.equal(result.content, '你🙂');
  assert.equal(result.backendCapabilities.features.tools, 'unknown'); assert.equal(result.toolMode, 'compatibility-auto');
  assert.ok(received.at(-1).tools); assert.equal(received.at(-1).stream_options, undefined);
});
