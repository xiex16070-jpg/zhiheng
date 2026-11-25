/**
 * 文件写入工具：原子落盘。
 *
 * 直接 writeFile 时，进程在写入中途崩溃会留下半个 JSON，
 * 下次启动就读不出来，等于把用户的会话/文档全部丢掉。
 * 改成「写临时文件 → fsync → rename」，保证旧文件要么完整保留、要么被完整替换。
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const tempName = (file) => `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;

export async function writeJsonAtomic(file, value, options) {
  // Serialize before the first await so callers can keep mutating the live state.
  return writeTextAtomic(file, JSON.stringify(value), options);
}

export async function writeTextAtomic(file, text, { mode = 0o666 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  let renamed = false;
  try {
    const fh = await fs.open(tmp, 'wx', mode);
    try {
      await fh.writeFile(text);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
    renamed = true;
  } finally {
    if (!renamed) await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

/**
 * R08（N-11）：进程内文件互斥——同一文件的「读→改→写」按 Promise 链串行，
 * 并发调用不再互相覆盖丢写。仅在公共入口取锁，禁止嵌套同一 key（会死锁）。
 */
const locks = new Map();
export function withFileLock(file, fn) {
  const key = String(file);
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const guarded = run.then(
    () => {},
    () => {}
  );
  locks.set(key, guarded);
  guarded.then(() => {
    if (locks.get(key) === guarded) locks.delete(key);
  });
  return run;
}

/**
 * R08（A-12 残留）：读 JSON + 损坏隔离——解析失败时把坏文件改名留证
 * （.corrupt-<ts>）并返回 fallback，绝不让后续写入把用户数据覆盖成空。
 */
export async function readJsonOrQuarantine(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const q = `${file}.corrupt-${Date.now().toString(36)}`;
    try {
      await fs.rename(file, q);
      console.warn(`[fs] JSON 损坏已隔离（未覆盖）：${file} → ${q}`);
    } catch (err) {
      throw new Error(`JSON 损坏且无法隔离：${file}（${err.code || err.message}）`);
    }
    return fallback;
  }
}

export function writeJsonAtomicSync(file, value) {
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  let fd = null;
  try {
    fd = fsSync.openSync(tmp, 'w');
    fsSync.writeFileSync(fd, JSON.stringify(value));
    fsSync.fsyncSync(fd);
    fsSync.closeSync(fd);
    fd = null;
    fsSync.renameSync(tmp, file);
  } catch (err) {
    if (fd != null) {
      try { fsSync.closeSync(fd); } catch {}
    }
    try { fsSync.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}
