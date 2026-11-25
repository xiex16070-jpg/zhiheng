import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_RE } from './auth.mjs';
import { config } from './config.mjs';
import { readWorkspaceBinary } from './file-tools.mjs';
import { threatScan } from './memory.mjs';
import { validatePluginManifest } from './plugin-packs.mjs';
import { inspectSkillDocument, MAX_DOCUMENT_BYTES } from './agent-skill-format.mjs';
import { parseFrontmatter, readSkill } from './skills.mjs';
import { resolveSafe } from './workspace.mjs';
import { currentWorkspace, withWorkspaceTask } from './workspace-selection.mjs';

const RESOURCE_DIRS = ['references', 'reference', 'scripts', 'assets', 'agents'];
const issue = (level, code, message) => ({ level, code, message });
const failure = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const absent = e => e?.code === 'ENOENT' || e?.code === 'ENOTDIR';
const below = (folder, child) => folder === '.' ? child : folder + '/' + child;

function safePath(userId, relative) {
  const target = resolveSafe(userId, relative);
  if (target.error) throw failure('preflight_path_rejected', '路径不可用，请选择当前工作区内的相对路径。');
  return target;
}

async function statEntry(userId, relative) {
  const target = safePath(userId, relative);
  try { return await fs.lstat(target.abs); }
  catch (e) { if (absent(e)) return null; throw e; }
}

async function findEntry(userId, relative) {
  if (typeof relative !== 'string' || !relative.trim() || relative.length > 240) {
    throw failure('invalid_preflight_path', '请填写技能目录、SKILL.md 或 plugin.json 的相对路径。');
  }
  const selected = relative.trim() === '.' ? '.' : safePath(userId, relative).rel;
  if (selected !== '.' && (await statEntry(userId, selected))?.isFile()) {
    if (['SKILL.md', 'plugin.json'].includes(path.posix.basename(selected))) return selected;
    throw failure('invalid_preflight_entry', '技能入口文件名应为 SKILL.md 或 plugin.json。');
  }
  // A manifest can declare the skill at its own root as well as sibling skills.
  for (const filename of ['plugin.json', 'SKILL.md']) {
    const entry = below(selected, filename);
    if ((await statEntry(userId, entry))?.isFile()) return entry;
  }
  throw failure('preflight_not_found', '所选位置没有可读取的技能入口。', 404);
}

async function readEntry(userId, entry, maxBytes) {
  try {
    const bytes = await readWorkspaceBinary(userId, entry, { maxBytes });
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    if (absent(e)) throw failure('preflight_not_found', '技能入口文件不存在。', 404);
    throw failure('preflight_unreadable', '入口文件超出大小上限、编码无效或路径已变化。');
  }
}

