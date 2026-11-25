/**
 * 服务端模型客户端：OpenAI 兼容协议，SSE 流式 + 工具调用。
 * 内置重试（指数退避）与熔断（连续失败后快速失败），保证工作流可恢复。
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { config } from './config.mjs';
import { incr } from './metrics.mjs';
import { pinnedLookup } from './netguard.mjs';
import { withTraceSpan } from './tracing.mjs';
import { beginContextRequest, finishContextRequest } from './context-metrics.mjs';
import { backendCapabilities, selectBackendRequest, unsupportedRequestFeature } from './backend-capabilities.mjs';
import { verifyLocalModelProfile } from './model-profile.mjs';

export class LLMError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

// 熔断按上游地址分别计数：一家供应商失败，不该把其他供应商一起熔断掉
const breakers = new Map();

function providerKey(provider) {
  return crypto.createHash('sha256')
    .update(`${String(provider?.baseUrl || '').toLowerCase()}\n${String(provider?.apiKey || '')}`)
    .digest('hex')
    .slice(0, 20);
}

function breakerOf(key) {
  const k = key || '_default';
  if (!breakers.has(k)) {
    if (breakers.size >= 1000) breakers.delete(breakers.keys().next().value);
    breakers.set(k, { failures: 0, openedAt: 0, lastRateLimitAt: 0 });
  }
  return breakers.get(k);
}

export function breakerState(key = '') {
  const b = breakerOf(key);
  const open = b.failures >= config.workflow.breakerThreshold && Date.now() - b.openedAt < config.workflow.breakerCooldownMs;
  return { open, failures: b.failures, openedAt: b.openedAt };
}

function recordSuccess(key) {
  breakerOf(key).failures = 0;
}

function recordFailure(key) {
  const b = breakerOf(key);
  b.failures += 1;
  if (b.failures >= config.workflow.breakerThreshold) b.openedAt = Date.now();
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new LLMError('已取消', { code: 'aborted' }));
  const timer = setTimeout(done, ms);
  const onAbort = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(new LLMError('已取消', { code: 'aborted' }));
  };
  function done() {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }
  signal?.addEventListener('abort', onAbort, { once: true });
});

function parseSSE(block) {
  let data = '';
  for (const line of block.split(/\r\n|\n|\r/)) {
    const t = line.trim();
    if (t.startsWith('data:')) data += `${data ? '\n' : ''}${t.slice(5).trim()}`;
  }
  return data;
}

/** R05（N-05）：消息字段白名单，剔除内部标记；undefined 字段不落进 JSON */
function sanitizeMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const out = { role: m.role };
    if (m.content !== undefined) out.content = m.content;
    if (m.tool_calls !== undefined) out.tool_calls = m.tool_calls;
    if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
    if (m.name !== undefined) out.name = m.name;
    return out;
  });
}

