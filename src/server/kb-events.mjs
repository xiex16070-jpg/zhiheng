// Local, metadata-only notifications. Import/delete must never wait on learning work.
const listeners = new Set();
const pending = new Set();
export function onKnowledgeSourceChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }
export function publishKnowledgeSourceChange(event) {
  const notice = Object.freeze({ ...event });
  const work = Promise.allSettled([...listeners].map(listener => Promise.resolve().then(() => listener(notice))));
  pending.add(work);
  work.finally(() => pending.delete(work));
  return work;
}

/** An explicit lifecycle barrier, without making imports wait for learning work.
 * This drains metadata notifications, not periodic timers or model calls. */
export async function settleKnowledgeSourceChanges({ timeoutMs = 10000 } = {}) {
  let timeout;
  const drain = async () => {
    while (pending.size) {
      const outcomes = (await Promise.all([...pending])).flat();
      const errors = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
      if (errors.length) throw new AggregateError(errors, 'Knowledge source notification failed');
    }
  };
  try {
    await Promise.race([drain(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Knowledge source notifications did not settle')), Math.max(1, Math.min(30000, Number(timeoutMs) || 10000)));
    })]);
  } finally { clearTimeout(timeout); }
}
