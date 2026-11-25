import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { createCredentialCodec } from './credential-codec.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';
import { verifyLocalModelProfile } from './model-profile.mjs';
import { backendCapabilities } from './backend-capabilities.mjs';

const problem = (code, message, status = 400) => Object.assign(new Error(message), { code, message, status });
export function createModelConnections({ file = path.join(config.dataDir, '.model-connections.json'), verifyProfile = verifyLocalModelProfile } = {}) {
  const codec = createCredentialCodec(path.dirname(file));
  let profiles = [], active = '', activeImage = '', revision = 0, unreadable = false;
  const requireReadable = () => {
    if (unreadable) throw problem('settings_unreadable', '模型配置无法读取，已停止写入以保留原文件。请从备份恢复配置后重启服务。', 409);
  };
  const publicProfile = p => ({ id: p.id, baseUrl: p.baseUrl, model: p.model, preset: p.preset,
    capability: p.capability || 'chat', vision: p.vision === true, enabled: p.enabled !== false,
    savedKeyId: p.apiKey ? p.id : '', apiKey: '', configured: Boolean(p.apiKey), profileId: p.profileId || '', profileSha: p.profileSha || '', adapterSha: p.adapterSha || null,
    backendCapabilities: backendCapabilities.get(p) });
  const status = () => ({ revision, unreadable, profiles: profiles.map(publicProfile), active: profiles.find(p => p.id === active) ? publicProfile(profiles.find(p => p.id === active)) : null,
    activeImage: profiles.find(p => p.id === activeImage) ? publicProfile(profiles.find(p => p.id === activeImage)) : null });
  async function persist(next, selected, selectedImage = activeImage) {
    requireReadable();
    const records = [];
    try {
      for (const p of next) records.push({ id: p.id, baseUrl: p.baseUrl, model: p.model, preset: p.preset, capability: p.capability || 'chat', vision: p.vision === true, enabled: p.enabled !== false,
        profileId: p.profileId || '', profileSha: p.profileSha || '', adapterSha: p.adapterSha || null,
        sealedKey: p.apiKey ? await codec.seal(p.apiKey, 'model:' + p.id) : null });
      await writeJsonAtomic(file, { version: 1, revision: revision + 1, active: selected, activeImage: selectedImage, profiles: records }, { mode: 0o600 });
    } catch { throw problem('settings_save_failed', '模型配置未能保存，原配置未改变。', 500); }
    profiles = next; active = selected; activeImage = selectedImage; revision++; unreadable = false;
    return status();
  }
  return {
    status,
    async init() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        if (raw.length > 256 * 1024) throw new Error('invalid_store');
        const record = JSON.parse(raw);
        if (record.version !== 1 || !Array.isArray(record.profiles) || record.profiles.length > 30 || !Number.isSafeInteger(record.revision)) throw new Error('invalid_store');
        const loaded = [];
        for (const p of record.profiles) loaded.push({ ...p, apiKey: p.sealedKey ? await codec.open(p.sealedKey, 'model:' + p.id) : '' });
        profiles = loaded; active = record.active; activeImage = record.activeImage || ''; revision = record.revision; unreadable = false;
      } catch (error) { if (error.code !== 'ENOENT') unreadable = true; }
      return status();
    },
    resolve(id, baseUrl) {
      requireReadable();
      const row = profiles.find(p => p.id === id && p.baseUrl === baseUrl && (p.capability || 'chat') === 'chat');
      if (!row?.apiKey) throw problem('saved_key_unavailable', '保存的模型密钥不可用，请在设置中重新选择接口。');
      return row.apiKey;
    },
    // Caller must first enforce the local-settings authentication boundary.
    imageProvider() {
      if (unreadable) return null;
      const row = profiles.find(p => p.id === activeImage && p.capability === 'image' && p.enabled !== false);
      if (!row) return null;
      return { ...row, enabled: true, local: ['127.0.0.1','localhost','[::1]'].includes(new URL(row.baseUrl).hostname) };
    },
    async remove(input) {
      return withFileLock(file, async () => {
        requireReadable();
        if (!input || Object.keys(input).some(k => !['savedKeyId','revision'].includes(k)) || !profiles.some(p => p.id === input.savedKeyId)) throw problem('invalid_settings', '请选择已保存的模型接口。');
        if (input.revision !== revision) throw problem('settings_conflict', '模型配置已更新，请重新打开设置。', 409);
        const next = profiles.filter(p => p.id !== input.savedKeyId);
        backendCapabilities.invalidate(profiles.find(p => p.id === input.savedKeyId));
        return persist(next, active === input.savedKeyId ? next.filter(p => (p.capability || 'chat') === 'chat').at(-1)?.id || '' : active,
          activeImage === input.savedKeyId ? '' : activeImage);
      });
    },
    async save(input) {
      return withFileLock(file, async () => {
        requireReadable();
        if (!input || Object.keys(input).some(k => !['baseUrl', 'model', 'preset', 'apiKey', 'revision', 'capability', 'vision', 'enabled', 'profileId'].includes(k))) throw problem('invalid_settings', '模型配置字段无效。');
        if (!Number.isSafeInteger(input.revision) || input.revision !== revision) throw problem('settings_conflict', '模型配置已更新，请重新打开设置。', 409);
        const baseUrl = String(input.baseUrl || '').trim().replace(/\/$/, '');
        let url;
        try { url = new URL(baseUrl); } catch { throw problem('invalid_settings', '接口地址无效。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || baseUrl.length > 512) throw problem('invalid_settings', '接口地址无效。');
        if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160 || (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || !/^[\x21-\x7E]{0,1024}$/.test(input.apiKey)))) throw problem('invalid_settings', '模型名或密钥格式无效。');
        const capability = input.capability || 'chat';
        if (!['chat','image'].includes(capability) || (input.vision !== undefined && typeof input.vision !== 'boolean') || (input.enabled !== undefined && typeof input.enabled !== 'boolean')) throw problem('invalid_settings', '能力配置无效。');
        if (capability === 'image' && url.protocol !== 'https:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw problem('invalid_settings', '图像服务需要 HTTPS 或本机回环地址。');
        const id = crypto.createHash('sha256').update(baseUrl + (capability === 'image' ? ':image' : '')).digest('hex').slice(0, 24);
        const prior = profiles.find(p => p.id === id);
        if (prior) backendCapabilities.invalidate(prior);
        const row = { id, baseUrl, model: input.model.trim(), preset: String(input.preset || 'custom').slice(0, 64), apiKey: input.apiKey || prior?.apiKey || '',
          capability, vision: capability === 'chat' && (input.vision ?? prior?.vision ?? false), enabled: input.enabled ?? prior?.enabled ?? true };
        row.profileId = input.profileId ?? prior?.profileId ?? '';
        if (!['', 'local-qwen'].includes(row.profileId) || (capability !== 'chat' && row.profileId)) throw problem('invalid_profile', '请选择有效的对话模型协议。');
        if (row.profileId) {
          try { Object.assign(row, await verifyProfile(row)); }
          catch { throw problem('local_profile_mismatch', '本地模型协议尚未验证，或提示词与工具版本不一致。请导出当前 profile 并以该文件启动服务后重试。', 409); }
        }
        const next = [...profiles.filter(p => p.id !== id), row];
        if (next.length > 30) throw problem('invalid_settings', '最多保存 30 个模型接口。');
        return persist(next, capability === 'chat' ? id : active, capability === 'image' ? id : activeImage);
      });
    },
  };
}
export const modelConnections = createModelConnections();