async function once({ provider, payload, signal, onDelta, onReasoning, breakerKey: key }) {
  if (signal?.aborted) throw new LLMError('已取消', { code: 'aborted' });
  const url = new URL(`${String(provider.baseUrl).replace(/\/$/, '')}/chat/completions`);
  const body = JSON.stringify(payload);
  const mod = url.protocol === 'https:' ? https : http;

  let requestRef = null;
  const totalTimer = setTimeout(() => requestRef?.destroy(new Error('llm_total_timeout')), config.workflow.llmTimeoutMs);
  let res;
  try {
    res = await new Promise((resolve, reject) => {
      const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        ...(provider.resolvedIps?.length ? { lookup: pinnedLookup(provider.resolvedIps) } : {}),
        ...(provider.resolvedIps?.length ? { agent: false } : {}),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'text/event-stream',
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        },
      },
      resolve
    );
      requestRef = req;
      req.setTimeout(config.workflow.llmTimeoutMs, () => req.destroy(new Error('llm_timeout')));
      req.on('error', reject);
      const onAbort = () => req.destroy(new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal?.removeEventListener('abort', onAbort));
      req.write(body);
      req.end();
    });
  } catch (err) {
    clearTimeout(totalTimer);
    throw err;
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    const text = await new Promise((resolve) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve(buf));
      res.on('error', () => resolve(buf));
    });
    // 把上游的错误原因带出来，否则前端只能看到「上游返回 400」，无法排查
    let detail = '', upstreamError = null;
    try {
      const j = JSON.parse(text);
      if (j?.error && typeof j.error === 'object') upstreamError = { message: j.error.message, code: j.error.code, param: j.error.param };
      detail =
        j?.error?.message ||
        j?.message ||
        (typeof j?.error === 'string' ? j.error : '') ||
        j?.error?.code ||
        '';
    } catch {
      detail = text.replace(/\s+/g, ' ').trim();
    }
    detail = String(detail).slice(0, 180);

    const hint = hintFor(detail);
    const retryable = res.statusCode === 429 || res.statusCode >= 500;
    const head = detail ? `上游返回 ${res.statusCode}：${detail}` : `上游返回 ${res.statusCode}`;

    // 限流时优先按上游给的时间等待：Retry-After 头，或错误文案里的「after N seconds」
    let retryAfterMs = 0;
    const ra = Number(res.headers?.['retry-after']);
    if (Number.isFinite(ra) && ra > 0) retryAfterMs = Math.min(ra * 1000, 30000);
    else {
      const m = /after\s+(\d+(?:\.\d+)?)\s*second/i.exec(detail) || /retry\s+after\s+(\d+)/i.exec(detail);
      if (m) retryAfterMs = Math.min(Number(m[1]) * 1000, 30000);
    }

    if (res.statusCode === 429) breakerOf(key).lastRateLimitAt = Date.now();

    clearTimeout(totalTimer);
    throw Object.assign(new LLMError(hint ? `${head}（${hint}）` : head, {
      status: res.statusCode,
      code: text.slice(0, 400),
      retryable,
      retryAfterMs,
    }), { upstreamError });
  }

  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  const toolMap = new Map();
  let doneSeen = false;
  const decoder = new StringDecoder('utf8');

  const consume = (data) => {
    if (!data) return;
    if (data === '[DONE]') {
      doneSeen = true;
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new LLMError('模型流包含无法解析的 SSE 事件', { code: 'invalid_sse' });
    }
    if(chunk?.error) {
      const code=String(chunk.error.code || 'upstream_stream_error').slice(0,80);
      throw new LLMError(`模型在生成期间返回错误（${code.replace(/[^\w.-]/g,'')}），本次回答未完成。`,{code,retryable:false});
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    if (delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onReasoning?.(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const key = tc.index ?? 0;
        const acc = toolMap.get(key) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name = tc.function.name;
        if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        toolMap.set(key, acc);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };

  try {
    await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const drain = (final = false) => {
      while (true) {
        const match = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
        if (!match) break;
        const part = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (part.trim()) consume(parseSSE(part));
      }
      if (final && buffer.trim()) {
        consume(parseSSE(buffer));
        buffer = '';
      }
    };
    res.on('data', (piece) => {
      buffer += decoder.write(piece);
      try {
        drain(false);
      } catch (err) {
        res.destroy();
        finish(reject, err);
      }
    });
    res.on('end', () => {
      try {
        buffer += decoder.end();
        drain(true);
        if (!doneSeen && !finishReason) {
          throw new LLMError('模型流提前结束，未收到完成标记', { code: 'incomplete_sse', retryable: true });
        }
        finish(resolve);
      } catch (err) {
        finish(reject, err);
      }
    });
    res.on('error', (err) => {
      if (err.message === 'aborted' || signal?.aborted) {
        const e = new Error('aborted');
        e.name = 'AbortError';
        finish(reject, e);
        return;
      }
      finish(reject, err);
    });
    });
  } finally {
    clearTimeout(totalTimer);
  }

  const toolCalls = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v], i) => ({ ...v, id: v.id || `call_${i}` }))
    .filter((t) => t.function.name);

  return { content, reasoning, toolCalls, finishReason, usage };
}

