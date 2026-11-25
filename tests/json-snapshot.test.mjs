import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../src/server/fsutil.mjs';

test('atomic JSON writes capture the value at enqueue time', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zhiheng-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snapshot.json');
  const value = { preferences: { style: 'concise' } };
  const write = writeJsonAtomic(file, value);
  value.preferences.style = 'balanced';
  await write;
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { preferences: { style: 'concise' } });
});
