import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecSessions } from '../src/server/exec-session.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await delay(20); } throw new Error('Process did not produce expected output'); }
test('real process sessions require approval for start/input, isolate owners and stream bounded output', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-exec-')); const root = await fs.realpath(directory); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const manager = createExecSessions({ enabled: true, resolve: () => ({ abs: root, root }), idleMs: 3000, maxLifetimeMs: 5000 }); t.after(() => manager.closeAll());
  const ctx = { userId: 'alice', taskId: 'task1' }; const command = [process.execPath, '-e', 'process.stdout.write("READY\\n"+"x".repeat(40000));process.stdin.on("data",d=>{process.stdout.write("ECHO:"+d);process.exit(0)})'];
  assert.equal((await manager.start({ command }, ctx)).requiresApproval, true);
  const started = await manager.start({ command }, { ...ctx, approved: true }); assert.equal(started.ok, true); const session_id = started.sessionId; const events = []; const stop = manager.tail(session_id, ctx, event => events.push(event));
  const output = await until(async () => { const p = await manager.poll({ session_id }, ctx); return p.output.length > 100 ? p : null; }); assert.ok(output.output.length <= 32000); assert.equal(output.truncated, true);
  assert.equal((await manager.execute('exec_poll', { session_id }, { userId: 'bob', taskId: 'task1' })).ok, false);
  assert.equal((await manager.write({ session_id, text: 'hello' }, ctx)).requiresApproval, true);
  assert.equal((await manager.write({ session_id, text: 'hello' }, { ...ctx, approved: true })).ok, true);
  const finished = await until(async () => { const p = await manager.poll({ session_id }, ctx); return p.status === 'exited' ? p : null; }); assert.match(finished.output, /ECHO:hello/); assert.equal(finished.exitCode, 0); assert.ok(events.some(e => e.type === 'tool_progress')); stop();
});
test('process session hardlines, disabled state and idle termination remain enforced', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-exec-policy-')); const root = await fs.realpath(directory); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ctx = { userId: 'alice', taskId: 'task1', approved: true }; const disabled = createExecSessions({ enabled: false }); assert.equal((await disabled.start({ command: ['node','--version'] }, ctx)).ok, false);
  const manager = createExecSessions({ enabled: true, resolve: () => ({ abs: root, root }), idleMs: 120, maxLifetimeMs: 500 }); t.after(() => manager.closeAll());
  assert.equal((await manager.start({ command: ['shutdown', '-s'] }, ctx)).ok, false);
  const started = await manager.start({ command: [process.execPath, '-e', 'setInterval(()=>{},1000)'] }, ctx); const events = []; manager.tail(started.sessionId, ctx, event => events.push(event));
  await until(async () => events.find(e => e.status === 'exited')); assert.ok(events.some(e => e.status === 'exited'));
});
