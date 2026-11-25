import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-stream-'));
process.env.DATA_DIR = directory; process.env.EXEC_ENABLED = '1'; process.env.MYSQL_ENABLED = 'false'; process.env.REDIS_ENABLED = 'false'; process.env.EXEC_MAX_OUTPUT_BYTES = '2048';
const { runCommand, createCommandProgress } = await import('../src/server/exec.mjs');
test.after(() => fs.rm(directory, { recursive: true, force: true }));
test('streamed commands emit real output and enforce shared UTF-8 byte limit', async () => {
  const events = [];
  const result = await runCommand({ userId: 'alice', taskId: 'streamtask', argv: [process.execPath, '-e', 'process.stdout.write("中文".repeat(1000));process.stderr.write("错误".repeat(1000))'], approved: true, stream: true, onProgress: e => events.push(e) });
  assert.equal(result.ok, true); assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 2048); assert.ok(!result.stdout.includes('\ufffd'));
  assert.ok(events.some(e => e.delta?.includes('中文'))); assert.ok(events.some(e => e.truncated)); assert.equal(events.at(-1).status, 'completed'); assert.ok(events.reduce((n,e) => n + Buffer.byteLength(e.delta || ''),0) <= 2048);
  assert.equal((await runCommand({ userId: 'alice', taskId: 'denied', argv: [process.execPath, '-e', 'process.stdout.write("never")'], stream: true, onProgress: () => assert.fail('No stream before approval') })).denied, true);
});
test('stream tail deadline stops events without affecting process ownership', async () => {
  const events = []; const progress = createCommandProgress(e => events.push(e), { durationMs: 20, intervalMs: 10 }); progress.push('first');
  await new Promise(resolve => setTimeout(resolve, 35)); const count = events.length; progress.push('after timeout'); progress.finish(); assert.equal(events.length, count); assert.equal(events.at(-1).status, 'stream_limit');
});
