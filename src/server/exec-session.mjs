import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ID_RE } from './auth.mjs';
import { classifyCommand, hardlineHit, gitBoundaryEnv } from './exec.mjs';
import { resolveSafe, workspaceRoot } from './workspace.mjs';
import { getRuntimeSettings } from './runtime-settings.mjs';

const SESSION_ID = /^[a-f0-9]{24}$/;
function resolveDirectory(userId, relative) { if (relative === '.') { const root = workspaceRoot(userId); return root ? { root, abs: root } : { error: 'workspace_unavailable' }; } return resolveSafe(userId, relative); }
function safeEnv() { const out = {}; for (const name of ['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','LANG','LC_ALL']) if (process.env[name]) out[name] = process.env[name]; return out; }
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }); killer.on('error', () => child.kill()); }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
const schemas = [
  ['exec_start', '启动需要人工批准的有界进程会话；命令必须是 argv，工作目录限制在当前工作区。', { command: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64 }, workdir: { type: 'string' } }, ['command']],
  ['exec_write', '向已批准的进程会话发送输入；每次输入仍需要与本次参数绑定的人工批准。', { session_id: { type: 'string' }, text: { type: 'string', maxLength: 4000 }, close_stdin: { type: 'boolean' } }, ['session_id', 'text']],
  ['exec_poll', '读取当前用户和任务所属进程的最新有界输出。', { session_id: { type: 'string' }, cursor: { type: 'integer', minimum: 0 } }, ['session_id']],
  ['exec_close', '终止当前任务的进程会话和子进程树。', { session_id: { type: 'string' } }, ['session_id']],
].map(([name, description, properties, required]) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } }));
export const EXEC_SESSION_SCHEMAS = schemas;

