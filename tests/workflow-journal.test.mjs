import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowJournal, journalKey } from '../src/server/workflow-journal.mjs';

test('journal caches exact input, owner and task and bounds records', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-journal-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = createWorkflowJournal({ directory }); const input = { scope: ['a'], goal: 'test' };
  await Promise.all(Array.from({ length: 8 }, (_, i) => journal.append('alice', 'task1', { event: 'started', index: i })));
  await journal.append('alice', 'task1', { event: 'result', key: journalKey(input), reusable: true, result: { text: 'cached' } });
  assert.equal((await journal.read('alice', 'task1')).length, 9);
  assert.equal((await journal.cached('alice', 'task1', input)).text, 'cached');
  assert.equal(await journal.cached('bob', 'task1', input), null);
  assert.equal(await journal.cached('alice', 'task1', { ...input, scope: ['b'] }), null);
  await assert.rejects(journal.read('../bad', 'task1'));
  await assert.rejects(journal.append('alice', 'task1', { event: 'result', text: 'a'.repeat(70000) }));
});
