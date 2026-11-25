import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireRuntimeLock } from '../src/server/runtime-lock.mjs';

test('一个数据目录仅能有一个服务，其他数据目录独立', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-runtime-lock-'));
  const release = await acquireRuntimeLock(dir);
  t.after(async () => { await release(); assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true }); });
  await assert.rejects(acquireRuntimeLock(path.join(dir, '.')), { code: 'instance_running' });
  const other = await acquireRuntimeLock(path.join(dir, 'other'));
  await other();
  await release();
  const reopened = await acquireRuntimeLock(dir);
  await reopened();
});

test('多进程同时启动只有一个成功，进程被杀后系统自动释放锁', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-runtime-process-'));
  const module = new URL('../src/server/runtime-lock.mjs', import.meta.url).href;
  const code = `import { acquireRuntimeLock } from ${JSON.stringify(module)};
    try { await acquireRuntimeLock(process.env.LOCK_TEST_DIR); process.send('acquired'); setInterval(() => {}, 1000); }
    catch (e) { process.send(e.code); process.exit(2); }`;
  const children = Array.from({ length: 3 }, () => spawn(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, LOCK_TEST_DIR: dir }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  }));
  t.after(async () => {
    await Promise.all(children.map(async c => { if (c.exitCode === null && !c.signalCode) { const done = once(c, 'exit'); c.kill(); await done; } }));
    assert.equal(path.dirname(dir), os.tmpdir()); await fs.rm(dir, { recursive: true, force: true });
  });
  const results = await Promise.all(children.map(c => once(c, 'message').then(([message]) => message)));
  assert.equal(results.filter(r => r === 'acquired').length, 1);
  assert.equal(results.filter(r => r === 'instance_running').length, 2);
  const winner = children[results.indexOf('acquired')];
  const exited = once(winner, 'exit'); winner.kill('SIGKILL'); await exited;
  if (process.platform === 'win32' || process.platform === 'linux') {
    const release = await acquireRuntimeLock(dir); await release();
  }
});