/** Stateful processes are opt-in. approved must come only from the existing argument-bound approval verifier. */
export function createExecSessions({ enabled = process.env.EXEC_SESSIONS === '1', idleMs = 300_000, maxLifetimeMs = 30 * 60_000, maxPerUser = 2, maxTotal = 20, resolve = resolveDirectory, classify = classifyCommand, audit = async () => {} } = {}) {
  const sessions = new Map();
  const identity = ctx => { if (!ID_RE.test(String(ctx?.userId || '')) || !ID_RE.test(String(ctx?.taskId || ''))) throw new Error('Invalid task identity'); };
  const get = (id, ctx) => { identity(ctx); const s = SESSION_ID.test(String(id)) && sessions.get(id); if (!s || s.userId !== ctx.userId || s.taskId !== ctx.taskId) throw new Error('Session not found'); return s; };
  const view = (s, cursor = 0) => ({ ok: true, sessionId: s.id, status: s.status, exitCode: s.exitCode ?? null, cursor: s.cursor, truncated: cursor < s.base, output: s.output.slice(Math.max(0, Number(cursor) - s.base)), text: s.output.slice(Math.max(0, Number(cursor) - s.base)) });
  function publish(s, event) { for (const listener of s.listeners) { try { listener(event); } catch {} } }
  function closeProcess(s, reason) { if (s.status === 'running') { s.status = 'closing'; s.reason = reason; killTree(s.child); } }
  function touch(s) { clearTimeout(s.idleTimer); s.idleTimer = setTimeout(() => closeProcess(s, 'idle_timeout'), idleMs); s.idleTimer.unref?.(); }
  async function workspace(s, ctx) { const current = resolve(ctx.userId, '.'); if (current.error || !current.abs) throw new Error('Workspace unavailable'); const root = await fs.realpath(current.abs); if (root !== s.root) throw new Error('Workspace changed; close this task before starting another session'); }
  async function start(args, ctx) {
    identity(ctx); if (!(typeof enabled === 'function' ? enabled(ctx) : enabled)) return { ok: false, text: '进程会话未启用；可在设置 → 执行环境中开启。' };
    if (ctx.approved !== true) return { ok: false, requiresApproval: true, text: '启动进程需要本次参数对应的用户审批。' };
    const resolved = resolve(ctx.userId, args.workdir || '.'); if (resolved.error) return { ok: false, text: resolved.error };
    const root = await fs.realpath(resolved.root); const cwd = await fs.realpath(resolved.abs); const rel = path.relative(root, cwd);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !(await fs.stat(cwd)).isDirectory()) return { ok: false, text: '工作目录必须位于当前工作区内。' };
    const policy = await classify(args.command, { userId: ctx.userId, taskId: ctx.taskId, workspaceDir: root, cwd: args.workdir && args.workdir !== '.' ? args.workdir : undefined });
    if (policy.mode === 'deny') return { ok: false, text: policy.reason || '命令被安全策略拒绝。' };
    const hardline = hardlineHit(args.command, { workspaceDir: root, workdir: cwd });
    if (hardline) return { ok: false, text: hardline };
    if (sessions.size >= maxTotal || [...sessions.values()].filter(s => s.userId === ctx.userId && ['running','closing'].includes(s.status)).length >= maxPerUser) return { ok: false, text: '进程会话数量已达上限。' };
    ctx.signal?.throwIfAborted();
    const id = crypto.randomBytes(12).toString('hex');
    // Every process starts with a clean allowlisted environment; no provider/API/service secrets.
    const child = spawn(args.command[0], args.command.slice(1), { cwd, env: { ...safeEnv(), ...gitBoundaryEnv(root) }, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const s = { id, userId: ctx.userId, taskId: ctx.taskId, root, child, status: 'running', output: '', base: 0, cursor: 0, inputBytes: 0, listeners: new Set() }; sessions.set(id, s);
    const add = (data, stream) => { const text = String(data); s.cursor += text.length; s.output += text; if (s.output.length > 32_000) { const cut = s.output.length - 32_000; s.output = s.output.slice(cut); s.base += cut; } publish(s, { type: 'tool_progress', sessionId: id, stream, delta: text.slice(-4000), truncated: text.length > 4000, cursor: s.cursor }); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdout.on('data', data => add(data, 'stdout')); child.stderr.on('data', data => add(data, 'stderr'));
    child.stdin.on('error', () => {}); child.on('error', () => { s.status = 'failed'; add('进程无法启动。', 'stderr'); });
    const abort = () => closeProcess(s, 'task_cancelled'); ctx.signal?.addEventListener('abort', abort, { once: true });
    child.on('close', code => { clearTimeout(s.idleTimer); clearTimeout(s.lifetimeTimer); ctx.signal?.removeEventListener('abort', abort); s.status = s.status === 'failed' ? 'failed' : 'exited'; s.exitCode = code; publish(s, { type: 'tool_progress', sessionId: id, status: s.status, exitCode: code }); s.listeners.clear(); s.retentionTimer = setTimeout(() => sessions.delete(id), 60_000); s.retentionTimer.unref?.(); });
    touch(s); s.lifetimeTimer = setTimeout(() => closeProcess(s, 'runtime_limit'), maxLifetimeMs); s.lifetimeTimer.unref?.();
    await audit({ type: 'exec_session_started', userId: ctx.userId, taskId: ctx.taskId, sessionId: id, executable: path.basename(args.command[0]) }).catch(() => {});
    return { ...view(s), text: `进程会话 ${id} 已启动。使用 exec_poll 读取结果。` };
  }
  async function write(args, ctx) {
    const s = get(args.session_id, ctx); await workspace(s, ctx);
    if (ctx.approved !== true) return { ok: false, requiresApproval: true, text: '发送进程输入需要本次内容对应的用户审批。' };
    if (s.status !== 'running' || !s.child.stdin.writable) return { ok: false, text: '进程输入已关闭。' };
    if (typeof args.text !== 'string' || args.text.length > 4000 || args.text.includes('\0')) return { ok: false, text: '输入格式无效或超过 4000 字符。' };
    if (s.inputBytes + Buffer.byteLength(args.text) > 64_000) return { ok: false, text: '本进程累计输入已达 64KB 限制，请结束当前任务。' };
    s.inputBytes += Buffer.byteLength(args.text);
    s.child.stdin.write(args.text); if (args.close_stdin) s.child.stdin.end(); touch(s);
    await audit({ type: 'exec_session_input', userId: ctx.userId, taskId: ctx.taskId, sessionId: s.id, bytes: Buffer.byteLength(args.text) }).catch(() => {});
    return { ok: true, text: '已将批准的输入发送至进程。' };
  }
  async function poll(args, ctx) { const s = get(args.session_id, ctx); await workspace(s, ctx); if (s.status === 'running') touch(s); return view(s, Math.max(0, Number(args.cursor) || 0)); }
  async function close(args, ctx) { const s = get(args.session_id, ctx); closeProcess(s, 'owner_closed'); await audit({ type: 'exec_session_closed', userId: ctx.userId, taskId: ctx.taskId, sessionId: s.id }).catch(() => {}); return { ok: true, text: '已请求终止进程树。' }; }
  function tail(id, ctx, onEvent, { durationMs = 60_000, cursor = 0 } = {}) {
    const s = get(id, ctx); if (typeof onEvent !== 'function') throw new TypeError('A progress listener is required');
    let timer; const stop = () => { clearTimeout(timer); s.listeners.delete(onEvent); ctx.signal?.removeEventListener('abort', stop); };
    onEvent({ type: 'tool_progress', sessionId: id, ...view(s, cursor) });
    if (s.status !== 'running') return stop;
    s.listeners.add(onEvent); timer = setTimeout(stop, Math.max(1, Math.min(60_000, durationMs))); timer.unref?.(); ctx.signal?.addEventListener('abort', stop, { once: true }); if (ctx.signal?.aborted) stop(); return stop;
  }
  async function execute(name, args, ctx) { try { if (name === 'exec_start') return await start(args, ctx); if (name === 'exec_write') return await write(args, ctx); if (name === 'exec_poll') return await poll(args, ctx); if (name === 'exec_close') return await close(args, ctx); return { ok: false, text: '未知进程工具。' }; } catch (e) { if (ctx.signal?.aborted) throw e; return { ok: false, text: e.message === 'Session not found' ? '进程会话不存在或不属于当前任务。' : '进程操作未能完成，请检查工作区和参数。' }; } }
  return { execute, start, write, poll, close, tail, closeTask(userId, taskId) { for (const s of sessions.values()) if (s.userId === userId && s.taskId === taskId) { closeProcess(s, 'task_finished'); clearTimeout(s.retentionTimer); if (s.status !== 'closing') sessions.delete(s.id); } }, closeAll() { for (const s of sessions.values()) { closeProcess(s, 'shutdown'); clearTimeout(s.retentionTimer); } } };
}
export const execSessions = createExecSessions({enabled:ctx=>{const settings=getRuntimeSettings(ctx.userId);return settings.execEnabled&&settings.sessionEnabled;}});
