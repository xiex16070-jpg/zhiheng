/**
 * 技能库（skill library）加载器。
 *
 * 背景：本项目此前只有 7 个内置过程技能（SEED_SKILLS，写在 skills.mjs 里）。
 * 这一层把「可从 Hermes / Claude Code / ChatGPT-Codex 移植的纯提示词技能」
 * 以 Markdown 文件形式随仓库分发（仓库根 `skill-library/<name>/SKILL.md`），
 * 启动时幂等播种进 `_global`（运行时只读），与内置种子共用同一份 `seeded_skills`
 * 记录——用户归档过的技能不会在重启后复活。
 *
 * 约定：
 * - frontmatter 只认 `name` 与 `description`（description ≤60 字符，是路由文案）；
 * - 目录名必须等于 name；
 * - 只放「纯提示词/流程知识」：不依赖本机脚本、账号或 GUI，否则移植到别的部署会假死。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { createSkill, parseFrontmatter, readSkill, learnState, saveLearnState, skillContentHash, updateSeedSkill } from './skills.mjs';
import { exportSkillDocument } from './agent-skill-format.mjs';

const LIB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skill-library');

export function libraryRoot() {
  return LIB_ROOT;
}

async function readLibrarySkill(directory) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(directory)) return null;
  const file = path.join(LIB_ROOT, directory, 'SKILL.md');
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
  const { body, ...fm } = parseFrontmatter(raw);
  const name = String(fm.name || directory).trim();
  const description = String(fm.description || '').trim();
  if (name !== directory || !description || description.length > 60) return null;
  return { name, description, category: String(fm.category || 'general').trim(), body, file,
    previousSourceHash: /^[a-f0-9]{64}$/.test(fm.previous_source_sha256 || '') ? fm.previous_source_sha256 : null };
}

/** Export what the caller can currently see. A stale listing must never download a namesake from another scope. */
export async function exportVisibleSkill(userId, name, expectedScope) {
  const skill = await readSkill(name, { userId });
  if (!skill || (expectedScope && skill.scope !== expectedScope)) return null;
  let category;
  if (skill.scope === 'global') {
    const release = await readLibrarySkill(name);
    if (release && skillContentHash(release) === skillContentHash({ name, description: skill.frontmatter.description, body: skill.body })) {
      category = release.category;
    }
  }
  const markdown = exportSkillDocument(skill, { category });
  return Buffer.from(zipSync({ [name + '/SKILL.md']: strToU8(markdown) }));
}

/** 读取技能库清单（不写盘）。 */
export async function listLibrary() {
  let dirs = [];
  try {
    dirs = (await fs.readdir(LIB_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const d of dirs) {
    const skill = await readLibrarySkill(d.name);
    if (skill) out.push(skill);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 幂等播种技能库。返回本次新增数量。
 * 与 ensureSeeds 一样：播过（或在库里已存在）就跳过，归档不复活。
 */
export async function ensureSkillLibrary() {
  const list = await listLibrary();
  if (!list.length) return 0;
  const st = await learnState();
  const seeded = new Set(st.seeded_skills || []);
  const sources = { ...(st.skill_library_sources || {}) };
  let added = 0;
  for (const s of list) {
    const current = await readSkill(s.name);
    const sourceHash = skillContentHash(s);
    if (current) {
      const installedHash = skillContentHash({ name: current.frontmatter.name, description: current.frontmatter.description, body: current.body });
      const knownHash = sources[s.name] || s.previousSourceHash;
      if (installedHash === sourceHash) sources[s.name] = sourceHash;
      else if (knownHash && installedHash === knownHash) {
        const updated = await updateSeedSkill({ ...s, expectedHash: knownHash });
        if (updated.ok) sources[s.name] = sourceHash;
      }
      seeded.add(s.name);
      continue;
    }
    if (seeded.has(s.name)) continue; // Archived or removed releases stay absent.
    const r = await createSkill({ name: s.name, description: s.description, body: s.body, actor: 'seed' });
    if (r.ok) { added += 1; seeded.add(s.name); sources[s.name] = sourceHash; }
  }
  if (added || seeded.size !== (st.seeded_skills || []).length || JSON.stringify(sources) !== JSON.stringify(st.skill_library_sources || {})) {
    await saveLearnState({ seeded_skills: [...seeded], skill_library_sources: sources });
  }
  return added;
}
