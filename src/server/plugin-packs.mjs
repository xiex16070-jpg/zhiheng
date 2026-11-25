import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { resolveSafe } from './workspace.mjs';
import { createSkill, readSkill, archiveSkill, parseFrontmatter } from './skills.mjs';
import { createCredentialCodec } from './credential-codec.mjs';
import { writeJsonAtomic, withFileLock } from './fsutil.mjs';

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const privateFile = userId => {
  if (!ID.test(String(userId)) || userId === '_global') throw new Error('invalid_user');
  return path.join(config.dataDir, 'plugin-packs', userId + '.json');
};
const codec = () => createCredentialCodec(config.dataDir);
async function load(userId) {
  try {
    const raw = await fs.readFile(privateFile(userId), 'utf8');
    if (raw.length > 600000) throw new Error('pack_registry_too_large');
    const entries = JSON.parse(await codec().open(JSON.parse(raw), `plugin-packs:${userId}`));
    if (!Array.isArray(entries) || entries.length > 20) throw new Error('invalid_pack_registry');
    return entries;
  } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
async function save(userId, entries) { await writeJsonAtomic(privateFile(userId), await codec().seal(JSON.stringify(entries), `plugin-packs:${userId}`), { mode: 0o600 }); }
const publicPack = p => ({ id: p.id, name: p.name, version: p.version, description: p.description, installedAt: p.installedAt,
  skills: p.skills.map(s => s.name), mcpServers: p.mcpServers.map((s,index) => ({ index, name: s.name, kind: s.kind, target: s.kind === 'stdio' ? path.basename(s.command) : new URL(s.url).host, status: 'requires_explicit_connection' })),
  capabilities: p.capabilities, extensionIds: p.extensionIds || [] });

/** A pack is declarative data. No archive extraction, shell scripts, remote fetches or MCP discovery occur here. */
export function validatePluginManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_manifest');
  const keys = new Set(['name','version','description','skills','mcpServers','capabilities']);
  if (Object.keys(value).some(k => !keys.has(k))) throw new Error('manifest_unknown_field');
  if (!NAME.test(value.name || '') || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(value.version || '') ||
      typeof value.description !== 'string' || value.description.length > 300) throw new Error('invalid_manifest_identity');
  const skills = value.skills || [], servers = value.mcpServers || [], capabilities = value.capabilities || [];
  if (!Array.isArray(skills) || skills.length > 20 || new Set(skills).size !== skills.length ||
      skills.some(s => typeof s !== 'string' || !/^(?:[a-zA-Z0-9_.-]+\/)*SKILL\.md$/.test(s) || s.split('/').some(p => p === '..' || p === '.'))) throw new Error('invalid_skill_paths');
  if (!Array.isArray(servers) || servers.length > 5 || !Array.isArray(capabilities) || capabilities.length > 20 || capabilities.some(c => typeof c !== 'string' || c.length > 60)) throw new Error('invalid_pack_limits');
  for (const s of servers) {
    if (!s || typeof s !== 'object' || Array.isArray(s) || !['stdio','http'].includes(s.kind) || typeof s.name !== 'string' || !s.name.trim() || s.name.length > 80) throw new Error('invalid_mcp_draft');
    const allowed = new Set(['name','kind', ...(s.kind === 'stdio' ? ['command','args','env'] : ['url','token'])]);
    if (Object.keys(s).some(k => !allowed.has(k))) throw new Error('mcp_draft_unknown_field');
    if (s.kind === 'stdio') {
      if (typeof s.command !== 'string' || !path.isAbsolute(s.command) || s.command.length > 400 ||
          (s.args && (!Array.isArray(s.args) || s.args.length > 30 || s.args.some(a => typeof a !== 'string' || a.length > 2000)))) throw new Error('invalid_mcp_command');
      if (s.env && (typeof s.env !== 'object' || Array.isArray(s.env) || Object.keys(s.env).length > 20 || Object.entries(s.env).some(([k,v]) => !/^[A-Z][A-Z0-9_]{0,79}$/.test(k) || typeof v !== 'string' || v.length > 2000))) throw new Error('invalid_mcp_environment');
    } else {
      let u; try { u = new URL(s.url); } catch { throw new Error('invalid_mcp_url'); }
      if (u.username || u.password || u.hash || u.search || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)))) throw new Error('invalid_mcp_url');
      if (s.token !== undefined && (typeof s.token !== 'string' || !/^[\x21-\x7e]{0,2048}$/.test(s.token))) throw new Error('invalid_mcp_token');
    }
  }
  return { ...value, skills, mcpServers: servers, capabilities };
}
async function boundedWorkspaceText(userId, filename, max) {
  const r = await resolveSafe(userId, filename); if (r.error) throw new Error('pack_path_rejected');
  const stat = await fs.stat(r.abs);
  if (!stat.isFile() || stat.nlink > 1 || stat.size > max) throw new Error('pack_file_too_large');
  const text = await fs.readFile(r.abs, 'utf8'); if (Buffer.byteLength(text) > max) throw new Error('pack_file_too_large');
  return text;
}
export async function installPluginPack(userId, manifestPath, { signal } = {}) {
  return withFileLock(privateFile(userId), async () => {
    signal?.throwIfAborted();
    if (!/(?:^|[\\/])plugin\.json$/i.test(manifestPath || '')) throw new Error('plugin_json_required');
    const manifest = validatePluginManifest(JSON.parse(await boundedWorkspaceText(userId, manifestPath, 64000)));
    const entries = await load(userId);
    if (entries.length >= 20 || entries.some(p => p.name === manifest.name)) throw new Error('pack_exists_or_limit');
    const prepared = [];
    for (const relative of manifest.skills) {
      const raw = await boundedWorkspaceText(userId, path.posix.join(path.dirname(manifestPath).replaceAll('\\','/'), relative), 20000);
      const fm = parseFrontmatter(raw), name = String(fm.name || '');
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || !fm.description || fm.description.length > 60 || !fm.body.trim() || fm.body.length > (config.learning.skillBodyMax || 8000) || prepared.some(s => s.name === name)) throw new Error('invalid_pack_skill');
      // No shadowing existing global/own skills during installation.
      if (await readSkill(name, { userId })) throw new Error('pack_skill_name_conflict');
      prepared.push({ name, description: fm.description, body: fm.body.trim() });
    }
    const created = [];
    try {
      for (const skill of prepared) {
        signal?.throwIfAborted();
        const result = await createSkill({ ...skill, userId, actor: 'plugin-pack', tags: ['plugin-pack'] });
        if (!result.ok) throw new Error('pack_skill_rejected_' + result.code);
        created.push({ name: skill.name, hash: digest((await readSkill(skill.name, { userId })).raw) });
      }
      const entry = { id: crypto.randomUUID(), name: manifest.name, version: manifest.version, description: manifest.description,
        installedAt: new Date().toISOString(), skills: created, mcpServers: manifest.mcpServers, capabilities: manifest.capabilities, extensionIds: [] };
      await save(userId, [...entries, entry]);
      return { ok: true, pack: publicPack(entry), message: '技能已安装到个人作用域。MCP 配置仅作为待连接草案，必须在扩展设置中明确连接并选择允许的工具。' };
    } catch (err) {
      for (const skill of created) await archiveSkill(skill.name, { userId, actor: 'plugin-pack', reason: 'pack_install_rollback' }).catch(() => {});
      throw err;
    }
  });
}
export async function listPluginPacks(userId) { return (await load(userId)).map(publicPack); }
/** Settings route only: returning a draft grants no execution permission. Existing extensions.save must validate/test it. */
export async function pluginPackMcpDraft(userId, id, index) {
  const pack = (await load(userId)).find(p => p.id === id), server = pack?.mcpServers[index];
  if (!Number.isInteger(index) || !server) throw new Error('pack_server_not_found');
  return { ...server, enabled: false, allowedTools: [] };
}
export async function linkPluginPackExtension(userId, id, extensionId) {
  if (!ID.test(extensionId)) throw new Error('invalid_extension_id');
  return withFileLock(privateFile(userId), async () => {
    const entries = await load(userId), entry = entries.find(p => p.id === id); if (!entry) throw new Error('pack_not_found');
    entry.extensionIds = [...new Set([...(entry.extensionIds || []), extensionId])]; await save(userId, entries);
  });
}
export async function removePluginPack(userId, id, { removeExtension } = {}) {
  return withFileLock(privateFile(userId), async () => {
    const entries = await load(userId), entry = entries.find(p => p.id === id); if (!entry) throw new Error('pack_not_found');
    const retained = [];
    for (const s of entry.skills) {
      const current = await readSkill(s.name, { userId });
      if (!current || current.scope !== 'own') continue;
      if (digest(current.raw) !== s.hash) { retained.push(s.name); continue; }
      const result = await archiveSkill(s.name, { userId, actor: 'plugin-pack', reason: 'pack_uninstall' });
      if (!result.ok) retained.push(s.name);
    }
    for (const extensionId of entry.extensionIds || []) {
      if (!removeExtension) throw new Error('pack_extension_removal_handler_required');
      await removeExtension(extensionId);
    }
    await save(userId, entries.filter(p => p !== entry));
    return { ok: true, retained, message: retained.length ? '已移除插件包；用户修改或固定的技能已保留。' : '已移除插件包并归档其技能。' };
  });
}
