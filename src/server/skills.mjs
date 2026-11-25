/**
 * 学到的技能库（移植自 Hermes skill 体系，见 docs/integration/hermes-learning-spec.md §4/§5/§8）。
 *
 * 布局（R04 方案 B：技能按用户隔离，audit N-02 的结构性解法）：
 *   data/skills/_global/<name>/SKILL.md   种子技能，运行时只读（仅播种代码可写；curator 不扫描）
 *   data/skills/<userId>/<name>/SKILL.md  该用户习得的技能——仅本人可见、可注入、可管理
 *   data/skills/<scope>/.usage.json       遥测侧车（每作用域一份）：use_count/last_used_at/patch_count/…
 *   data/skills/<scope>/.archive/<name>-<ts> 归档（archive=目录移动，永不物理删除）
 *   data/learn/ledger.jsonl               台账：每次写入一行，含 before/after 全文与归属，可回滚
 *   data/learn/pending.json               没过门槛的候选（带拒绝原因），可由属主/管理员恢复
 * 启动时自动迁移旧扁平布局（根下带 SKILL.md 的目录 + 根 .usage.json/.archive → _global/）。
 *
 * 写入漏斗（全部在写入函数内部强制，调用方绕不开）：
 * - 名称 ^[a-z0-9][a-z0-9._-]*$ 且 ≤64；create 撞名拒绝；
 * - description ≤60 字符（索引截断宽度，超了会静默失去路由信号）——拒绝而不是裁剪；
 * - 正文 ≤100k 字符；原子写；台账记 before/after。
 *
 * curator（纯确定性，无 LLM 成本）：
 * - lastActivity = max(last_used_at, created_at, 文件 mtime)；
 * - 14 天未动 → state=stale；30 天未动 → 移入 .archive/；重新被使用 → 复活为 active；
 * - use_count=0 且年轻的不归档（从未使用是证据缺失，不是陈旧）；pinned 全豁免。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { writeTextAtomic, writeJsonAtomic, withFileLock, readJsonOrQuarantine } from './fsutil.mjs';
import { ID_RE } from './auth.mjs';
import { threatScan } from './memory.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const GLOBAL_SCOPE = '_global';

export function skillsRoot() {
  return path.join(config.dataDir, 'skills');
}
export function learnRoot() {
  return path.join(config.dataDir, 'learn');
}
/** R11（N-18）：台账按月滚动——单文件不再无界增长；回滚扫描最近 3 个月 + 旧版单文件 */
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
const ledgerFileFor = (month) => path.join(learnRoot(), `ledger-${month}.jsonl`);
const ledgerFile = () => ledgerFileFor(monthKey());
function recentLedgerFiles(months = 3) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < months; i++) {
    out.push(ledgerFileFor(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)))));
  }
  out.push(path.join(learnRoot(), 'ledger.jsonl')); // 旧版单文件（只读兼容）
  return out; // 新 → 旧
}
const pendingFile = () => path.join(learnRoot(), 'pending.json');

/** 作用域目录：'_global' 或合法 userId（N-16 同款白名单，杜绝路径穿越）；非法返回 null */
function scopeDir(scope) {
  const sc = String(scope || '');
  if (sc !== GLOBAL_SCOPE && !ID_RE.test(sc)) return null;
  return path.join(skillsRoot(), sc);
}
const usageFileIn = (scope) => path.join(scopeDir(scope), '.usage.json');
const skillFileIn = (scope, name) => path.join(scopeDir(scope), String(name), 'SKILL.md');

const sha = (s) => crypto.createHash('sha256').update(String(s ?? '')).digest('hex');

/**
 * R04 启动迁移（幂等）：旧扁平布局 data/skills/<name>/SKILL.md、根 .usage.json、
 * 根 .archive 全部移入 _global/（历史技能与种子一并变为全局只读）。
 * 判据：目录直下含 SKILL.md ⇒ 旧式技能目录；否则已是用户作用域目录。
 */
export async function migrateSkillsLayout() {
  let entries = [];
  try {
    entries = await fs.readdir(skillsRoot(), { withFileTypes: true });
  } catch {
    return { migrated: 0 };
  }
  const globalDir = path.join(skillsRoot(), GLOBAL_SCOPE);
  let migrated = 0;
  for (const e of entries) {
    if (e.name === GLOBAL_SCOPE) continue;
    const src = path.join(skillsRoot(), e.name);
    if (e.isDirectory()) {
      const isLegacySkill = await fs
        .access(path.join(src, 'SKILL.md'))
        .then(() => true)
        .catch(() => false);
      if (!isLegacySkill) continue; // 已是用户作用域目录
      await fs.mkdir(globalDir, { recursive: true });
      const dest = path.join(globalDir, e.name);
      const destFree = await fs
        .access(dest)
        .then(() => false)
        .catch(() => true);
      if (destFree) {
        await fs.rename(src, dest);
      } else {
        await fs.mkdir(path.join(globalDir, '.archive'), { recursive: true });
        await fs.rename(src, path.join(globalDir, '.archive', `${e.name}-mig-${Date.now().toString(36)}`));
      }
      migrated++;
    } else if (e.name === '.usage.json') {
      // 遥测侧车合并进 _global（冲突键以现有 _global 数据为准），原文件改名留档
      await fs.mkdir(globalDir, { recursive: true });
      const dest = path.join(globalDir, e.name);
      try {
        const legacyU = JSON.parse(await fs.readFile(src, 'utf8'));
        let destU = {};
        try {
          destU = JSON.parse(await fs.readFile(dest, 'utf8'));
        } catch {
          /* 目标缺失/损坏：直接采用旧数据 */
        }
        await writeJsonAtomic(dest, { ...legacyU, ...destU });
        await fs.rename(src, path.join(globalDir, `.usage.json.merged-${Date.now().toString(36)}`));
        migrated++;
      } catch {
        await fs.rename(src, path.join(globalDir, `.usage.json.corrupt-${Date.now().toString(36)}`)).catch(() => {});
      }
    } else if (e.name === '.archive') {
      await fs.mkdir(globalDir, { recursive: true });
      const dest = path.join(globalDir, e.name);
      const destFree = await fs
        .access(dest)
        .then(() => false)
        .catch(() => true);
      if (destFree) {
        await fs.rename(src, dest);
        migrated++;
      }
    }
  }
  return { migrated };
}

