import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendCapabilities, backendConnectionKey, selectBackendRequest, unsupportedRequestFeature } from '../src/server/backend-capabilities.mjs';
const provider = { baseUrl: 'http://127.0.0.1:8018/v1', model: 'qwen-fixture', apiKey: 'synthetic', profileId: 'local-qwen', profileSha: 'a'.repeat(64), adapterSha: 'b'.repeat(64) };
const declaration = { runtime: { name: 'zhiheng-transformers', version: '1', instance: 'fixture' }, capabilities: { schema: 'zhiheng-backend-capabilities/1', features: { tools: true, auto: true, none: true, tokenize: true } } };
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];

test('capability cache binds endpoint path, model, credential, scope, runtime and has TTL and explicit invalidation', () => {
  let clock = 1000; const registry = createBackendCapabilities({ ttlMs: 100, now: () => clock });
  const original = registry.attestLocal(provider, declaration);
  assert.equal(registry.get(provider).features.tools, 'supported');
  for (const changed of [{ baseUrl: 'http://127.0.0.1:8018/V1' }, { model: 'other' }, { apiKey: 'other' }, { userId: 'other' }]) {
    assert.notEqual(backendConnectionKey({ ...provider, ...changed }), backendConnectionKey(provider));
    assert.equal(registry.get({ ...provider, ...changed }).source, 'unknown');
  }
  original.features.tools = 'unsupported'; assert.equal(registry.get(provider).features.tools, 'supported');
  clock = 1100; assert.equal(registry.get(provider).source, 'unknown');
  registry.attestLocal(provider, declaration); registry.invalidate(provider); assert.equal(registry.get(provider).source, 'unknown');
  for (const changed of [{ backendRuntime: { ...declaration.runtime, version: '2' } }, { backendRuntime: { ...declaration.runtime, instance: 'restart' } }, { profileSha: 'c'.repeat(64) }, { adapterSha: 'd'.repeat(64) }]) {
    registry.attestLocal(provider, declaration); assert.equal(registry.get({ ...provider, ...changed }).source, 'unknown');
  }
});

test('self-reported capabilities never upgrade a request or an unrecognized runtime', () => {
  const registry = createBackendCapabilities();
  const request = { ...provider, backendCapabilities: { features: { required: 'supported', strictTools: 'supported' } } };
  assert.throws(() => selectBackendRequest(request, { tools, toolChoice: 'required' }, registry), error => error.state === 'unknown');
  assert.throws(() => registry.attestLocal({ ...provider, baseUrl: 'https://remote.example/v1' }, declaration), /unverified/);
  assert.throws(() => registry.attestLocal({ ...provider, profileSha: '' }, declaration), /unverified/);
  const forged = structuredClone(declaration); forged.capabilities.features.required = true; forged.capabilities.features.jsonSchema = true;
  assert.equal(registry.attestLocal(provider, forged).features.required, 'unsupported');
  assert.equal(registry.get(provider).features.jsonSchema, 'unsupported');
  forged.runtime.version = 'unreviewed'; assert.equal(registry.attestLocal(provider, forged).features.tools, 'unknown');
});

test('a repeated profile declaration cannot erase observed rejection or extend its expiry; runtime restart can reset it', () => {
  let clock = 1000; const registry = createBackendCapabilities({ ttlMs: 100, now: () => clock });
  registry.attestLocal(provider, declaration); registry.observeUnsupported(provider, 'tools');
  clock = 1050;
  const refreshed = registry.attestLocal(provider, declaration);
  assert.equal(refreshed.features.tools, 'unsupported'); assert.equal(Date.parse(refreshed.expiresAt), 1100);
  clock = 1100;
  assert.equal(registry.attestLocal(provider, declaration).features.tools, 'supported');
  registry.observeUnsupported(provider, 'tools');
  const restarted = { ...declaration, runtime: { ...declaration.runtime, instance: 'new-process' } };
  assert.equal(registry.attestLocal(provider, restarted).features.tools, 'supported');
});

test('unknown backend keeps compatibility auto, confirmed unsupported never silently drops tools', () => {
  const registry = createBackendCapabilities();
  const unknown = selectBackendRequest(provider, { tools }, registry);
  assert.equal(unknown.toolMode, 'compatibility-auto'); assert.equal(unknown.capabilities.features.tools, 'unknown');
  assert.deepEqual(unknown.fields, { tools, tool_choice: 'auto' });
  registry.observeUnsupported(provider, 'tools');
  assert.throws(() => selectBackendRequest(provider, { tools }, registry), error => error.code === 'backend_capability_unsupported');
  assert.equal(selectBackendRequest(provider, {}, registry).toolMode, 'none');
  assert.deepEqual(selectBackendRequest(provider, { tools, toolChoice: 'none' }, registry).fields, {});
});

test('verified local runtime selects native auto/none and refuses unsupported control guarantees', () => {
  const registry = createBackendCapabilities(); registry.attestLocal(provider, declaration);
  assert.equal(selectBackendRequest(provider, { tools }, registry).toolMode, 'native');
  assert.deepEqual(selectBackendRequest(provider, { tools, toolChoice: 'none' }, registry).fields, { tool_choice: 'none' });
  for (const options of [{ tools, toolChoice: 'required' }, { tools, toolChoice: { type: 'function', function: { name: 'read_file' } } },
    { tools: [{ ...tools[0], function: { ...tools[0].function, strict: true } }] }, { responseFormat: { type: 'json_schema' } },
    { responseFormat: { type: 'json_object' } }, { parallelToolCalls: true }, { parallelToolCalls: false }]) {
    assert.throws(() => selectBackendRequest(provider, options, registry), error => error.code === 'backend_capability_unsupported' && error.state === 'unsupported');
  }
  assert.throws(() => selectBackendRequest(provider, { tools, toolChoice: { type: 'function', function: { name: 'unlisted' } } }, registry), /unknown_named_tool/);
});

test('error classification accepts explicit unsupported top-level fields but not tool schema/context failures', () => {
  for (const message of ['Invalid parameter tools[0].function.parameters: missing properties', 'tools[0].function.parameters.type is not supported', 'tool_choice references an unknown function', 'Invalid temperature parameter', 'Context length exceeded']) {
    assert.equal(unsupportedRequestFeature({ status: 400, message }), null, message);
  }
  assert.equal(unsupportedRequestFeature({ status: 400, message: 'Unsupported parameter: stream_options' }), 'streamOptions');
  assert.equal(unsupportedRequestFeature({ status: 400, message: 'This model does not support function calling' }), 'tools');
  assert.equal(unsupportedRequestFeature({ status: 400, upstreamError: { param: 'tools', code: 'unsupported_parameter' } }), 'tools');
  assert.equal(unsupportedRequestFeature({ status: 400, upstreamError: { param: 'tools[0].function.parameters', code: 'unsupported_parameter' } }), null);
  assert.equal(unsupportedRequestFeature({ status: 500, message: 'tools are not supported' }), null);
});
