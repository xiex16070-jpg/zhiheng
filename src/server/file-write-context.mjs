import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const context = new AsyncLocalStorage();
export const withFileWriteContext = (value, run) => context.run(value, run);
export async function fileVersion(filename) {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 25 * 1024 * 1024) throw new Error('file_review_size_or_type');
    const bytes = await fs.readFile(filename);
    return { exists: true, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false, bytes: 0, sha256: null }; throw error; }
}
export async function checkFileWriteVersion(userId, relative, filename) {
  const grant = context.getStore();
  if (!grant) return; // Direct user APIs and local document-library calls keep their own authorization.
  if (grant.userId !== userId || grant.outputPath !== relative) throw new Error('file_approval_target_changed');
  await grant.verifyInputs?.();
  const expected = grant.files.find(file => file.path === relative);
  const actual = await fileVersion(filename);
  if (!expected || expected.exists !== actual.exists || expected.sha256 !== actual.sha256) throw new Error('file_approval_content_changed：文件在确认后已变化，请重新读取并发起修改。');
}
