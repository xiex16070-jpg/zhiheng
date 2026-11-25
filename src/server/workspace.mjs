/**
 * 用户工作区（Phase A：健全 agent 工具面的「文件侧」）。
 *
 * 定位变更（2026-11-02，作者拍板）：本项目首先是一个健全的 agent 工具，其次才是
 * 文献助手——任务产物（总结 txt、报告 md、数据 csv/json 等）必须能被模型真实写盘，
 * 用户从消息里的文件卡片或「工作区」面板下载。
 *
 * 安全边界（沿用 Phase R 的经验，全部在模块内强制）：
 * - 每用户默认目录 data/workspace/<userId>/，或通过本机系统对话框选择的项目目录；
 * - 只接受相对路径：分段规范化后 startsWith 校验防穿越；绝对路径/盘符/`..`/控制字符/
 *   Windows 保留名（con/nul/com1…）一律拒绝；.trash 段不可寻址；
 * - 单文件与文件数上限（config.workspace）；读回有截断上限；
 * - 删除 = 移入沙箱内 .trash/（只移动不删除，与技能归档同哲学）；
 * - 写入走 fsutil 原子写；HTTP 侧审计由路由层记录。
 */

import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { writeTextAtomic, withFileLock } from './fsutil.mjs';
import { workspaceForFiles } from './workspace-selection.mjs';
import { checkFileWriteVersion } from './file-write-context.mjs';

/** 沙箱根：非法 userId 返回 null（绝不落到共享目录） */
export function workspaceRoot(userId) {
  if (!ID_RE.test(String(userId || ''))) return null;
  const ws = workspaceForFiles(userId);
  if (!ws.available) return null;
  if (ws.root) return ws.root;
  const base = path.resolve(config.dataDir);
  return safeComponents(base, ['workspace', userId]) ? path.join(base, 'workspace', userId) : null;
}

// Refuse junctions, symlinks (including broken ones), special files and linked files.
// Checking every existing component also protects writes to a new file below a linked directory.
function safeComponents(base, segments) {
  let target = base;
  for (const segment of segments) {
    target = path.join(target, segment);
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink() || !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1))) return false;
    } catch (err) { return err.code === 'ENOENT'; }
  }
  return true;
}

/**
 * 相对路径 → 沙箱内绝对路径。任何可疑输入返回 { error: <code> }。
 * @returns {{root:string, abs:string, rel:string}|{error:string}}
 */
