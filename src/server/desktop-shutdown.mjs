import { unwatchFile, watchFile } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function stopRequest(directory, bootId) {
  if (!/^[a-f0-9-]{36}$/i.test(bootId)) throw new Error('桌面实例标识无效。');
  return path.join(directory, '.desktop-stop-' + bootId);
}

// On Windows process.kill(SIGTERM) terminates Node without running its signal
// handlers. An empty file requires write access to this specific user's profile
// and names exactly one boot. There is no network shutdown endpoint.
export function watchDesktopStop(directory, bootId, stop) {
  const file = stopRequest(directory, bootId);
  const inspect = stat => { if (stat.isFile() && stat.nlink === 1 && stat.size === 0) void stop(); };
  watchFile(file, { persistent: false, interval: 600 }, inspect);
  return async () => {
    unwatchFile(file, inspect);
    await fs.rm(file, { force: true });
  };
}

export async function requestDesktopStop(directory, bootId) {
  const file = stopRequest(directory, bootId);
  try { await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size !== 0 || stat.nlink !== 1) throw new Error('停止请求文件异常，请检查数据目录。');
  }
}