export async function streamChat({ provider, messages, tools, toolChoice = 'auto', responseFormat, parallelToolCalls, temperature = 0.2, maxTokens, signal, onDelta, onReasoning, maxAttempts }) {
  if(maxAttempts !== undefined && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)) throw new LLMError('调用次数上限无效',{code:'invalid_max_attempts'});
  if (provider.profileId === 'local-qwen' && backendCapabilities.get(provider).source === 'unknown') {
    provider = { ...provider, ...await verifyLocalModelProfile(provider) };
  }
  const selection = selectBackendRequest(provider, { tools, toolChoice, responseFormat, parallelToolCalls });
  const key = providerKey(provider);
  const state = breakerState(key);
  if (state.open) {
    throw new LLMError('模型服务连续失败，已熔断，请稍后重试', { code: 'breaker_open', retryable: true });
  }

  const payload = {
    model: provider.model,
    // R05（N-05）：只发送协议标准字段——内部标记（如 _compacted）不得外泄给上游
    messages: sanitizeMessages(messages),
    stream: true,
    temperature,
    stream_options: { include_usage: true },
    ...selection.fields,
  };
  if (maxTokens !== undefined) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new LLMError('生成token预算无效', { code: 'invalid_max_tokens' });
    payload.max_tokens = maxTokens;
  }

  let lastErr;
  let tempAdjusted = false;
  // 限流（429）允许多试几次：上游常要求等 1~2 秒
  const hardLimit = maxAttempts === undefined ? config.workflow.maxRetries + 2 : maxAttempts - 1;

  for (let attempt = 0; attempt <= hardLimit; attempt++) {
    const telemetry = await beginContextRequest({provider,messages,tools:payload.tools,maxTokens:payload.max_tokens,attempt}).catch(()=>null);
    try {
      await incr('llm_calls');
      const result = await withTraceSpan('model.call', async (span) => {
        const completion = await once({ provider, payload, signal, onDelta, onReasoning, breakerKey: key });
        if (completion.finishReason === 'length') span.setOutcome('output_limit');
        return completion;
      });
      if (toolChoice === 'none' && result.toolCalls?.length) throw new LLMError('模型违反了禁用工具调用的请求。', { code: 'unexpected_tool_calls' });
      recordSuccess(key);
      await finishContextRequest(telemetry,result,null).catch(()=>{});
      return { ...result, backendCapabilities: selection.capabilities, toolMode: selection.toolMode };
    } catch (err) {
      await finishContextRequest(telemetry,null,err).catch(()=>{});
      lastErr = err;
      await incr('llm_errors');
      const aborted = err.name === 'AbortError';
      if (aborted && signal?.aborted) throw new LLMError('已取消', { code: 'aborted' });
      if (!(err instanceof LLMError)) {
        err = new LLMError(String(err.message || err), {
          code: String(err.code || 'network_error'),
          retryable: true,
        });
        lastErr = err;
      }
      const msg = String(err.message || '');
      const unsupported = unsupportedRequestFeature(err);
      if (unsupported && unsupported !== 'streamOptions') {
        const feature = unsupported === 'jsonSchema' && responseFormat?.type === 'json_object' ? 'jsonObject'
          : unsupported === 'auto' && toolChoice !== 'auto' ? (typeof toolChoice === 'object' ? 'named' : toolChoice) : unsupported;
        backendCapabilities.observeUnsupported(provider, feature);
        throw new LLMError(`模型接口明确拒绝能力 ${feature}；工具和参数已保留，未降级作答。`, { status: err.status, code: 'backend_capability_unsupported' });
      }
      // Parameter fallback is still an HTTP call and must respect the same budget.
      if (attempt >= hardLimit) break;

      // 部分模型只接受固定 temperature（如「only 1 is allowed for this model」），
      // 按上游要求调整后重试；只调一次，避免死循环。
      if (!tempAdjusted && err.status === 400 && /temperature/i.test(msg)
        && /only\s+[\d.]+\s+is\s+allowed|must be\s+[\d.]+(?:[.,\s]|$)/i.test(msg)) {
        tempAdjusted = true;
        const m = /only\s+([\d.]+)\s+is\s+allowed/i.exec(msg) || /must be\s+([\d.]+)/i.exec(msg);
        const allowed = m ? Number(m[1]) : 1;
        if (Number.isFinite(allowed) && allowed !== payload.temperature) payload.temperature = allowed;
        else delete payload.temperature;
        await incr('llm_param_fallback');
        continue;
      }

      // stream_options 只是用来回报 token 用量，属于可选参数。
      // 只有明确不支持该字段时重试，不能掩盖其他参数或 schema 错误。
      if (unsupported === 'streamOptions' && payload.stream_options) {
        delete payload.stream_options;
        await incr('llm_param_fallback');
        continue;
      }

      const retryable = err.retryable || aborted;
      const limit = err.status === 429 ? hardLimit : config.workflow.maxRetries;
      if (!retryable || attempt >= limit) break;
      await incr('llm_retries');
      // 优先按上游要求的时间等，其次指数退避
      const backoff = 400 * 2 ** attempt;
      await sleep(Math.min(Math.max(backoff, err.retryAfterMs || 0), 30000), signal);
    }
  }

  if (!lastErr?.status || lastErr.status === 429 || lastErr.status >= 500 || lastErr.retryable) recordFailure(key);
  throw lastErr instanceof LLMError ? lastErr : new LLMError(String(lastErr?.message || lastErr));
}

