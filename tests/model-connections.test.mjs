import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createModelConnections } from '../src/server/model-connections.mjs';
import { backendCapabilities } from '../src/server/backend-capabilities.mjs';

test('损坏模型配置拒绝保存与删除，保留原始字节供恢复', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-model-corrupt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json');
  const original = '{"version":1,"profiles": damaged';
  await fs.writeFile(file, original);
  const vault = createModelConnections({ file });
  assert.equal((await vault.init()).unreadable, true);
  await assert.rejects(vault.save({ baseUrl: 'https://models.example.org/v1', model: 'replacement', apiKey: 'synthetic-key', revision: 0 }), error => error.code === 'settings_unreadable');
  await assert.rejects(vault.remove({ savedKeyId: 'missing', revision: 0 }), error => error.code === 'settings_unreadable');
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(vault.imageProvider(), null);
});

test('连接能力来自当前握手而非设置自报，切换模型和删除后旧缓存失效', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-model-capability-cache-'));
  const file = path.join(dir, 'models.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binding = { profileId: 'local-qwen', profileSha: 'a'.repeat(64), adapterSha: null };
  const verifyProfile = async provider => {
    const capabilities = backendCapabilities.attestLocal({ ...provider, ...binding }, {
      runtime: { name: 'zhiheng-transformers', version: '1', instance: 'settings-test' },
      capabilities: { schema: 'zhiheng-backend-capabilities/1', features: { tools: true, auto: true } } });
    return { ...binding, backendRuntime: capabilities.runtime };
  };
  const vault = createModelConnections({ file, verifyProfile }); await vault.init();
  const input = { baseUrl: 'http://127.0.0.1:18888/v1', model: 'first', apiKey: 'synthetic-capabilities-key', profileId: 'local-qwen', revision: 0 };
  await assert.rejects(vault.save({ ...input, backendCapabilities: { tools: true } }), error => error.code === 'invalid_settings');
  const first = await vault.save(input);
  assert.equal(first.active.backendCapabilities.features.tools, 'supported');
  assert.ok(!JSON.stringify(first).includes(input.apiKey));
  const second = await vault.save({ ...input, model: 'second', revision: 1 });
  assert.equal(backendCapabilities.get({ ...input, ...binding }).source, 'unknown');
  assert.equal(second.active.backendCapabilities.features.tools, 'supported');
  await vault.remove({ savedKeyId: second.active.id, revision: 2 });
  assert.equal(backendCapabilities.get({ ...input, model: 'second', ...binding }).source, 'unknown');
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('backendCapabilities'));
});

test('模型接口独立保存；换会话、登录密钥轮换与新实例均能恢复；密钥绑定完整 endpoint', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-model-vault-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json'), key = 'synthetic-model-secret';
  const vault = createModelConnections({ file }); await vault.init();
  const first = await vault.save({ baseUrl: 'https://api.example.com/v1', model: 'test', preset: 'example', apiKey: key, revision: 0 });
  const id = first.active.savedKeyId;
  await vault.save({ baseUrl: 'https://another.example.com/v1', model: 'test2', apiKey: 'second-synthetic-secret', revision: 1 });
  await vault.save({ baseUrl: 'https://api.example.com/v1', model: 'test3', apiKey: '', revision: 2 });
  const reloaded = createModelConnections({ file }); await reloaded.init();
  assert.equal(reloaded.status().profiles.length, 2);
  assert.equal(reloaded.resolve(id, 'https://api.example.com/v1'), key);
  assert.throws(() => reloaded.resolve(id, 'https://evil.example.com/v1'), /不可用/);
  assert.throws(() => reloaded.resolve(id, 'https://api.example.com/v2'), /不可用/);
  assert.ok(!JSON.stringify(reloaded.status()).includes(key));
  assert.ok(!(await fs.readFile(file, 'utf8')).includes(key));
  await assert.rejects(reloaded.save({ baseUrl: 'https://api.example.com/v1', model: 'x', revision: 1 }), /已更新/);
  const removed = await reloaded.remove({ savedKeyId: id, revision: 3 });
  assert.equal(removed.profiles.length, 1);
  assert.throws(() => reloaded.resolve(id, 'https://api.example.com/v1'), /不可用/);
  const afterRemoval = createModelConnections({ file }); await afterRemoval.init();
  assert.equal(afterRemoval.status().profiles.length, 1);
  assert.equal(afterRemoval.status().active.baseUrl, 'https://another.example.com/v1');
});

test('30 个接近上限的模型配置保存后仍能重启读取，不受旧 64 KiB 阈值影响', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-model-vault-capacity-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json'), vault = createModelConnections({ file }); await vault.init();
  for (let revision = 0; revision < 30; revision++) await vault.save({ revision,
    baseUrl: 'https://example.org/' + 'a'.repeat(490) + revision, model: 'm'.repeat(160), preset: 'p'.repeat(64), apiKey: 'synthetic-'.padEnd(1024, 'k') });
  assert.ok((await fs.stat(file)).size > 65536);
  const loaded = createModelConnections({ file }); await loaded.init();
  assert.equal(loaded.status().unreadable, false);
  assert.equal(loaded.status().profiles.length, 30);
  assert.equal(loaded.resolve(loaded.status().active.savedKeyId, loaded.status().active.baseUrl), 'synthetic-'.padEnd(1024, 'k'));
});

test('同一端点对话与图像分别加密保存，图像不改变对话 active，视觉标记重启保留', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-model-capabilities-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'models.json'), vault = createModelConnections({ file }); await vault.init();
  const chat = await vault.save({ baseUrl: 'https://models.example.org/v1', model: 'vision-chat', apiKey: 'synthetic-chat', vision: true, revision: 0 });
  const images = await vault.save({ baseUrl: 'https://models.example.org/v1', model: 'image-fixture', apiKey: 'synthetic-image', capability: 'image', enabled: true, revision: 1 });
  assert.equal(images.profiles.length, 2); assert.equal(images.active.model, 'vision-chat'); assert.equal(images.active.vision, true);
  assert.notEqual(images.active.savedKeyId, images.activeImage.savedKeyId);
  assert.throws(() => vault.resolve(images.activeImage.savedKeyId, images.activeImage.baseUrl), /不可用/);
  assert.equal(vault.imageProvider().apiKey, 'synthetic-image');
  const reload = createModelConnections({ file }); await reload.init();
  assert.equal(reload.status().active.vision,true);assert.equal(reload.imageProvider().model,'image-fixture');
  const disabled = await reload.save({ baseUrl: images.activeImage.baseUrl, model: images.activeImage.model, capability:'image',enabled:false,revision:2 });
  assert.equal(reload.imageProvider(),null);assert.equal(disabled.active.savedKeyId,chat.active.savedKeyId);
  const removed = await reload.remove({savedKeyId:images.activeImage.id,revision:3});assert.equal(removed.activeImage,null);assert.equal(removed.active.model,'vision-chat');
});
