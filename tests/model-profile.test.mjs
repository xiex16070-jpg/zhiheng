import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildLocalModelProfile, verifyLocalModelProfile } from '../src/server/model-profile.mjs';
import { isLocalQwen } from '../src/server/local-qwen.mjs';
import { trajectorySha } from '../src/server/trajectory.mjs';
import { createBackendCapabilities } from '../src/server/backend-capabilities.mjs';

test('profile identifies actual prompt variants, tool schemas and budgets with an order-independent digest', () => {
  const profile = buildLocalModelProfile([]);
  const { profileSha, ...content } = profile;
  assert.equal(profileSha, trajectorySha(content));
  assert.equal(trajectorySha({ a: 1, z: 2 }), trajectorySha({ z: 2, a: 1 }));
  assert.ok(Object.keys(profile.variants).length >= 36);
  assert.notEqual(profileSha, trajectorySha({ ...content, budgets: { contextTokens: 8192 } }));
  assert.equal(isLocalQwen({ profileId: 'local-qwen', model: 'arbitrary-served-id', baseUrl: 'http://127.0.0.1:8018/v1' }), true);
  assert.equal(isLocalQwen({ profileId: 'local-qwen', model: 'arbitrary-served-id', baseUrl: 'https://remote.example/v1' }), false);
});

test('profile handshake binds trusted runtime declarations without changing the prompt/profile digest', async () => {
  const registry = createBackendCapabilities(), profile = buildLocalModelProfile([]);
  const provider = { baseUrl: 'http://localhost:8018/v1', model: 'fixture', apiKey: 'synthetic' };
  let url;
  const row = { id: 'fixture', profileId: profile.id, profileSha: profile.profileSha, runtime: { name: 'zhiheng-transformers', version: '1', instance: 'server' },
    capabilities: { schema: 'zhiheng-backend-capabilities/1', features: { tools: true, auto: true, tokenize: true, required: true } } };
  const binding = await verifyLocalModelProfile(provider, { profile, registry, fetchImpl: async target => { url = target; return new Response(JSON.stringify({ data: [row] })); } });
  assert.equal(url, 'http://127.0.0.1:8018/v1/models');
  assert.equal(binding.profileSha, profile.profileSha);
  assert.equal(binding.backendCapabilities.features.tools, 'supported');
  assert.equal(binding.backendCapabilities.features.required, 'unsupported');
  assert.equal(registry.get({ ...provider, ...binding }).features.tokenize, 'supported');
  row.profileSha = 'f'.repeat(64);
  await assert.rejects(verifyLocalModelProfile(provider, { profile, registry, fetchImpl: async () => new Response(JSON.stringify({ data: [row] })) }), /mismatch/);
  assert.equal(registry.get({ ...provider, ...binding }).source, 'unknown');
});

test('explicit profile handshake uses the matching served model and refuses stale or absent hashes', async t => {
  const profile = buildLocalModelProfile([]); let advertised = profile.profileSha;
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'candidate', profileId: 'local-qwen', profileSha: advertised }] })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'candidate' };
  assert.equal((await verifyLocalModelProfile(provider, { profile })).profileSha, profile.profileSha);
  advertised = 'a'.repeat(64);
  await assert.rejects(verifyLocalModelProfile(provider, { profile }), /mismatch/);
  await assert.rejects(verifyLocalModelProfile({ ...provider, model: 'wrong' }, { profile }), /mismatch/);
});
