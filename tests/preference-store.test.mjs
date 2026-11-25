import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreferenceStore } from '../src/ui/preference-store.js';

// Manually release the first HTTP response to reproduce slow writes and SSE races.
function fixture() {
  const server = { style: 'balanced', learning: 'on' };
  const writes = [];
  const views = [];
  let finish;
  const store = createPreferenceStore({
    initial: server,
    persist(patch) {
      writes.push(patch);
      if (writes.length === 1) return new Promise((resolve, reject) => { finish = { resolve, reject }; });
      return Promise.resolve({ ...Object.assign(server, patch) });
    },
    async reload() { return { ...server }; },
    render(view) { views.push(view); },
  });
  return { store, server, writes, view: () => views.at(-1), first: () => finish };
}

test('an approval and an older save response can arrive in reverse commit order', async () => {
  const f = fixture();
  f.store.change({ style: 'detailed' });
  await Promise.resolve();
  const firstResponse = { ...Object.assign(f.server, { style: 'detailed' }) };
  f.server.style = 'concise';
  f.store.accept({ style: 'concise' });
  f.first().resolve(firstResponse);
  assert.equal(await f.store.whenSettled(), true);
  assert.equal(f.view().preferences.style, 'concise');
});

test('a lost response after commit is confirmed by reading durable preferences', async () => {
  const f = fixture();
  f.store.change({ learning: 'off' });
  await Promise.resolve();
  f.server.learning = 'off';
  f.first().reject(new Error('connection reset'));
  assert.equal(await f.store.whenSettled(), true);
  assert.equal(f.view().preferences.learning, 'off');
  assert.equal(f.view().status.kind, 'saved');
});

test('a failed field rolls back while the latest choice for another field is saved', async () => {
  const f = fixture();
  f.store.change({ learning: 'off' });
  await Promise.resolve();
  f.store.change({ style: 'concise' });
  f.store.change({ style: 'detailed' });
  assert.equal(f.view().preferences.style, 'detailed');
  f.first().reject(new Error('failed to write'));
  assert.equal(await f.store.whenSettled(), false);
  assert.deepEqual(f.writes, [{ learning: 'off' }, { style: 'detailed' }]);
  assert.deepEqual(f.view().preferences, { learning: 'on', style: 'detailed' });
  assert.equal(f.view().status.kind, 'error');
});