/** 定位技能所在作用域：用户自有目录优先，其次 _global。返回 {scope, file} 或 null */
async function resolveScope(name, { userId = null } = {}) {
  if (!NAME_RE.test(String(name || ''))) return null;
  const scopes = [];
  if (userId && ID_RE.test(String(userId))) scopes.push(String(userId));
  scopes.push(GLOBAL_SCOPE);
  for (const scope of scopes) {
    const file = skillFileIn(scope, name);
    const ok = await fs
      .access(file)
      .then(() => true)
      .catch(() => false);
    if (ok) return { scope, file };
  }
  return null;
}

/* ------------------------------------------------------------------ 台账 */

export async function ledgerAppend(entry) {
  const line = JSON.stringify({
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    ts: new Date().toISOString(),
    actor: entry.actor || 'system',
    action: entry.action,
    kind: entry.kind || 'skill',
    name: entry.name || null,
    userId: entry.userId || null,
    before_sha: sha(entry.before),
    after_sha: sha(entry.after),
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason || null,
    warn: entry.warn || null,
  });
  // R08：追加串行化（appendFile 虽为 O_APPEND，但保证 mkdir+append 整体有序）
  await withFileLock(ledgerFile(), async () => {
    await fs.mkdir(learnRoot(), { recursive: true });
    await fs.appendFile(ledgerFile(), line + '\n', 'utf8');
  });
}

export async function ledgerTail(n = 20, { userId = null, admin = false } = {}) {
  try {
    // R11：旧→新读取最近 3 个月台账（含旧版单文件），合并为一条时间线
    const files = recentLedgerFiles().slice().reverse();
    const parts = [];
    for (const f of files) {
      try {
        parts.push(await fs.readFile(f, 'utf8'));
      } catch {
        /* 当月/旧文件不存在属正常 */
      }
    }
    const raw = parts.join('\n');
    const all = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          const o = JSON.parse(l);
          delete o.before;
          delete o.after;
          return o;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    // R03（N-01）：非管理员只能看到自己的记忆条目；技能/他人条目属全局策展面
    const visible = admin ? all : all.filter((o) => o.kind === 'memory' && o.userId && o.userId === userId);
    return visible.slice(-n).reverse();
  } catch {
    return [];
  }
}

/**
 * 按台账 id 回滚一条写入（技能还原内容；记忆还原整库文本）。
 * R03（N-01/N-04）：逐行 JSON.parse 精确匹配 id（不再用 includes 子串匹配）；
 * 记忆条目必须有归属且仅属主/管理员可回滚；技能条目仅管理员；
 * restore 台账带上原条目 userId——二次回滚不再落到 anonymous 目录。
 */
export async function restoreFromLedger(id, { userId = null, admin = false } = {}) {
  // R11：新→旧扫描最近 3 个月台账（含旧版单文件），逐行精确匹配 id
  let entry = null;
  for (const f of recentLedgerFiles()) {
    const raw = await fs.readFile(f, 'utf8').catch(() => '');
    if (!raw) continue;
    for (const line of raw.split('\n').filter(Boolean).reverse()) {
      try {
        const o = JSON.parse(line);
        if (o && o.id === id) {
          entry = o;
          break;
        }
      } catch {
        /* 跳过损坏行 */
      }
    }
    if (entry) break;
  }
  if (!entry) return { ok: false, message: `台账中找不到 id=${id}（回滚窗口为最近 3 个月）` };
  if (!['memory', 'skill'].includes(entry.kind) ||
      (entry.userId != null && (!ID_RE.test(String(entry.userId)) || entry.userId === GLOBAL_SCOPE)) ||
      (entry.kind === 'memory' ? !['user', 'memory'].includes(entry.name) : !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(entry.name)))) {
    return { ok: false, code: 'invalid_ledger', message: '台账目标或归属无效，未执行回滚。' };
  }
  if (entry.kind === 'memory') {
    if (!entry.userId) return { ok: false, code: 'forbidden', message: '条目缺少归属标记，禁止回滚' };
    if (!admin && entry.userId !== userId) return { ok: false, code: 'forbidden', message: '只能回滚自己的记忆条目' };
  } else if (!admin) {
    return { ok: false, code: 'forbidden', message: '技能台账回滚仅限管理员' };
  }
  if (entry.before === null) return { ok: false, message: '该条目没有 before 快照（create 的逆操作是 archive，不是回滚）' };
  if (typeof entry.before !== 'string' || (entry.before_sha && sha(entry.before) !== entry.before_sha)) return { ok: false, code: 'invalid_snapshot', message: '台账快照不完整或校验失败，未执行回滚。' };
  let current;
  try {
    if (entry.kind === 'memory') {
      if (entry.before.split('\n§\n').some(text => threatScan(text))) return { ok: false, code: 'threat', message: '记忆快照未通过内容校验，未执行回滚。' };
      const { restoreRaw } = await import('./memory.mjs');
      current = await restoreRaw(entry.userId, entry.name, entry.before);
    } else {
      // R04：技能回滚写回原作用域（无归属的历史条目 = 迁移进 _global 的旧技能）
      const scope = entry.userId && ID_RE.test(String(entry.userId)) ? String(entry.userId) : GLOBAL_SCOPE;
      const parsed = parseFrontmatter(entry.before);
      if (parsed.name !== entry.name || !parsed.description || !parsed.body.trim() || threatScan(entry.before)) return { ok: false, code: 'invalid_snapshot', message: '技能快照结构或内容校验失败，未执行回滚。' };
      current = await withFileLock(usageFileIn(scope), async () => {
        const usage = await readUsage(scope);
        if (usage[entry.name]?.state === 'archived') throw Object.assign(new Error('archived_skill'), { code: 'target_archived' });
        const file = skillFileIn(scope, entry.name);
        // 内容回滚不承担归档恢复；不存在与合法空文本必须区分。
        const beforeRestore = await fs.readFile(file, 'utf8');
        await writeTextAtomic(file, entry.before);
        return beforeRestore;
      });
    }
  } catch (error) {
    if (error.code === 'target_archived') return { ok: false, code: 'target_archived', message: '技能已归档，内容回滚不能恢复归档。请由管理员先核对归档目录并恢复技能文件及活动状态，再执行内容回滚；未写入任何内容。' };
    if (error.code === 'ENOENT') return { ok: false, code: 'target_missing', message: '回滚目标文件不存在，内容回滚不能重建已删除或归档的目标。请先核对并恢复目标文件及其状态，再执行内容回滚；未写入任何内容。' };
    throw error;
  }
  await ledgerAppend({
    actor: admin && entry.userId !== userId ? 'admin' : 'user',
    action: 'restore',
    kind: entry.kind,
    name: entry.name,
    userId: entry.userId || null,
    before: current,
    after: entry.before,
    reason: `restore:${id}`,
  });
  return { ok: true, message: `已按台账 ${id} 回滚 ${entry.kind}:${entry.name}` };
}