export function resolveSafe(userId, relPath) {
  const root = workspaceRoot(userId);
  if (!root) return { error: ID_RE.test(String(userId || '')) ? 'workspace_unavailable' : 'invalid_user' };
  const rel = String(relPath ?? '').replace(/\\/g, '/').trim();
  if (!rel) return { error: 'empty_path' };
  if (rel.length > 240) return { error: 'path_too_long' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(rel)) return { error: 'control_chars' };
  if (/^([A-Za-z]:|\/|~)/.test(rel)) return { error: 'absolute_path' };
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length) return { error: 'empty_path' };
  if (segs.some((s) => s === '.' || s === '..')) return { error: 'bad_segment' };
  if (segs.some((s) => s.toLowerCase() === '.trash')) return { error: 'reserved_dir' };
  // Git metadata is executable configuration (fsmonitor, hooks, filters); file
  // tools must never read or plant it. Git itself still works through run_command.
  if (segs.some((s) => s.toLowerCase() === '.git')) return { error: 'reserved_dir' };
  if (segs.some((s) => /[:<>"|?*]|[. ]$/.test(s))) return { error: 'bad_segment' };
  // Windows 保留设备名连扩展名一起生效（con.txt 也是 con）——按去扩展名的基名判断
  if (segs.some((s) => /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(s))) return { error: 'reserved_name' };
  if (segs.some((s) => s.length > 120)) return { error: 'path_too_long' };
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, segs.join(path.sep));
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { error: 'escape' };
  if (!safeComponents(rootAbs, segs)) return { error: 'unsafe_link' };
  return { root: rootAbs, abs, rel: segs.join('/') };
}

/** 写文件（UTF-8 文本，原子写）。返回 {ok, path, bytes} 或 {ok:false, code, message} */
export async function writeFile(userId, relPath, content, { append = false } = {}) {
  if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|zip)$/i.test(String(relPath))) return { ok: false, code: 'binary_format', message: 'write_file 只写文本。PDF/DOCX 请使用 create_document，不能把文本伪装成二进制文件。' };
  const r = resolveSafe(userId, relPath);
  if (r.error) return { ok: false, code: r.error, message: `路径不合法（${r.error}）：请使用工作区内的相对路径，如「总结.txt」或「reports/2026.md」` };
  const chunk = String(content ?? '');
  const tooLarge = (bytes) => ({ ok: false, code: 'too_large', message: `单文件上限 ${config.workspace.maxFileBytes} 字节，本次 ${bytes} 字节。请精简内容或拆分为多个文件。` });
  if (Buffer.byteLength(chunk, 'utf8') > config.workspace.maxFileBytes) return tooLarge(Buffer.byteLength(chunk, 'utf8'));
  return withFileLock(r.abs, async () => {
    const fresh = resolveSafe(userId, relPath);
    if (fresh.error || fresh.abs !== r.abs) throw new Error('workspace_changed');
    await checkFileWriteVersion(userId,r.rel,r.abs);
    // Appending re-reads under the same lock, so concurrent writers cannot interleave.
    const existing = append ? await fs.readFile(r.abs, 'utf8').catch((error) => { if (error.code === 'ENOENT') return ''; throw error; }) : '';
    const text = existing + chunk;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > config.workspace.maxFileBytes) return tooLarge(bytes);
    await writeTextAtomic(r.abs, text);
    return { ok: true, path: r.rel, bytes, ...(append && existing ? { appended: true } : {}) };
  });
}

/** Binary artifacts use the same path boundary and a separate bounded budget. */
export async function writeArtifact(userId, relPath, buffer, { overwrite = false, signal } = {}) {
  const target = resolveSafe(userId, relPath);
  if (target.error) return { ok: false, code: target.error, message: '产物路径必须位于当前工作区。' };
  if (!Buffer.isBuffer(buffer) || buffer.length > 25 * 1024 * 1024) return { ok: false, code: 'too_large', message: '产物超过 25 MiB 上限。' };
  return withFileLock(target.abs, async () => {
    signal?.throwIfAborted();
    const fresh = resolveSafe(userId, relPath);
    if (fresh.error || fresh.abs !== target.abs) return { ok: false, code: 'workspace_changed', message: '工作区已变更，未写入。' };
    await checkFileWriteVersion(userId,target.rel,target.abs);
    try { await fs.lstat(target.abs); if (!overwrite) return { ok: false, code: 'exists', message: '同名文件已存在，请换名或明确指定 overwrite=true。' }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeTextAtomic(target.abs, buffer);
    return { ok: true, path: target.rel, bytes: buffer.length };
  });
}

/** 读文件（文本，带截断上限）。 */
export async function readFile(userId, relPath, capBytes = config.workspace.readCapBytes) {
  if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|zip)$/i.test(String(relPath))) return { ok: false, code: 'binary_format', message: '这是二进制文档，请使用 read_document 抽取正文。' };
  const r = resolveSafe(userId, relPath);
  if (r.error) return { ok: false, code: r.error, message: `路径不合法（${r.error}）` };
  let buf;
  try {
    const fh = await fs.open(r.abs, 'r');
    try {
      const st = await fh.stat();
      const len = Math.min(st.size, capBytes);
      buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, 0);
      var size = st.size; // eslint-disable-line no-var
    } finally {
      await fh.close();
    }
  } catch {
    return { ok: false, code: 'not_found', message: `工作区中没有 ${r.rel}。用 list_files 查看现有文件。` };
  }
  return { ok: true, path: r.rel, content: buf.toString('utf8'), bytes: size, truncated: size > capBytes };
}