// Only inventory conventional resource directories and explicitly linked files.
// The directory containing SKILL.md may itself be the user's entire project.
async function inspectResources(userId, folder, body, issues, budget) {
  const groups = new Map(), seen = new Set();
  let skipped = false, incomplete = false;
  function group(directory) {
    if (!groups.has(directory)) groups.set(directory, { directory, count: 0, sample: [], truncated: false });
    return groups.get(directory);
  }
  function remember(resource) {
    if (seen.has(resource)) return;
    seen.add(resource);
    const row = group(resource.includes('/') ? resource.split('/')[0] : '.');
    row.count++;
    if (row.sample.length < 6) row.sample.push(resource);
  }
  async function walk(resource, depth, row) {
    const relative = below(folder, resource);
    const dir = await fs.opendir(safePath(userId, relative).abs);
    for await (const entry of dir) {
      if (budget.entries <= 0) { incomplete = row.truncated = true; break; }
      budget.entries--;
      if (entry.name.startsWith('.')) continue;
      const next = resource + '/' + entry.name;
      const target = resolveSafe(userId, below(folder, next));
      if (target.error || entry.isSymbolicLink()) { skipped = true; continue; }
      if (entry.isFile()) remember(next);
      else if (entry.isDirectory()) {
        if (depth < 3) await walk(next, depth + 1, row);
        else incomplete = row.truncated = true;
      }
    }
    safePath(userId, relative);
  }
  for (const name of RESOURCE_DIRS) {
    const relative = below(folder, name);
    if (resolveSafe(userId, relative).error) { skipped = true; continue; }
    if ((await statEntry(userId, relative))?.isDirectory()) await walk(name, 1, group(name));
  }
  const links = body.matchAll(/!?\[[^\]\n]{0,256}\]\(\s*(?:<([^>\n]{1,240})>|([^()\s<>]{1,240}))(?:\s+["'][^\n)]{0,256}["'])?\s*\)/gu);
  const checked = new Set();
  let missing = 0;
  for (const match of links) {
    let link = (match[1] || match[2]).split(/[?#]/, 1)[0];
    if (!link || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(link)) continue;
    try { link = decodeURIComponent(link).replaceAll('\\', '/').replace(/^\.\//, ''); }
    catch { skipped = true; continue; }
    if (checked.has(link)) continue;
    if (budget.links <= 0) { incomplete = true; break; }
    checked.add(link); budget.links--;
    if (link.startsWith('/') || link.split('/').some(p => !p || p.startsWith('.'))) { skipped = true; continue; }
    const relative = below(folder, link);
    if (resolveSafe(userId, relative).error) { skipped = true; continue; }
    const stat = await statEntry(userId, relative);
    if (!stat) missing++;
    else if (stat.isFile() && link !== 'SKILL.md') remember(link);
  }
  if (missing) issues.push(issue('warning', 'missing_resources', `正文引用的 ${missing} 个相对资源未找到。`));
  if (groups.size) issues.push(issue('warning', 'resources_not_imported', '现有安装器只保存技能正文，附属文件不会随技能安装。'));
  if (groups.has('scripts')) issues.push(issue('info', 'scripts_not_executed', '检测到 scripts 目录；脚本未读取或执行，技能声明不会授予执行权限。'));
  if (groups.has('agents')) issues.push(issue('info', 'agent_configs_inactive', '检测到 agents 目录。附带的代理配置只作清点，不会注册或启动代理。'));
  if (skipped) issues.push(issue('warning', 'resource_path_skipped', '部分资源路径不属于可安全检查的技能目录范围，已跳过。'));
  if (incomplete) issues.push(issue('warning', 'inventory_limit', '资源数、深度或链接数已达到预检上限，列出的数量为已核对部分。'));
  return [...groups.values()];
}

async function inspectEntry(userId, entry, budget, names) {
  const folder = path.posix.dirname(entry);
  const directoryName = path.basename(path.dirname(safePath(userId, entry).abs));
  let raw;
  try { raw = await readEntry(userId, entry, MAX_DOCUMENT_BYTES); }
  catch (e) {
    return { path: entry, name: null, descriptionLength: 0, standardValid: false, resources: [], issues: [issue('error', e.code, e.message)] };
  }
  const parsed = inspectSkillDocument(raw, directoryName);
  const issues = parsed.issues.map(i => issue('error', i.code, i.message));
  const fm = parsed.frontmatter;
  const name = typeof fm.name === 'string' && /^[\p{L}\p{N}._-]{1,64}$/u.test(fm.name) ? fm.name : null;
  const desc = typeof fm.description === 'string' ? fm.description : '';
  const legacy = parseFrontmatter(raw);
  if (desc.length > Math.min(60, config.learning.skillDescLimit)) issues.push(issue('warning', 'local_description_limit',
    `描述超过当前安装器的 ${Math.min(60, config.learning.skillDescLimit)} 字符上限。`));
  if (legacy.name !== fm.name || legacy.description !== desc || /[\r\n]/.test(desc)) {
    issues.push(issue('warning', 'local_yaml_difference', '当前安装器对引号、多行或嵌套字段的解析与标准 YAML 不同。'));
  }
  if (Buffer.byteLength(raw) > 20000 || parsed.body.trim().length > config.learning.skillBodyMax) {
    issues.push(issue('warning', 'local_size_limit', '入口文件或正文超过当前安装器的大小上限。'));
  }
  if (!parsed.body.trim()) issues.push(issue('warning', 'local_empty_body', '当前安装器要求非空的技能正文。'));
  if (name && (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > config.learning.skillNameMax)) {
    issues.push(issue('warning', 'local_name_unsupported', '当前安装器不支持此技能名称。'));
  }
  if (name && (names.has(name) || await readSkill(name, { userId }))) {
    issues.push(issue('warning', 'local_name_conflict', '同名技能已在包内或在当前用户可见的技能目录中；安装器不会覆盖。'));
  }
  if (name) names.add(name);
  if (threatScan(desc + '\n' + parsed.body)) issues.push(issue('warning', 'local_content_policy', '技能内容会触发现有安装器的内容检查。'));
  if (fm['allowed-tools']) issues.push(issue('info', 'tools_not_granted', 'allowed-tools 声明不会更改工具权限与审批。'));
  if (Object.keys(fm).some(k => !['name', 'description'].includes(k))) {
    issues.push(issue('info', 'local_metadata_not_imported', '当前安装器只保存名称、描述与正文，其余标准元数据不会写入技能库。'));
  }
  const resources = await inspectResources(userId, folder, parsed.body, issues, budget);
  return { path: entry, name, descriptionLength: [...desc].length, standardValid: parsed.valid, issues, resources };
}

export async function preflightSkillPack(userId, relative) {
  if (!ID_RE.test(String(userId || '')) || userId === '_global') throw failure('invalid_user', '当前用户不可用。', 403);
  try {
    return await withWorkspaceTask(userId, currentWorkspace(userId).id, async () => {
      const entry = await findEntry(userId, relative);
      const plugin = path.posix.basename(entry) === 'plugin.json';
      const issues = [];
      let paths = [entry];
      if (plugin) {
        const raw = await readEntry(userId, entry, 64000);
        let manifest;
        try { manifest = validatePluginManifest(JSON.parse(raw)); }
        catch { throw failure('invalid_preflight_manifest', 'plugin.json 格式无效或包含当前安装器不支持的字段。'); }
        paths = manifest.skills.map(p => below(path.posix.dirname(entry), p));
        if (manifest.mcpServers.length) issues.push(issue('info', 'mcp_not_connected', `清单声明 ${manifest.mcpServers.length} 个 MCP 连接。预检不连接服务或显示凭据。`));
      } else issues.push(issue('info', 'standalone_skill', '这是独立技能入口。现有安装流程需要 plugin.json 清单。'));
      const skills = [], names = new Set(), budget = { entries: 256, links: 96 };
      for (const p of paths) skills.push(await inspectEntry(userId, p, budget, names));
      return { kind: plugin ? 'plugin' : 'skill', path: entry, issues, skills };
    });
  } catch (e) {
    if (e.status && typeof e.code === 'string') throw e;
    throw failure('preflight_unavailable', '无法完成预检，工作区或文件可能已变化。');
  }
}
