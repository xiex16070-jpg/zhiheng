import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { openWebSearchKey } from './auth.mjs';
import { createCredentialCodec } from './credential-codec.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';

const PROVIDERS = ['tavily', 'serper', 'bing', 'openalex', 'europepmc'];
const WEB = ['tavily', 'serper', 'bing'];
const OPTIONAL_KEY = new Set(['openalex', 'europepmc']);
const problem = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export function validSearchKey(provider, key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{12,512}$/.test(key) && (provider !== 'tavily' || key.startsWith('tvly-'));
}

export function createWebSearchSettings({ file = path.join(config.dataDir, '.web-search.json'),
  initial = config.web, initialScholar = {}, onChange = () => {}, onScholarChange = () => {}, write = writeJsonAtomic } = {}) {
  const codec = createCredentialCodec(path.dirname(file));
  let selected = WEB.includes(initial.searchProvider) ? initial.searchProvider : 'tavily';
  let connections = Object.fromEntries(PROVIDERS.map(p => [p, { apiKey: '', enabled: OPTIONAL_KEY.has(p) }]));
  if (initial.searchKey) connections[selected] = { apiKey: initial.searchKey, enabled: true };
  connections.openalex.apiKey = initialScholar.openAlexKey || '';
  let fetchEnabled = initial.fetchEnabled !== false;
  let revision = 0, source = initial.searchKey ? 'environment' : 'empty', updatedAt = null, unreadable = false;
  function publish() {
    const enabled = WEB.filter(p => connections[p].enabled && connections[p].apiKey).map(provider => ({ provider, apiKey: connections[provider].apiKey }));
    const primary = enabled.find(c => c.provider === selected) || enabled[0];
    onChange({ searchProvider: primary?.provider || '', searchKey: primary?.apiKey || connections[selected].apiKey,
      searchConnections: enabled, fetchEnabled });
    onScholarChange({ openAlexKey: connections.openalex.apiKey, openAlexEnabled: connections.openalex.enabled,
      europePmcEnabled: connections.europepmc.enabled });
  }
  function status() {
    const rows = Object.fromEntries(PROVIDERS.map(p => [p, { configured: Boolean(connections[p].apiKey), enabled: connections[p].enabled, keyRequired: !OPTIONAL_KEY.has(p) }]));
    return { provider: selected, ...rows[selected], fetchEnabled, revision, source, updatedAt, unreadable, connections: rows,
      activeProviders: WEB.filter(p => connections[p].enabled && connections[p].apiKey) };
  }
  function credentials(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('invalid_settings', '搜索配置需要 JSON 对象。');
    const provider = input.provider ?? selected;
    if (!PROVIDERS.includes(provider)) throw problem('invalid_provider', '请选择支持的搜索服务。');
    if (input.apiKey !== undefined && typeof input.apiKey !== 'string') throw problem('invalid_key', 'API Key 格式无效。');
    const typed = input.apiKey?.trim() || '';
    const apiKey = typed || connections[provider].apiKey;
    if (!apiKey && !OPTIONAL_KEY.has(provider)) throw problem('missing_key', '请先填写该服务的 API Key。');
    if (apiKey && !validSearchKey(provider, apiKey)) throw problem('invalid_key', provider === 'tavily' ? '请填写以 tvly- 开头的有效 Tavily API Key。' : 'API Key 格式无效。');
    if (provider === 'europepmc' && apiKey) throw problem('invalid_key', 'Europe PMC 无需 API Key。');
    return { provider, apiKey };
  }
  return {
    status, credentials,
    async init() {
      try {
        const raw = await fs.readFile(file, 'utf8');
        if (raw.length > 24576) throw new Error('invalid_settings');
        const saved = JSON.parse(raw);
        if (![1, 2].includes(saved.version) || !PROVIDERS.includes(saved.provider) || !Number.isSafeInteger(saved.revision) || saved.revision < 1 || typeof saved.fetchEnabled !== 'boolean') throw new Error('invalid_settings');
        const loaded = Object.fromEntries(PROVIDERS.map(p => [p, { apiKey: '', enabled: OPTIONAL_KEY.has(p) }]));
        if (saved.version === 1) {
          const apiKey = saved.sealedKey ? openWebSearchKey(saved.sealedKey) : '';
          if (typeof saved.enabled !== 'boolean' || (apiKey && !validSearchKey(saved.provider, apiKey)) || (saved.enabled && !apiKey)) throw new Error('invalid_settings');
          loaded[saved.provider] = { apiKey, enabled: saved.enabled };
          loaded.openalex.apiKey = initialScholar.openAlexKey || '';
        } else {
          for (const p of PROVIDERS) {
            const row = saved.connections?.[p];
            if (!row || typeof row.enabled !== 'boolean') throw new Error('invalid_settings');
            const apiKey = row.sealedKey ? await codec.open(row.sealedKey, 'search:' + p) : '';
            if ((apiKey && !validSearchKey(p, apiKey)) || (!apiKey && row.enabled && !OPTIONAL_KEY.has(p))) throw new Error('invalid_settings');
            loaded[p] = { apiKey, enabled: row.enabled };
          }
        }
        connections = loaded; selected = saved.provider; fetchEnabled = saved.fetchEnabled;
        revision = saved.revision; updatedAt = saved.updatedAt || null; source = 'saved'; unreadable = false;
        if (saved.version === 1) {
          // Migrate once while the old login secret is still available. Keep the
          // old record intact if migration cannot be persisted.
          const record = { version: 2, revision, provider: selected, fetchEnabled, updatedAt, connections: {} };
          try {
            for (const p of PROVIDERS) record.connections[p] = { enabled: connections[p].enabled, sealedKey: connections[p].apiKey ? await codec.seal(connections[p].apiKey, 'search:' + p) : null };
            await write(file, record, { mode: 0o600 });
          } catch { /* Existing usable v1 credentials remain active until a save succeeds. */ }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          connections = Object.fromEntries(PROVIDERS.map(p => [p, { apiKey: '', enabled: false }]));
          selected = 'tavily'; source = 'saved'; unreadable = true;
        }
      }
      publish(); return status();
    },
    async save(input, { remove = false } = {}) {
      return withFileLock(file, async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['provider', 'apiKey', 'enabled', 'fetchEnabled', 'revision'].includes(k))) throw problem('invalid_settings', '搜索配置包含不支持的字段。');
        if (!Number.isSafeInteger(input.revision) || input.revision !== revision) throw problem('settings_conflict', '配置已在其他窗口更新，请重新读取后重试。', 409);
        if (!remove && (typeof input.enabled !== 'boolean' || typeof input.fetchEnabled !== 'boolean')) throw problem('invalid_settings', '请设置搜索与网页读取状态。');
        const provider = input.provider ?? selected;
        if (!PROVIDERS.includes(provider)) throw problem('invalid_provider', '请选择支持的搜索服务。');
        const next = { ...connections, [provider]: remove ? { apiKey: '', enabled: false } : { apiKey: credentials(input).apiKey, enabled: input.enabled } };
        const record = { version: 2, revision: revision + 1, provider, fetchEnabled: remove ? fetchEnabled : input.fetchEnabled,
          updatedAt: new Date().toISOString(), connections: {} };
        try {
          for (const p of PROVIDERS) record.connections[p] = { enabled: next[p].enabled, sealedKey: next[p].apiKey ? await codec.seal(next[p].apiKey, 'search:' + p) : null };
          await write(file, record, { mode: 0o600 });
        } catch { throw problem('settings_save_failed', '配置未能保存，请重试。当前搜索配置未改变。', 500); }
        connections = next; selected = provider; fetchEnabled = record.fetchEnabled; revision = record.revision;
        updatedAt = record.updatedAt; source = 'saved'; unreadable = false;
        publish(); return status();
      });
    },
  };
}

export const webSearchSettings = createWebSearchSettings({ initialScholar: config.scholar,
  onChange: value => Object.assign(config.web, value), onScholarChange: value => Object.assign(config.scholar, value) });