/** 唯一命中替换（与技能 patch 同纪律：0 命中/多命中都拒绝，不写入）。 */
export async function patchFile(userId, relPath, oldText, newText) {
  if (/\.(pdf|docx?|xlsx?|pptx?|png|jpe?g|zip)$/i.test(String(relPath))) return { ok: false, code: 'binary_format', message: '不能对二进制文档做文本替换，请使用 create_document 重新生成。' };
  const r = resolveSafe(userId, relPath);
  if (r.error) return { ok: false, code: r.error, message: `路径不合法（${r.error}）` };
  return withFileLock(r.abs, async () => {
  const oldT = String(oldText ?? '');
  const newT = String(newText ?? '');
  if (!oldT) return { ok: false, code: 'missing_old_text', message: 'patch_file 必须提供 old_text。未写入任何内容。' };
  if (oldT === newT) return { ok: false, code: 'no_op', message: 'old_text 与 new_text 相同，是空操作。未写入任何内容。' };
  let cur;
  try {
    if ((await fs.stat(r.abs)).size > config.workspace.maxFileBytes) {
      return { ok: false, code: 'too_large', message: '原文件超出工作区编辑上限。' };
    }
    cur = await fs.readFile(r.abs, 'utf8');
  } catch {
    return { ok: false, code: 'not_found', message: `工作区中没有 ${r.rel}。未写入任何内容。` };
  }
  const first = cur.indexOf(oldT);
  if (first < 0) return { ok: false, code: 'no_match', message: `old_text 未在 ${r.rel} 中找到。未写入任何内容。请先 read_file 核对原文。` };
  if (cur.indexOf(oldT, first + 1) >= 0) return { ok: false, code: 'ambiguous', message: `old_text 在 ${r.rel} 中命中多处，无法唯一定位。未写入任何内容。请补充上下文。` };
  const next = cur.replace(oldT, () => newT);
  if (Buffer.byteLength(next, 'utf8') > config.workspace.maxFileBytes) {
    return { ok: false, code: 'too_large', message: 'patch 后超出单文件上限。未写入任何内容。' };
  }
  const fresh = resolveSafe(userId, relPath);
  if (fresh.error || fresh.abs !== r.abs) throw new Error('workspace_changed');
  await checkFileWriteVersion(userId,r.rel,r.abs);
  await writeTextAtomic(r.abs, next);
  return { ok: true, path: r.rel, bytes: Buffer.byteLength(next, 'utf8') };
  });
}

/** 列目录（跳过 .trash；深度≤4；条数≤maxFiles；按修改时间新→旧）。 */
export async function listFiles(userId) {
  const root = workspaceRoot(userId);
  if (!root) return [];
  const out = [];
  const walk = async (dir, depth) => {
    if (depth > 4 || out.length >= config.workspace.maxFiles) return;
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= config.workspace.maxFiles) return;
      if (e.name.startsWith('.') || (e.isDirectory() && ['node_modules', '__pycache__', 'venv'].includes(e.name))) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = await fs.lstat(p);
          if (!st.isFile() || st.nlink !== 1) continue;
          out.push({ path: path.relative(root, p).split(path.sep).join('/'), bytes: st.size, mtime: st.mtimeMs });
        } catch {
          /* 竞态删除，跳过 */
        }
      }
    }
  };
  await walk(root, 1);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** 删除 = 移入沙箱 .trash/（只移动不删除；同名加时间戳后缀）。 */
export async function removeFile(userId, relPath) {
  const r = resolveSafe(userId, relPath);
  if (r.error) return { ok: false, code: r.error, message: `路径不合法（${r.error}）` };
  try {
    if (!(await fs.lstat(r.abs)).isFile()) return { ok: false, code: 'not_file', message: '仅可删除文件。' };
  } catch {
    return { ok: false, code: 'not_found', message: `工作区中没有 ${r.rel}` };
  }
  const trashDir = path.join(r.root, '.trash');
  if (!safeComponents(r.root, ['.trash'])) return { ok: false, code: 'unsafe_trash', message: '工作区回收站不可用。' };
  await fs.mkdir(trashDir, { recursive: true });
  const base = path.basename(r.abs).replace(/[^\w.\u4e00-\u9fff-]/g, '_');
  await fs.rename(r.abs, path.join(trashDir, randomUUID() + '-' + base));
  return { ok: true, path: r.rel, trashed: true };
}
