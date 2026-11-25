import crypto from 'node:crypto';

// Protocol capabilities are not permissions. Nothing here authorizes a tool or
// relaxes its argument validator, user/workspace scope, or approval requirement.
const FEATURES = ['tools', 'auto', 'none', 'required', 'named', 'strictTools', 'jsonObject', 'jsonSchema', 'tokenize', 'parallelToolCalls'];
const UNKNOWN = Object.fromEntries(FEATURES.map(name => [name, 'unknown']));
const LOCAL_V1 = { tools: true, auto: true, none: true, required: false, named: false,
  strictTools: false, jsonObject: false, jsonSchema: false, tokenize: true, parallelToolCalls: false };
const clone = value => structuredClone(value);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function endpoint(provider) {
  const url = new URL(provider.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_backend_endpoint');
  return url.href.replace(/\/$/, ''); // Keep path case; /v1 and /V1 may be different gateways.
}
export function backendConnectionKey(provider) {
  return digest(JSON.stringify([endpoint(provider), String(provider.model || ''), String(provider.apiKey || ''), String(provider.userId || provider.ownerId || '')]));
}
function runtimeIdentity(runtime = {}, provider = {}) {
  return { name: String(runtime.name || '').slice(0, 100), version: String(runtime.version || '').slice(0, 100),
    instance: String(runtime.instance || '').slice(0, 100), profileSha: String(provider.profileSha || ''), adapterSha: provider.adapterSha || null };
}
function unknown(provider, now) {
  return { schema: 'zhiheng-backend-capabilities/1', endpoint: endpoint(provider), model: String(provider.model || ''),
    source: 'unknown', runtime: runtimeIdentity(provider.backendRuntime, provider), features: { ...UNKNOWN }, observedAt: new Date(now).toISOString(), expiresAt: null };
}
function rejectFeature(value, feature) {
  value.features[feature] = 'unsupported';
  if (feature === 'tools') for (const mode of ['auto', 'required', 'named', 'strictTools', 'parallelToolCalls']) value.features[mode] = 'unsupported';
}
export function createBackendCapabilities({ ttlMs = 300000, now = Date.now, maxEntries = 256 } = {}) {
  const entries = new Map();
  function read(provider) {
    const key = backendConnectionKey(provider), entry = entries.get(key);
    if (!entry) return null;
    const runtime = provider.backendRuntime;
    if (entry.until <= now() || (provider.profileSha && entry.value.runtime.profileSha !== provider.profileSha)
      || (Object.hasOwn(provider, 'adapterSha') && entry.value.runtime.adapterSha !== provider.adapterSha)
      || (runtime && ['name', 'version', 'instance'].some(field => runtime[field] !== entry.value.runtime[field]))) {
      entries.delete(key); return null;
    }
    return entry;
  }
  function put(provider, value, { rejections = [], until = now() + ttlMs } = {}) {
    const key = backendConnectionKey(provider), at = now();
    entries.delete(key);
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    const stored = { ...value, observedAt: new Date(at).toISOString(), expiresAt: new Date(until).toISOString() };
    entries.set(key, { until, rejections: [...rejections], value: clone(stored) });
    return clone(stored);
  }
  return {
    get(provider) { return clone(read(provider)?.value || unknown(provider, now())); },
    // Internal call only, after the loopback/profile digest handshake. Untrusted
    // request JSON and saved settings are never passed to this method.
    attestLocal(provider, declaration) {
      const url = new URL(endpoint(provider));
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || provider.profileId !== 'local-qwen' || !/^[a-f0-9]{64}$/.test(provider.profileSha || '')) throw new Error('unverified_backend_declaration');
      const value = unknown(provider, now()), runtime = runtimeIdentity(declaration?.runtime, provider);
      value.runtime = runtime;
      value.source = 'verified-profile';
      const declared = declaration?.capabilities;
      if (runtime.name === 'zhiheng-transformers' && runtime.version === '1' && declared?.schema === value.schema) {
        value.source = 'verified-local-runtime';
        for (const name of FEATURES) {
          // A service cannot claim an unimplemented feature, even with a matching
          // public profile digest. Missing positive claims remain unknown.
          value.features[name] = !LOCAL_V1[name] || declared.features?.[name] === false ? 'unsupported'
            : declared.features?.[name] === true ? 'supported' : 'unknown';
        }
      }
      const previous = read(provider);
      if (previous?.rejections.length && JSON.stringify(previous.value.runtime) === JSON.stringify(runtime)) {
        // A fresh declaration is weaker than a concrete rejection from the same
        // runtime. Do not reset its original TTL on every profile handshake.
        for (const feature of previous.rejections) rejectFeature(value, feature);
        return put(provider, value, { rejections: previous.rejections, until: previous.until });
      }
      return put(provider, value);
    },
    observeUnsupported(provider, feature) {
      if (!FEATURES.includes(feature)) return;
      const value = this.get(provider);
      value.source = value.source === 'unknown' ? 'observed-rejection' : value.source;
      rejectFeature(value, feature);
      return put(provider, value, { rejections: [...new Set([...(read(provider)?.rejections || []), feature])] });
    },
    invalidate(provider) { entries.delete(backendConnectionKey(provider)); },
    clear() { entries.clear(); },
  };
}
export const backendCapabilities = createBackendCapabilities();

