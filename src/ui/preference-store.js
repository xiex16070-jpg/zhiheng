/**
 * Show the latest selection immediately. Only one write is in flight, and
 * repeated choices queued behind it collapse to the latest value per field.
 */
export function createPreferenceStore({ initial, persist, reload, render }) {
  let confirmed = { ...initial };
  let writing = {};
  let queued = {};
  let job = null;
  let needsReload = false;
  let status = { kind: 'idle' };

  const current = () => ({ ...confirmed, ...writing, ...queued });
  function paint() {
    render({ preferences: current(), status });
  }

  async function drain() {
    const failed = new Map();
    while (needsReload || Object.keys(queued).length) {
      if (!Object.keys(queued).length) {
        needsReload = false;
        try {
          confirmed = await reload();
          for (const [key, value] of failed) {
            if (confirmed[key] === value) failed.delete(key);
          }
        } catch { /* Keep the last acknowledged selection when offline. */ }
        continue;
      }
      writing = queued;
      queued = {};
      paint();
      const keys = Object.keys(writing);
      try {
        const result = await persist(writing);
        for (const key of keys) {
          confirmed[key] = result[key];
          failed.delete(key);
        }
      } catch {
        // A lost HTTP response does not prove that the server rejected the write.
        for (const key of keys) failed.set(key, writing[key]);
        needsReload = true;
      }
      writing = {};
    }
    status = failed.size
      ? { kind: 'error', message: '选择未能保存，请重新选择。' }
      : { kind: 'saved' };
    job = null;
    paint();
    return failed.size === 0;
  }

  paint();
  return {
    change(patch) {
      Object.assign(queued, patch);
      status = { kind: 'saving' };
      job ??= Promise.resolve().then(drain);
      paint();
    },
    // Approved tool changes arrive on the task stream. Pending clicks stay visible.
    accept(patch) {
      Object.assign(confirmed, patch);
      // The SSE and HTTP responses can arrive in either order, even for
      // the same field. Re-read the durable result after outstanding writes.
      needsReload = true;
      job ??= Promise.resolve().then(drain);
      paint();
    },
    paint,
    current,
    whenSettled() { return job ?? Promise.resolve(true); },
  };
}
