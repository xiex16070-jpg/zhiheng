import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { writeJsonAtomicSync } from './fsutil.mjs';

const run = promisify(execFile);
const busy = new Map();
const taskWorkspace = new AsyncLocalStorage();
let pickerOpen = false;

function bindingFile(userId) {
  if (!ID_RE.test(String(userId || ''))) throw new Error('invalid_user');
  return path.join(config.dataDir, 'workspace-bindings', userId + '.json');
}

function localFolderId(root) {
  const stat = fs.statSync(root, { bigint: true });
  if (!stat.isDirectory() || path.relative(root, fs.realpathSync.native(root))) throw new Error('workspace_unavailable');
  return createHash('sha256').update(JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root,
    String(stat.dev), String(stat.ino), String(stat.birthtimeNs)])).digest('hex').slice(0, 32);
}

function readRegistry(userId) {
  const file = bindingFile(userId);
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { version: 2, revision: 0, activeId: 'default', projects: [] };
  }
  try {
    if (raw.length > 512 * 1024) throw new Error('invalid');
    const value = JSON.parse(raw);
    const registry = value.version === 2 ? value : { version: 2, revision: 0, activeId: value.id, projects: [{ id: value.id, root: value.root, name: path.basename(value.root || '').slice(0, 80) }] };
    if (!Number.isSafeInteger(registry.revision) || registry.revision < 0 || !Array.isArray(registry.projects) || registry.projects.length > 50 ||
      !registry.projects.every(p => /^[a-f0-9]{32}$/.test(p.id) && typeof p.root === 'string' && path.isAbsolute(p.root) && typeof p.name === 'string' && p.name.length <= 100) ||
      new Set(registry.projects.map(p => p.id)).size !== registry.projects.length ||
      (registry.activeId !== 'default' && !registry.projects.some(p => p.id === registry.activeId))) throw new Error('invalid');
    return registry;
  } catch { throw new Error('workspace_registry_unreadable'); }
}

function describe(project) {
  if (!project) return { id: 'default', name: '默认工作区', available: true };
  const { root, id, name, createdAt } = project;
  let available = false;
  try { available = localFolderId(root) === id; } catch { /* A moved or unmounted folder stays detached. */ }
  return { id, root, name, available, ...(createdAt ? { createdAt } : {}) };
}

export function currentWorkspace(userId) {
  const registry = readRegistry(userId);
  return describe(registry.projects.find(p => p.id === registry.activeId));
}

/** Read-only lookup for an owned, registered folder; does not change active selection. */
export function workspaceById(userId, id) {
  const registry = readRegistry(userId);
  if (id === 'default') return describe(null);
  const project = registry.projects.find(p => p.id === id);
  return project ? describe(project) : null;
}

export function listWorkspaceProjects(userId) {
  const registry = readRegistry(userId);
  return { revision: registry.revision, activeId: registry.activeId, projects: [describe(null), ...registry.projects.map(describe)] };
}

function updateRegistry(userId, mutate, { changesSelection = false } = {}) {
  if (changesSelection && (busy.has(userId) || pickerOpen)) throw new Error('workspace_busy');
  const registry = readRegistry(userId);
  mutate(registry);
  registry.revision++;
  writeJsonAtomicSync(bindingFile(userId), registry);
  return { workspace: currentWorkspace(userId), ...listWorkspaceProjects(userId) };
}

export function activateWorkspace(userId, id) {
  return updateRegistry(userId, registry => {
    if (id !== 'default' && !registry.projects.some(p => p.id === id)) throw new Error('project_not_found');
    registry.activeId = id;
  }, { changesSelection: true });
}

export function renameWorkspace(userId, id, name) {
  const next = String(name || '').trim();
  if (!next || next.length > 80 || /[\x00-\x1f]/.test(next)) throw new Error('invalid_project_name');
  return updateRegistry(userId, registry => {
    const project = registry.projects.find(p => p.id === id);
    if (!project) throw new Error('project_not_found');
    project.name = next;
  });
}

export function removeWorkspace(userId, id) {
  return updateRegistry(userId, registry => {
    if (!registry.projects.some(p => p.id === id)) throw new Error('project_not_found');
    registry.projects = registry.projects.filter(p => p.id !== id);
    if (registry.activeId === id) registry.activeId = 'default';
  }, { changesSelection: true });
}

export async function withWorkspaceTask(userId, id, fn) {
  if (currentWorkspace(userId).id !== id) throw new Error('workspace_changed');
  busy.set(userId, (busy.get(userId) || 0) + 1);
  try { return await taskWorkspace.run({ userId, id }, fn); } finally {
    const left = busy.get(userId) - 1;
    if (left) busy.set(userId, left); else busy.delete(userId);
  }
}

// Another server process may share DATA_DIR. Verify the task's binding again at
// each file-tool entry so switching in that process cannot redirect an active task.
export function workspaceForFiles(userId) {
  const ws = currentWorkspace(userId);
  const expected = taskWorkspace.getStore();
  return expected?.userId === userId && expected.id !== ws.id ? { ...ws, available: false } : ws;
}

function contains(parent, child) {
  const rel = path.relative(parent, child);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

export const nativePickerSupported = process.platform === 'win32';

async function pickFolder(signal) {
  if (!nativePickerSupported) throw new Error('picker_unavailable');
  const script = `
    $ErrorActionPreference = "Stop"
    Add-Type -AssemblyName System.Windows.Forms
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $owner.Size = [System.Drawing.Size]::new(1, 1)
    $owner.Opacity = 0
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "选择知衡 Agent 可读取和修改文件的工作文件夹"
    try {
      $owner.Show()
      $owner.Activate()
      $owner.BringToFront()
      [System.Windows.Forms.Application]::DoEvents()
      if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Write($dialog.SelectedPath)
      }
    } finally { $dialog.Dispose(); $owner.Dispose() }
  `;
  try {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 180000, signal });
    return stdout;
  } catch (cause) { throw new Error(signal?.aborted ? 'picker_cancelled' : 'picker_unavailable', { cause }); }
}

// Only the native chooser supplies a path. The HTTP client can request a dialog or reset.
export async function selectWorkspace(userId, action, { picker = pickFolder, signal } = {}) {
  const file = bindingFile(userId);
  if (busy.has(userId) || pickerOpen) throw new Error('workspace_busy');
  if (action === 'reset') {
    return activateWorkspace(userId, 'default');
  }
  if (action !== 'choose') throw new Error('invalid_workspace_action');
  pickerOpen = true;
  try {
    const selected = await picker(signal);
    if (!selected || signal?.aborted) return { cancelled: true, workspace: currentWorkspace(userId) };
    if (busy.has(userId)) throw new Error('workspace_busy');
    const root = fs.realpathSync.native(selected);
    const data = fs.realpathSync.native(config.dataDir);
    // Never hand the model the application's credentials, binding records or other users' data.
    if (root === path.parse(root).root || contains(root, data) || contains(data, root)) throw new Error('protected_folder');
    const id = localFolderId(root);
    const registry = readRegistry(userId);
    if (!registry.projects.some(p => p.id === id)) {
      if (registry.projects.length >= 50) throw new Error('project_limit');
      registry.projects.push({ root, id, name: path.basename(root).slice(0, 80), createdAt: new Date().toISOString() });
    }
    registry.activeId = id; registry.revision++;
    writeJsonAtomicSync(file, registry);
    return { workspace: currentWorkspace(userId), ...listWorkspaceProjects(userId) };
  } finally { pickerOpen = false; }
}
