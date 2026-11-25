import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { createCredentialCodec } from './credential-codec.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';
function filename(uid) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(uid)) || uid === '_global') throw new Error('invalid_user');
  return path.join(config.dataDir, 'integration-settings', uid + '.json');
}
export async function readIntegrationSettings(uid) {
  try {
    const value = JSON.parse(await fs.readFile(filename(uid), 'utf8'));
    const raw = JSON.parse(await createCredentialCodec(config.dataDir).open(value, 'integrations:' + uid));
    return { revision: raw.revision || 0, zoteroEnabled: raw.zoteroEnabled === true, zoteroLocalApiKey: String(raw.zoteroLocalApiKey || '') };
  } catch (e) { if (e.code === 'ENOENT') return { revision: 0, zoteroEnabled: false, zoteroLocalApiKey: '' }; throw new Error('integration_settings_unreadable'); }
}
export async function integrationSettingsStatus(uid) { const row = await readIntegrationSettings(uid); return { revision: row.revision, zoteroEnabled: row.zoteroEnabled, zoteroKeyConfigured: Boolean(row.zoteroLocalApiKey) }; }
export async function saveIntegrationSettings(uid, input) {
  if (!input || Object.keys(input).some(k => !['revision','zoteroEnabled','zoteroLocalApiKey','clearZoteroKey'].includes(k)) ||
      typeof input.zoteroEnabled !== 'boolean' || !Number.isInteger(input.revision) ||
      (input.zoteroLocalApiKey !== undefined && (typeof input.zoteroLocalApiKey !== 'string' || !/^[\x21-\x7e]{0,2048}$/.test(input.zoteroLocalApiKey)))) throw new Error('invalid_integration_settings');
  return withFileLock(filename(uid), async () => {
    const prior = await readIntegrationSettings(uid); if (input.revision !== prior.revision) throw new Error('integration_settings_conflict');
    const next = { revision: prior.revision + 1, zoteroEnabled: input.zoteroEnabled,
      zoteroLocalApiKey: input.clearZoteroKey === true ? '' : input.zoteroLocalApiKey || prior.zoteroLocalApiKey };
    await writeJsonAtomic(filename(uid), await createCredentialCodec(config.dataDir).seal(JSON.stringify(next), 'integrations:' + uid), { mode: 0o600 });
    return { revision: next.revision, zoteroEnabled: next.zoteroEnabled, zoteroKeyConfigured: Boolean(next.zoteroLocalApiKey) };
  });
}
