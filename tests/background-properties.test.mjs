import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { createBackgroundTasks } from '../src/server/background-tasks.mjs';
import { checkProperty } from './helpers/check-property.mjs';

test('property: only owner cancellation before completion prevents the pending effect', async () => {
  const actions = fc.array(fc.constantFrom('cancel-owner', 'cancel-other', 'finish'), { maxLength: 8 });
  await checkProperty('background-cancellation', fc.asyncProperty(actions, async sequence => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-cancel-prop-'));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let effects = 0;
    const manager = createBackgroundTasks({ directory, run: async ({ signal }) => {
      await gate;
      signal.throwIfAborted();
      effects++;
      return { text: 'complete' };
    } });
    try {
      await manager.start({ userId: 'owner', taskId: 'job' });
      let cancelled = false, finished = false;
      for (const action of [...sequence, 'finish']) {
        if (action === 'finish') {
          release();
          const result = await manager.wait('owner', 'job');
          assert.equal(result.status, cancelled ? 'cancelled' : 'completed');
          finished = true;
        } else {
          const owner = action === 'cancel-owner';
          const actual = await manager.cancel(owner ? 'owner' : 'other', 'job');
          if (!owner || finished) assert.equal(actual.ok, false);
          if (owner && !finished && !cancelled) { assert.equal(actual.ok, true); cancelled = true; }
        }
        assert.equal(effects, finished && !cancelled ? 1 : 0);
        assert.equal(await manager.get('other', 'job'), null);
      }
      assert.equal((await manager.notifications('owner')).length, 1);
    } finally {
      release();
      await manager.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }), 24, [[['cancel-other', 'cancel-owner', 'finish', 'cancel-owner']], [['cancel-other', 'finish', 'cancel-owner']]]);
});