export function llmStatus() {
  // 监控面板要的是全局视图：任一供应商熔断即提示，同时给出各家的计数
  const states = [...breakers.keys()].map((k) => breakerState(k));
  return {
    open: states.some((s) => s.open),
    failures: states.reduce((a, s) => Math.max(a, s.failures), 0),
    openedAt: states.reduce((a, s) => Math.max(a, s.openedAt), 0),
    providers: states.length,
  };
}

/**
 * 最近是否被限流（30 秒内出现过 429）。
 * 用于跳过「查询改写」这类可选的额外调用，把配额留给主回答。
 */
export function isRateLimited(provider = null, windowMs = 30000) {
  if (!provider) return false;
  return Date.now() - breakerOf(providerKey(provider)).lastRateLimitAt < windowMs;
}

/* ---------------------------------------------------------------- 连接测试 */

/** 单次 HTTP 请求（直连，绕开系统代理），返回状态码与解析后的 JSON */
function httpJson(urlStr, { method = 'GET', apiKey = '', body = null, timeout = 15000, resolvedIps = null } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error('接口地址格式不正确'));
      return;
    }
    const mod = url.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));

    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        ...(resolvedIps?.length ? { lookup: pinnedLookup(resolvedIps) } : {}),
        ...(resolvedIps?.length ? { agent: false } : {}),
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('连接超时')));
    req.on('error', (err) => {
      const code = err.code || '';
      if (code === 'ENOTFOUND') reject(new Error('域名解析失败，请检查接口地址'));
      else if (code === 'ECONNREFUSED') reject(new Error('连接被拒绝，目标端口未开放'));
      else if (code === 'CERT_HAS_EXPIRED') reject(new Error('TLS 证书已过期'));
      else reject(new Error(err.message || '网络错误'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** 把常见的上游错误翻成「该怎么办」，只做提示，不改变原始信息 */
const UPSTREAM_HINTS = [
  {
    re: /not activated|activate.{0,20}product|product.{0,20}not.{0,10}activat|未开通|未激活/i,
    hint: '该模型服务未开通：请到百炼控制台开通对应模型，或确认专属实例已部署完成',
  },
  {
    re: /workspace endpoint is invalid|endpoint is invalid|invalid (?:workspace|endpoint)/i,
    hint: '接口地址与 Key 不匹配：确认专属实例地址、API Key、工作空间三者属于同一账号',
  },
  {
    re: /invalid api key|incorrect api key|invalid_api_key|unauthorized|authentication/i,
    hint: 'API Key 无效：确认 Key 与当前接口地址属于同一个账号',
  },
  {
    re: /model.{0,30}(not exist|not found|does not exist)|model_not_found|no such model/i,
    hint: '模型名不存在：用「测试连接」列出的模型名，或换公共站地址',
  },
  {
    re: /insufficient|quota|balance|arrears|欠费|余额不足/i,
    hint: '额度不足或账户欠费',
  },
  {
    re: /rate limit|too many requests|throttl/i,
    hint: '请求过于频繁，稍后重试',
  },
  {
    re: /context length|maximum context|too many tokens/i,
    hint: '上下文超长：可调小检索条数或缩短对话历史',
  },
  {
    re: /tool|function calling/i,
    hint: '请检查该接口的工具能力与参数格式；系统不会静默删除工具后作答',
  },
];

function hintFor(text) {
  const t = String(text || '');
  for (const h of UPSTREAM_HINTS) if (h.re.test(t)) return h.hint;
  return '';
}

function upstreamMessage(res) {
  return (
    res.json?.error?.message ||
    res.json?.message ||
    (typeof res.json?.error === 'string' ? res.json.error : '') ||
    res.text.slice(0, 160)
  );
}

/**
 * 测试模型接口是否可用。
 * 优先 GET /models（不消耗额度）；网关没有该端点时退化为一次 max_tokens=1 的对话。
 *
 * @returns {Promise<{ok:boolean, via:'models'|'chat', models:string[], model?:string, message:string}>}
 */
export async function probeProvider({ baseUrl, apiKey = '', model = '', resolvedIps = null }) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!/^https?:\/\//.test(base)) throw new Error('接口地址必须以 http:// 或 https:// 开头');

  const list = await httpJson(`${base}/models`, { apiKey, timeout: 12000, resolvedIps });

  if (list.status >= 200 && list.status < 300) {
    const models = (list.json?.data || list.json?.models || [])
      .map((m) => (typeof m === 'string' ? m : m?.id || m?.name))
      .filter(Boolean);
    const hasModel = model ? models.includes(model) : true;

    // 模型列表能返回不代表这个模型能跑：百炼等平台会把未开通的模型也列出来，
    // 真正调用才报「The product is not activated」。指定了模型就实测一次。
    if (model) {
      const chat = await httpJson(`${base}/chat/completions`, {
        method: 'POST',
        apiKey,
        timeout: 30000,
        resolvedIps,
        body: {
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 16,
          stream: false,
        },
      });
      if (chat.status < 200 || chat.status >= 300) {
        const raw = upstreamMessage(chat);
        const h = hintFor(raw);
        const prefix = hasModel ? `模型「${model}」在列表中，但实际调用被拒` : `模型「${model}」不可用`;
        throw new Error(`${prefix}（${chat.status}）：${raw}${h ? `（${h}）` : ''}`);
      }
      return {
        ok: true,
        via: 'chat',
        models,
        hasModel,
        model,
        message: `连接成功：可用模型 ${models.length} 个，已用「${model}」实测一次调用`,
      };
    }

    return {
      ok: true,
      via: 'models',
      models,
      hasModel,
      model: undefined,
      message: models.length ? `连接成功，可用模型 ${models.length} 个，例如 ${models.slice(0, 4).join('、')}` : '连接成功',
    };
  }

  if (list.status === 401 || list.status === 403) {
    throw new Error(`API Key 无效或无权访问（${list.status}）`);
  }

  // 部分网关不实现 /models，退化为一次最小对话
  if ((list.status === 404 || list.status === 405 || list.status === 400) && model) {
    const chat = await httpJson(`${base}/chat/completions`, {
      method: 'POST',
      apiKey,
      timeout: 25000,
      resolvedIps,
      body: {
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      },
    });
    if (chat.status >= 200 && chat.status < 300) {
      return { ok: true, via: 'chat', models: [model], model, message: `连接成功（该接口没有 /models，已用 ${model} 实测一次调用）` };
    }
    if (chat.status === 401 || chat.status === 403) throw new Error(`API Key 无效或无权访问（${chat.status}）`);
    if (chat.status === 404) throw new Error(`接口地址不对：${base}/chat/completions 返回 404`);
    {
      const raw = upstreamMessage(chat);
      const h = hintFor(raw);
      throw new Error(`模型调用失败（${chat.status}）：${raw}${h ? `（${h}）` : ''}`);
    }
  }

  if (list.status === 404) throw new Error(`接口地址不对：${base}/models 返回 404，请确认 Base URL 是否包含 /v1`);
  {
    const raw = upstreamMessage(list);
    const h = hintFor(raw);
    throw new Error(`接口返回 ${list.status}：${raw}${h ? `（${h}）` : ''}`);
  }
}