/* ------------------------------------------------------------------ 遥测侧车 */

async function readUsage(scope) {
  // R08：损坏的侧车隔离留证而不是当作空表覆盖
  return readJsonOrQuarantine(usageFileIn(scope), {});
}

async function writeUsage(scope, u) {
  await writeJsonAtomic(usageFileIn(scope), u);
}

function entry(u, name) {
  if (!u[name]) {
    u[name] = { use_count: 0, last_used_at: null, created_at: new Date().toISOString(), created_by: 'unknown', patch_count: 0, state: 'active', pinned: false };
  }
  return u[name];
}

/* ------------------------------------------------------------------ 读取 */

/**
 * 列出调用者可见的技能：_global 种子 + 自己的（同名时自有覆盖全局）。
 * 管理员可用 scope=<userId> 查看指定用户目录（排障用）。
 */
export async function listSkills({ userId = null, admin = false, scope = null } = {}) {
  const scopes = [];
  if (scope && admin && ID_RE.test(String(scope))) {
    scopes.push(String(scope));
  } else {
    scopes.push(GLOBAL_SCOPE);
    if (userId && ID_RE.test(String(userId))) scopes.push(String(userId));
  }
  const out = [];
  for (const sc of scopes) {
    const dir = scopeDir(sc);
    if (!dir) continue;
    let dirs = [];
    try {
      dirs = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch {
      continue;
    }
    const u = await readUsage(sc);
    for (const d of dirs) {
      const meta = u[d.name] || {};
      let description = '';
      try {
        const raw = await fs.readFile(skillFileIn(sc, d.name), 'utf8');
        description = parseFrontmatter(raw).description || '';
      } catch {
        continue; // 目录在但 SKILL.md 缺失：视为损坏，跳过
      }
      out.push({
        name: d.name,
        scope: sc === GLOBAL_SCOPE ? 'global' : 'own',
        scopeId: sc,
        description,
        state: meta.state || 'active',
        pinned: Boolean(meta.pinned),
        use_count: meta.use_count || 0,
        patch_count: meta.patch_count || 0,
        created_by: meta.created_by || 'unknown',
        created_at: meta.created_at || null,
        last_used_at: meta.last_used_at || null,
      });
    }
  }
  const byName = new Map();
  for (const item of out) {
    const prev = byName.get(item.name);
    if (!prev || (prev.scope === 'global' && item.scope === 'own')) byName.set(item.name, item);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const fm = {};
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const body = m ? raw.slice(m[0].length) : raw;
  return { ...fm, body };
}

export async function readSkill(name, { userId = null, admin = false, scope = null } = {}) {
  if (!NAME_RE.test(String(name))) return null;
  let file = null;
  let sc = null;
  if (scope && admin && ID_RE.test(String(scope))) {
    const cand = skillFileIn(scope, name);
    if (await fs.access(cand).then(() => true).catch(() => false)) {
      file = cand;
      sc = String(scope);
    }
  }
  if (!file) {
    const r = await resolveScope(name, { userId });
    if (r) {
      file = r.file;
      sc = r.scope;
    }
  }
  if (!file) return null;
  try {
    const raw = await fs.readFile(file, 'utf8');
    const { body, ...fm } = parseFrontmatter(raw);
    return { name, raw, body, frontmatter: fm, scope: sc === GLOBAL_SCOPE ? 'global' : 'own', scopeId: sc };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ 写入漏斗 */

function validateMeta(name, description) {
  const L = config.learning;
  if (!NAME_RE.test(String(name || ''))) return `名称必须匹配 ^[a-z0-9][a-z0-9._-]*$（收到「${name}」）`;
  if (String(name).length > L.skillNameMax) return `名称最长 ${L.skillNameMax} 字符`;
  const d = String(description || '');
  if (!d) return 'description 不能为空';
  // 拒绝而不是裁剪：裁掉的正是让它能被路由到的触发词
  if (d.length > L.skillDescLimit) {
    return `description 最长 ${L.skillDescLimit} 字符（收到 ${d.length}）。索引只展示前 ${L.skillDescLimit} 字符，超出部分会静默丢失路由信号，请重写更短的描述。`;
  }
  // R04（N-15）：换行可伪造 frontmatter 追加字段，一律拒绝
  if (/[\r\n]/.test(d)) return 'description 不得包含换行符';
  return null;
}

/**
 * 创建技能（R04 方案 B）：actor='seed' 写入 _global（仅播种代码路径）；
 * 其余 actor 必须携带合法 userId，写入该用户的私有目录——跨用户注入结构性不可能。
 * 内容安全：description/正文过 threatScan（N-02），description 禁换行（N-15）。
 */
export async function createSkill({ name, description, body, actor = 'agent', tags = ['learned'], userId = null, warn = null }) {
  const bad = validateMeta(name, description);
  if (bad) return { ok: false, code: 'invalid', message: bad };
  const threat = threatScan(`${description}\n${body}`);
  if (threat) return { ok: false, code: 'threat', message: `内容命中注入模式（${threat}），拒绝写入技能库` };
  if (String(body || '').length > config.learning.skillBodyMax) return { ok: false, code: 'too_large', message: `正文最长 ${config.learning.skillBodyMax} 字符` };
  if (!String(body || '').trim()) return { ok: false, code: 'empty_body', message: '正文不能为空' };

  const scope = actor === 'seed' ? GLOBAL_SCOPE : userId !== GLOBAL_SCOPE && ID_RE.test(String(userId || '')) ? String(userId) : null;
  if (!scope) {
    return { ok: false, code: 'invalid_scope', message: '技能按用户隔离（方案 B）：非种子写入必须携带合法 userId' };
  }
  const file = skillFileIn(scope, name);
  const raw = `---\nname: ${name}\ndescription: ${description}\nversion: 0.1.0\nauthor: kb-agent\ntags: [${tags.join(', ')}]\n---\n\n${String(body).trim()}\n`;
  // R08（N-11）：exists 检查 + 写入 + 侧车更新在同一把作用域锁内（防并发同名互覆）
  const dup = await withFileLock(usageFileIn(scope), async () => {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false);
    if (exists) return true;
    await writeTextAtomic(file, raw);
    const u = await readUsage(scope);
    const e = entry(u, name);
    e.created_by = actor;
    e.created_at = new Date().toISOString();
    await writeUsage(scope, u);
    return false;
  });
  if (dup) {
    return { ok: false, code: 'exists', message: `技能 ${name} 已存在。create 不允许覆盖：请改用 patch 扩展它，或换一个类级名称。` };
  }
  await ledgerAppend({
    actor,
    action: 'create',
    kind: 'skill',
    name,
    userId: scope === GLOBAL_SCOPE ? null : scope,
    before: null,
    after: raw,
    reason: 'create',
    warn,
  });
  return { ok: true, code: 'created', message: `已创建技能 ${name}` };
}

/** Stable identity for published content, excluding installation metadata. */
export function skillContentHash({ name, description, body }) {
  return sha(JSON.stringify({ name, description: String(description).trim(), body: String(body).replace(/\r\n?/g, '\n').trim() }));
}

/** Update an installed global release only while its known source is unchanged. */
export async function updateSeedSkill({ name, description, body, expectedHash }) {
  const bad = validateMeta(name, description);
  if (bad || !/^[a-f0-9]{64}$/.test(expectedHash || '')) return { ok: false, code: 'invalid' };
  if (!String(body || '').trim() || body.length > config.learning.skillBodyMax || threatScan(`${description}\n${body}`)) {
    return { ok: false, code: 'invalid_body' };
  }
  const file = skillFileIn(GLOBAL_SCOPE, name);
  const result = await withFileLock(usageFileIn(GLOBAL_SCOPE), async () => {
    const before = await fs.readFile(file, 'utf8').catch(() => null);
    if (before === null) return { ok: false, code: 'not_found' };
    const parsed = parseFrontmatter(before);
    if (skillContentHash(parsed) !== expectedHash) return { ok: false, code: 'source_changed' };
    const header = before.slice(0, before.length - parsed.body.length).replace(/^description:.*$/m, `description: ${description}`);
    const after = `${header}\n${body.trim()}\n`;
    await writeTextAtomic(file, after);
    // An upgrade retains pinning, stale state, usage counts and creation metadata.
    return { ok: true, before, after };
  });
  if (result.ok) await ledgerAppend({ actor: 'seed', action: 'patch', kind: 'skill', name,
    userId: null, before: result.before, after: result.after, reason: 'library_source_update' });
  return { ok: result.ok, ...(result.code ? { code: result.code } : {}) };
}

/**
 * patch：old_text 必须在当前正文中唯一。写入方（review）在提示词里已拿到当前全文
 * （服务端把被改技能全文塞进审查请求，等价于强制 read-before-write）。
 */
/**
 * patch：old_text 必须唯一命中。R04（方案 B）：_global 种子运行时只读——
 * 想扩展种子请在自己名下 create（同名时用户自有技能优先注入）。
 */
export async function patchSkill({ name, old_text, new_text, actor = 'agent', userId = null, expectedHash = null }) {
  if (!NAME_RE.test(String(name || ''))) return { ok: false, code: 'invalid', message: `名称不合法：${name}` };
  const resolved = await resolveScope(name, { userId });
  if (!resolved) {
    return { ok: false, code: 'not_found', message: `技能 ${name} 不存在。请先用 listSkills 查看现有技能；新建请用 create。` };
  }
  const owner = userId !== GLOBAL_SCOPE && ID_RE.test(String(userId || '')) ? String(userId) : null;
  if (resolved.scope === GLOBAL_SCOPE && actor !== 'seed' && !owner) {
    return {
      ok: false,
      code: 'global_readonly',
      message: '种子技能全局只读（方案 B）：不能直接修改。如需扩展其规则，请 create 一个自己的类级技能，同名时它会优先于种子注入。',
    };
  }
  // Copy-on-write: a lesson about a shared seed becomes the user's own same-named
  // skill (user scope wins at injection); the seed stays unchanged for everyone else.
  const override = resolved.scope === GLOBAL_SCOPE && actor !== 'seed';
  const oldT = String(old_text || '');
  const newT = String(new_text || '');
  if (!oldT) return { ok: false, code: 'missing_old_text', message: 'patch 必须提供 old_text。未写入任何内容。' };
  if (oldT === newT) return { ok: false, code: 'no_op', message: 'old_text 与 new_text 相同，是空操作。未写入任何内容。' };
  const threat = threatScan(newT);
  if (threat) return { ok: false, code: 'threat', message: `new_text 命中注入模式（${threat}），拒绝写入` };
  const targetScope = override ? owner : resolved.scope;
  const targetFile = override ? skillFileIn(owner, name) : resolved.file;
  // R08（N-11）：读→唯一性校验→写→侧车更新整体持作用域锁
  const verdict = await withFileLock(usageFileIn(targetScope), async () => {
    const cur = await fs.readFile(resolved.file, 'utf8').catch(() => null);
    if (cur === null) return { fail: { ok: false, code: 'not_found', message: `技能 ${name} 不存在。` } };
    const u = await readUsage(resolved.scope);
    if (['review', 'curator'].includes(actor) && !u[name]) return { fail: { ok: false, code: 'metadata_unavailable', message: '技能来源与保护标记不可读，自动修改已停止。请检查技能状态。' } };
    if (u[name]?.pinned && ['review', 'curator'].includes(actor)) return { fail: { ok: false, code: 'pinned', message: '已固定的技能不接受自动审查修改；用户仍可主动编辑。' } };
    if (override && await fs.access(targetFile).then(() => true, () => false)) return { fail: { ok: false, code: 'source_changed', message: '你已有同名技能；请重新读取后修改自己的版本。' } };
    if (expectedHash !== null && sha(cur) !== expectedHash) return { fail: { ok: false, code: 'source_changed', message: '技能在读取后已变化；本次未写入，请重新读取后修改。' } };
    const first = cur.indexOf(oldT);
    if (first < 0) {
      return { fail: { ok: false, code: 'no_match', message: `old_text 未在 ${name}/SKILL.md 中找到。未写入任何内容。请对照审查请求里附带的当前全文，原样复制要修改的片段。` } };
    }
    if (cur.indexOf(oldT, first + 1) >= 0) {
      return { fail: { ok: false, code: 'ambiguous', message: `old_text 在 ${name}/SKILL.md 中命中多处，无法唯一定位。未写入任何内容。请补充上下文。` } };
    }
    const next = cur.replace(oldT, newT);
    if (next.length > config.learning.skillBodyMax + 500) return { fail: { ok: false, code: 'too_large', message: 'patch 后超出正文上限。未写入任何内容。' } };
    const parsed = parseFrontmatter(next);
    const previous = parseFrontmatter(cur);
    if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(next) || parsed.name !== name || !parsed.body.trim()) {
      return { fail: { ok: false, code: 'invalid_structure', message: 'patch 必须保留合法 frontmatter、原技能名称和非空正文。未写入任何内容。' } };
    }
    // 旧描述超过现行预算不妨碍正文修复；一旦更改描述，必须满足新写入规则。
    const metaError = parsed.description === previous.description ? null : validateMeta(name, parsed.description);
    if (metaError) return { fail: { ok: false, code: 'invalid', message: metaError } };
    if (parsed.body.length > config.learning.skillBodyMax) return { fail: { ok: false, code: 'too_large', message: 'patch 后正文超过上限。未写入任何内容。' } };
    if (threatScan(next)) return { fail: { ok: false, code: 'threat', message: '完整修改结果命中注入模式，拒绝写入。' } };
    await writeTextAtomic(targetFile, next);
    const usage = override ? await readUsage(targetScope) : u;
    const e = entry(usage, name);
    e.patch_count = (e.patch_count || 0) + 1;
    if (override) { e.created_by = actor; e.created_at = new Date().toISOString(); e.overrides = 'global'; }
    if (e.state === 'stale') e.state = 'active'; // 被维护即复活
    await writeUsage(targetScope, usage);
    return { cur, next };
  });
  if (verdict.fail) return verdict.fail;
  const cur = verdict.cur;
  const next = verdict.next;
  await ledgerAppend({
    actor,
    action: override ? 'create' : 'patch',
    kind: 'skill',
    name,
    userId: targetScope === GLOBAL_SCOPE ? null : targetScope,
    before: override ? null : cur,
    after: next,
    reason: override ? 'override_global_seed' : 'patch',
  });
  return override
    ? { ok: true, code: 'overridden', message: `已在你的技能库创建同名版本 ${name}（共享种子技能保持不变，注入时优先使用你的版本）` }
    : { ok: true, code: 'patched', message: `已更新技能 ${name}` };
}

/**
 * pin/unpin（R04 方案 B 授权）：_global 种子仅管理员；用户目录技能限属主或管理员。
 */
export async function pinSkill(name, pinned, actor = 'user', { userId = null, admin = false } = {}) {
  const resolved = await resolveScope(name, { userId });
  if (!resolved) return { ok: false, code: 'not_found', message: `技能 ${name} 不存在` };
  const isGlobal = resolved.scope === GLOBAL_SCOPE;
  if (isGlobal ? !admin : !(admin || resolved.scope === String(userId))) {
    return { ok: false, code: 'forbidden', message: isGlobal ? '全局种子技能的 pin 仅限管理员' : '只能操作自己名下的技能' };
  }
  // R08：侧车读改写持作用域锁
  await withFileLock(usageFileIn(resolved.scope), async () => {
    const u = await readUsage(resolved.scope);
    const e = entry(u, name);
    e.pinned = Boolean(pinned);
    await writeUsage(resolved.scope, u);
  });
  await ledgerAppend({
    actor: admin && resolved.scope !== String(userId) ? 'admin' : actor,
    action: pinned ? 'pin' : 'unpin',
    kind: 'skill',
    name,
    userId: isGlobal ? null : resolved.scope,
    before: null,
    after: null,
    reason: 'pin',
  });
  return { ok: true };
}

/**
 * 归档 = 移入所属作用域的 .archive/，永不物理删除；自动通道不允许删除，只允许这条可恢复路径。
 * R04（方案 B）授权：_global 仅管理员（curator 不扫描种子）；用户目录限属主或管理员。
 */
export async function archiveSkill(name, { actor = 'user', reason = 'manual', userId = null, admin = false, automaticAt = Date.now() } = {}) {
  const resolved = await resolveScope(name, { userId });
  if (!resolved) return { ok: false, message: `技能 ${name} 不存在` };
  const isGlobal = resolved.scope === GLOBAL_SCOPE;
  if (isGlobal ? !admin : !(admin || resolved.scope === String(userId))) {
    return { ok: false, code: 'forbidden', message: isGlobal ? '全局种子技能的归档仅限管理员' : '只能操作自己名下的技能' };
  }
  // R08：pinned 检查 + 目录移动 + 侧车更新在同一把作用域锁内
  let dest;
  const blocked = await withFileLock(usageFileIn(resolved.scope), async () => {
    const u = await readUsage(resolved.scope);
    if (u[name]?.pinned && actor !== 'user' && !admin) return { ok: false, code: 'pinned', message: `${name} 已 pin，自动通道不得归档` };
    if (actor === 'curator') {
      const meta = u[name];
      if (resolved.scope === GLOBAL_SCOPE || !meta || !['agent', 'review'].includes(meta.created_by)) return { ok: false, code: 'not_curator_owned', message: '人工、安装或未知来源技能不参与自动归档。' };
      const stat = await fs.stat(resolved.file);
      const idle = automaticAt - Math.max(tsMs(meta.last_used_at), tsMs(meta.created_at), stat.mtimeMs);
      const archiveMs = config.learning.curator.archiveAfterDays * 86400_000;
      if (!(idle > archiveMs && (meta.use_count > 0 || idle > archiveMs * 2))) return { ok: false, code: 'recently_active', message: '技能在检查期间已重新使用或维护，不再自动归档。' };
    }
    const srcDir = path.join(scopeDir(resolved.scope), name);
    dest = path.join(scopeDir(resolved.scope), '.archive', `${name}-${Date.now().toString(36)}`);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(srcDir, dest);
    const e = entry(u, name);
    e.state = 'archived';
    e.archived_at = new Date().toISOString();
    e.archive_path = dest;
    await writeUsage(resolved.scope, u);
    return null;
  });
  if (blocked) return blocked;
  await ledgerAppend({
    actor,
    action: 'archive',
    kind: 'skill',
    name,
    userId: isGlobal ? null : resolved.scope,
    before: null,
    after: null,
    reason,
  });
  return { ok: true, message: `已归档 ${name}（可恢复：${path.basename(dest)}）` };
}

/* ------------------------------------------------------------------ 检索注入 */

function tokenize(s) {
  const out = new Set();
  const ascii = String(s).toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const w of ascii) if (w.length > 1) out.add(w);
  const cjk = String(s).match(/[\u4e00-\u9fff]+/g) || [];
  for (const seg of cjk) {
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return out;
}

/**
 * 词面匹配 top-N 技能（供系统提示注入）。返回有界正文与截断标记；同时 bump use_count——
 * 遥测统计的是「真实注入」，不是文件存在。
 */
/**
 * R04（方案 B）：注入面 = _global 种子 + 调用者自己的技能（同名自有优先）。
 * use_count 按作用域分别计数。
 */
export async function skillsFor(userId, question, { limit = config.learning.injectSkills, maxChars = config.learning.injectSkillChars, exclude = null, recordUse = true } = {}) {
  const all = await listSkills({ userId });
  const active = all.filter((s) => s.state !== 'archived' && s.name !== exclude);
  if (!active.length) return { matched: [], index: [] };
  const q = tokenize(question);
  const scored = [];
  for (const s of active) {
    let raw = '';
    try {
      raw = await fs.readFile(skillFileIn(s.scopeId, s.name), 'utf8');
    } catch {
      continue;
    }
    const body = parseFrontmatter(raw).body;
    const trigger = tokenize(`${s.name} ${s.description}`);
    const hay = tokenize(body.slice(0, 600));
    let hit = 0;
    for (const t of q) hit += trigger.has(t) ? 2 : hay.has(t) ? 1 : 0;
    const score = q.size ? hit / (2 * q.size) : 0;
    scored.push({ ...s, score, body });
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const matched = scored
    .filter((s) => s.score > 0.05)
    .slice(0, limit)
    .map((s) => ({ name: s.name, description: s.description, body: s.body.slice(0, maxChars),
      truncated: s.body.length > maxChars, totalChars: s.body.length, scope: s.scope, scopeId: s.scopeId }));
  const index = scored.map((s) => ({ name: s.name, description: s.description, state: s.state, pinned: s.pinned, use_count: s.use_count, scope: s.scope }));

  if (recordUse) await recordSkillUse(matched);
  return { matched, index };
}

export async function recordSkillUse(matched) {
  if (matched.length) {
    const now = new Date().toISOString();
    const byScope = new Map();
    for (const m of matched) {
      if (!byScope.has(m.scopeId)) byScope.set(m.scopeId, []);
      byScope.get(m.scopeId).push(m.name);
    }
    for (const [sc, names] of byScope) {
      // R08（N-11）：注入计数是高频读改写——持锁防丢计数
      await withFileLock(usageFileIn(sc), async () => {
        const u = await readUsage(sc);
        for (const n of names) {
          const e = entry(u, n);
          e.use_count = (e.use_count || 0) + 1;
          e.last_used_at = now;
          if (e.state === 'stale') e.state = 'active'; // 重新使用即复活
        }
        await writeUsage(sc, u);
      });
    }
  }
}

/* ------------------------------------------------------------------ pending 候选区 */

export async function readPending() {
  // R08：损坏的 pending 隔离留证，不当作空队列覆盖
  return readJsonOrQuarantine(pendingFile(), []);
}

export async function pushPending(item) {
  const identity = x => JSON.stringify([x.userId || null, x.kind || null, x.target || null, x.statement || '', x.proposed || null]);
  const key = identity(item);
  const fp = sha(key).slice(0, 16);
  // R08（N-11）：读→查重→写整体持锁，并发入队不丢条目
  return withFileLock(pendingFile(), async () => {
    const list = await readPending();
    const existing = list.find(x => identity(x) === key);
    if (existing) return existing.fp; // 兼容旧指纹，但仅在同一属主/种类/目标内去重
    list.push({ ...item, fp, ts: new Date().toISOString() });
    // Per-owner bound: one user's skill suggestions cannot push out another user's
    // items, and memory proposals still awaiting confirmation are evicted last.
    const mine = list.filter(x => (x.userId || null) === (item.userId || null));
    if (mine.length > PENDING_PER_USER) {
      const victim = mine.find(x => x.kind !== 'memory') || mine[0];
      list.splice(list.indexOf(victim), 1);
    }
    while(list.length>PENDING_TOTAL){const ordinary=list.findIndex(row=>row.kind!=='memory');list.splice(ordinary<0?0:ordinary,1);}
    await writeJsonAtomic(pendingFile(), list);
    return fp;
  });
}
const PENDING_PER_USER = 50, PENDING_TOTAL = 1000;

export async function removePending(fp) {
  return withFileLock(pendingFile(), async () => {
    const list = await readPending();
    const next = list.filter((x) => x.fp !== fp);
    await writeJsonAtomic(pendingFile(), next);
    return list.find((x) => x.fp === fp) || null;
  });
}

/* ------------------------------------------------------------------ 种子技能 */

/**
 * 过程技能种子（superpowers 分类的 KB 版：检索规划→引用核查→推断纪律）。
 * 首次启动播种；用户归档过的不复活（seeded 名单记在 learn state 里）。
 */
export const SEED_SKILLS = [
  {
    name: 'retrieval-query-recovery',
    description: '检索空命中或弱匹配时的换词与降级策略',
    body: `# 检索恢复策略

## 规则

- 空命中先去掉限定词再换上位词——ngram 索引对长查询词更苛刻，「锂离子电池三元正极材料掺杂」应退到「正极材料 掺杂」。
- 弱匹配（覆盖度低）不等于无证据：先 read_source 看命中片段是否真的相关，再决定换词还是采用。
- 口语词换学科术语：「心梗」→「心肌梗死」、「电池衰减」→「循环寿命」。
- 多跳问题分 hop 检索：先查机制/方法本身，再用命中的概念查结果/应用。
- 连续 3 次换词仍空命中就输出 NO_EVIDENCE 并说明尝试过的检索词——继续穷举是浪费轮次。`,
  },
  {
    name: 'citation-quality',
    description: '引用标记与逐字校验的纪律',
    body: `# 引用质量

## 规则

- [[ref]] 原样照抄检索结果里的 ref，绝不改写、拼接或凭记忆补写。
- 逐字引文必须先 verify_quote 通过再输出；校验失败就改为转述并保留 ref。
- 一个 ref 只支撑它真正覆盖的陈述；关键词巧合命中不构成引用关系。
- 推断句的依据 ref 同样必须真实存在——未锚定的推断会被系统标红旗。`,
  },
  {
    name: 'file-output-craft',
    description: '产物文件纪律：真实落盘、如实报告、不复述长文',
    body: `# 产物文件纪律

## 规则

- 「生成/输出文件」类请求必须走 write_file 真实落盘，再报告文件名与大小——只在聊天里贴文本不算生成文件。
- 落盘前先把内容组织完整：基于检索证据、文内标注来源、结构分节；写入失败（路径/超限）按错误信息修正一次再试。
- 落盘后聊天里只给要点摘要（3-5 行）+ 文件名，绝不复述全文——用户会直接下载。
- 修订已有文件用 patch_file 唯一命中替换；整文件重写会破坏用户手里旧版的一致性。
- 多个产物用子目录归类（如 reports/、data/），文件名说人话：主题+日期，不要 output1.txt。`,
  },
  {
    name: 'task-planning',
    description: '多步任务先 update_plan 列计划，边走边勾',
    body: `# 任务计划纪律

## 规则

- ≥3 步的任务或要产出文件的任务：动手前先 update_plan 列全量清单（每项一句话，≤20 项）。
- 同一时刻至多一项 in_progress；完成一项立即勾掉，不要攒到最后一次性更新。
- 计划变了就整体重发（items 是全量覆盖）；放弃的项如实移除或说明，不要留僵尸项。
- 计划是对用户的承诺：没做完的项绝不标 completed；任务结束时清单状态必须与实际一致。
- 单步小任务（一次检索+回答）不要列计划——仪式感没有价值。`,
  },
  {
    name: 'tool-error-recovery',
    description: '工具报错三要素：改参重试一次、换工具、如实报告',
    body: `# 工具错误恢复

## 规则

- 工具失败的返回文本自带三要素：发生了什么、状态没变、下一步建议——先读完再行动，不要盲目原样重试。
- 同一工具改参数重试至多 1 次；仍失败就换工具或换路径（如检索空命中→换词见 retrieval-query-recovery）。
- 连续 3 次工具失败会触发止损提醒：停下，如实向用户报告卡在哪一步、尝试过什么、建议怎么办。
- 写操作被拒绝（审批/门槛）不得换名重试绕过——被拒就是被拒，如实告知。
- 绝不把失败包装成成功：没有证据支撑的「已完成」是最严重的错误。`,
  },
  {
    name: 'multi-format-export',
    description: 'txt/md/csv/json 导出的格式要点与选型',
    body: `# 多格式导出

## 规则

- 选型：叙述性总结→.md（标题层级+列表）或 .txt（纯文本分段）；表格数据→.csv（首行表头，含逗号/引号的字段用双引号转义）；结构化数据→.json（写完自检括号配对）。
- 一律 UTF-8 无 BOM；中文内容不要用 GBK 假设——下载方系统会自己处理。
- .md 文件头给标题+一行生成说明（基于什么检索、日期）；.csv 数值列不要带千分位逗号。
- 大文件拆分：单文件接近 2MB 上限时按章节拆成多个文件，在聊天里给清单。
- 文件内的引用写「[编号] 标题」形式并在文末列来源节，不要依赖聊天界面的 ref 渲染。`,
  },
  {
    name: 'grounded-inference',
    description: '有据推断：锚定依据、注明方法与置信度',
    body: `# 有据推断

## 规则

- 推断只建立在检索到的事实之上：每条 [推断] 必须锚定真实 ref，注明方法（归纳/演绎/类比/因果/外推）与置信度（高/中/低）。
- 模型自身知识不是推断前提——资料里没有的内容写成推断就是臆测。
- 数值外推写明假设与适用区间；证据矛盾时并列两侧。
- 推断会被独立审核（pass/weak/fail），审核结论对用户可见：宁缺毋滥，拿不准标低置信度或不写。`,
  },
];

export async function ensureSeeds() {
  const st = await learnState();
  const seeded = new Set(st.seeded_skills || []);
  let added = 0;
  for (const s of SEED_SKILLS) {
    if (seeded.has(s.name)) continue; // 播过就不再播（含用户归档的情形）
    if (await readSkill(s.name)) {
      seeded.add(s.name);
      continue;
    }
    const r = await createSkill({ ...s, actor: 'seed' });
    if (r.ok) added++;
    seeded.add(s.name);
  }
  if (added || seeded.size !== (st.seeded_skills || []).length) {
    await saveLearnState({ seeded_skills: [...seeded] });
  }
  return added;
}

/* ------------------------------------------------------------------ curator */

function tsMs(v) {
  if (!v) return 0;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0; // 解析不了当 0，绝不让 NaN 关掉所有间隔门
}

/**
 * 确定性生命周期迁移（纯函数式，无 LLM）。返回迁移清单供台账/状态记录。
 * 首次运行（无 state）只播种时间戳不动库——seed first, act later。
 */
export async function curatorTick(now = Date.now()) {
  const stateFile = path.join(learnRoot(), 'state.json');
  let state = {};
  try {
    state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  } catch {
    /* 全新安装 */
  }
  if (!state.curator_seeded_at) {
    await withFileLock(stateFile, async () => {
      const cur = await learnState();
      if (cur.curator_seeded_at) return;
      await writeJsonAtomic(stateFile, { ...cur, curator_seeded_at: new Date(now).toISOString(), curator_runs: 0 });
    });
    return { seeded: true, moved: [] };
  }

  const { staleAfterDays, archiveAfterDays } = config.learning.curator;
  const staleMs = staleAfterDays * 86400_000;
  const archMs = archiveAfterDays * 86400_000;
  const moved = [];

  // R04（方案 B）：只扫描用户作用域目录；_global 种子永不被 curator 迁移
  let scopeDirs = [];
  try {
    scopeDirs = (await fs.readdir(skillsRoot(), { withFileTypes: true })).filter(
      (d) => d.isDirectory() && d.name !== GLOBAL_SCOPE && ID_RE.test(d.name)
    );
  } catch {
    scopeDirs = [];
  }

  for (const sd of scopeDirs) {
    const scope = sd.name;
    const u = await readUsage(scope);
    let dirs = [];
    try {
      dirs = (await fs.readdir(scopeDir(scope), { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
    } catch {
      continue;
    }
    const staleNames = [];
    for (const d of dirs) {
      const name = d.name;
      const e = u[name];
      if (!e || e.pinned || !['agent', 'review'].includes(e.created_by)) continue; // 人工/安装/未知来源不自动迁移
      let mtime = 0;
      try {
        mtime = (await fs.stat(skillFileIn(scope, name))).mtimeMs;
      } catch {
        continue;
      }
      const lastActivity = Math.max(tsMs(e.last_used_at), tsMs(e.created_at), mtime);
      const idle = now - lastActivity;
      // use_count=0 且年轻：证据缺失不是陈旧，不归档
      if (idle > archMs && (e.use_count > 0 || idle > archMs * 2)) {
        const r = await archiveSkill(name, { actor: 'curator', reason: `idle_${Math.round(idle / 86400_000)}d`, userId: scope, automaticAt: now });
        if (r.ok) moved.push({ name, scope, to: 'archived', idleDays: Math.round(idle / 86400_000) });
      } else if (idle > staleMs && e.state === 'active') {
        staleNames.push(name);
      }
    }
    if (staleNames.length) {
      // R08：stale 标记持锁重读重写，不吞掉锁外的并发计数更新
      await withFileLock(usageFileIn(scope), async () => {
        const u2 = await readUsage(scope);
        for (const n of staleNames) {
          const e = u2[n];
          if (!e || e.pinned || e.state !== 'active' || !['agent', 'review'].includes(e.created_by)) continue;
          const stat = await fs.stat(skillFileIn(scope, n)).catch(() => null);
          if (!stat) continue;
          const idle = now - Math.max(tsMs(e.last_used_at), tsMs(e.created_at), stat.mtimeMs);
          if (idle <= staleMs) continue;
          e.state = 'stale';
          moved.push({ name: n, scope, to: 'stale', idleDays: Math.round(idle / 86400_000) });
        }
        await writeUsage(scope, u2);
      });
    }
  }

  // R08：状态合并写入持锁重读，避免覆盖并发 saveLearnState 的字段
  await withFileLock(stateFile, async () => {
    const cur = await learnState();
    await writeJsonAtomic(stateFile, {
      ...cur,
      curator_runs: (cur.curator_runs || 0) + 1,
      last_curator_at: new Date(now).toISOString(),
      last_curator_moved: moved,
    });
  });
  for (const m of moved) {
    await ledgerAppend({ actor: 'curator', action: m.to, kind: 'skill', name: m.name, userId: m.scope, before: null, after: null, reason: `idle_${m.idleDays}d` });
  }
  return { seeded: false, moved };
}

function learnStateFile(userId = null) {
  if (userId === null) return path.join(learnRoot(), 'state.json');
  if (!ID_RE.test(String(userId)) || userId === GLOBAL_SCOPE) throw new Error('invalid_learning_user');
  return path.join(learnRoot(), 'users', String(userId), 'state.json');
}

export async function learnState(userId = null) {
  // R08：损坏的 state 隔离留证，不当作空状态覆盖
  return readJsonOrQuarantine(learnStateFile(userId), {});
}

export async function saveLearnState(patch, userId = null) {
  const file = learnStateFile(userId);
  // R08（N-11）：合并写入持锁，防并发丢字段
  return withFileLock(file, async () => {
    const current = await learnState(userId);
    const state = { ...current, ...(typeof patch === 'function' ? patch(current) : patch) };
    await writeJsonAtomic(file, state);
    return state;
  });
}