export class BackendCapabilityError extends Error {
  constructor(feature, state) {
    super(`模型接口能力 ${feature} ${state === 'unsupported' ? '不支持' : '尚未验证'}；未发送请求，也未降级为无工具回答。`);
    this.code = 'backend_capability_unsupported'; this.feature = feature; this.state = state; this.retryable = false;
  }
}

/** Compatibility auto is allowed for unknown backends; opt-in guarantees require evidence. */
export function selectBackendRequest(provider, { tools, toolChoice = 'auto', responseFormat, parallelToolCalls } = {}, registry = backendCapabilities) {
  const capabilities = registry.get(provider), fields = {}, hasTools = Boolean(tools?.length);
  const need = (name, allowUnknown = false) => {
    const state = capabilities.features[name];
    if (state !== 'supported' && !(allowUnknown && state === 'unknown')) throw new BackendCapabilityError(name, state);
  };
  const named = typeof toolChoice === 'object' && toolChoice?.type === 'function' && typeof toolChoice.function?.name === 'string';
  if (!named && !['auto', 'none', 'required'].includes(toolChoice)) throw Object.assign(new Error('invalid_tool_choice'), { code: 'invalid_tool_choice' });
  if ((named || toolChoice === 'required') && !hasTools) throw Object.assign(new Error('tool_choice_requires_tools'), { code: 'invalid_tool_choice' });
  if (named && !tools.some(tool => tool.function?.name === toolChoice.function.name)) throw Object.assign(new Error('unknown_named_tool'), { code: 'invalid_tool_choice' });
  let toolMode = 'none';
  if (hasTools && toolChoice !== 'none') {
    need('tools', toolChoice === 'auto'); need(named ? 'named' : toolChoice, toolChoice === 'auto');
    if (tools.some(tool => tool.function?.strict === true)) need('strictTools');
    fields.tools = tools; fields.tool_choice = toolChoice;
    toolMode = capabilities.features.tools === 'supported' ? 'native' : 'compatibility-auto';
  } else if (toolChoice === 'none' && capabilities.features.none === 'supported') fields.tool_choice = 'none';
  if (parallelToolCalls !== undefined) {
    if (typeof parallelToolCalls !== 'boolean') throw Object.assign(new Error('invalid_parallel_tool_calls'), { code: 'invalid_parallel_tool_calls' });
    need('parallelToolCalls'); fields.parallel_tool_calls = parallelToolCalls;
  }
  if (responseFormat !== undefined) {
    if (!responseFormat || !['text', 'json_object', 'json_schema'].includes(responseFormat.type)) throw Object.assign(new Error('invalid_response_format'), { code: 'invalid_response_format' });
    if (responseFormat.type !== 'text') need(responseFormat.type === 'json_object' ? 'jsonObject' : 'jsonSchema');
    fields.response_format = responseFormat;
  }
  return { fields, toolMode, capabilities };
}

/** Reject only explicit feature-level errors. A malformed function schema is not lack of tool support. */
export function unsupportedRequestFeature(error) {
  if (error?.status !== 400) return null;
  const raw = error.upstreamError || {}, message = String(raw.message || error.message || '').slice(0, 1000);
  const param = String(raw.param || ''), code = String(raw.code || '');
  const fieldMap = { tools: 'tools', tool_choice: 'auto', response_format: 'jsonSchema', parallel_tool_calls: 'parallelToolCalls', stream_options: 'streamOptions' };
  if (Object.hasOwn(fieldMap, param) && ['unsupported_parameter', 'unknown_parameter', 'unrecognized_parameter'].includes(code)) return fieldMap[param];
  for (const [field, feature] of Object.entries(fieldMap)) {
    if (new RegExp(`(?:unsupported|unknown|unrecognized) (?:parameter|argument|field)\\s*:?\\s*['\"]?${field}['\"]?(?:[.,;:]|\\s|$)`, 'i').test(message)
      || new RegExp(`(?:^|[\\s:'\"])${field}['\"]? (?:is |are )?(?:not supported|unsupported)(?:[.,;:]|\\s|$)`, 'i').test(message)) return feature;
  }
  if (/\b(?:model|backend|server)\b.{0,50}\bdoes not support (?:tools|function calling)\b/i.test(message)) return 'tools';
  return null;
}
