import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { withFileLock } from './fsutil.mjs';

const valid = value => ID_RE.test(String(value || ''));
export const journalKey = inputs => 'v2:' + crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
export function createWorkflowJournal({ directory = path.join(config.dataDir, 'tasks'), maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = (userId, taskId) => {
    if (!valid(userId) || !valid(taskId)) throw new Error('invalid_journal_identity');
    return path.join(directory, userId, taskId, 'journal.jsonl');
  };
  async function read(userId, taskId) {
    try {
      const name = file(userId, taskId), stat = await fs.stat(name);
      if (stat.size > maxBytes) throw new Error('journal_too_large');
      return (await fs.readFile(name, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  return {
    read,
    async append(userId, taskId, record) {
      if (!['launched','started','result','failed','cancelled'].includes(record?.event) || (record.key && !/^v2:[a-f0-9]{64}$/.test(record.key))) throw new Error('invalid_journal_record');
      const text = JSON.stringify({ ...record, at: new Date().toISOString() }) + '\n';
      if (Buffer.byteLength(text) > 65536) throw new Error('journal_record_too_large');
      const name = file(userId, taskId);
      await withFileLock(name, async () => {
        await fs.mkdir(path.dirname(name), { recursive: true });
        const size = await fs.stat(name).then(s => s.size, e => e.code === 'ENOENT' ? 0 : Promise.reject(e));
        if (size + Buffer.byteLength(text) > maxBytes) throw new Error('journal_too_large');
        const h = await fs.open(name, 'a', 0o600);
        try { await h.write(text); await h.sync(); } finally { await h.close(); }
      });
    },
    async cached(userId, taskId, inputs) {
      const key = journalKey(inputs);
      return (await read(userId, taskId)).findLast(r => r.event === 'result' && r.key === key && r.reusable === true)?.result || null;
    },
  };
}
export const workflowJournal = createWorkflowJournal();
