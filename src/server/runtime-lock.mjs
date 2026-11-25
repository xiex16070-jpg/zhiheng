import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

async function runtimeEndpoint(directory) {
  let canonical = await fs.realpath(path.resolve(directory));
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const id = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? '\\\\.\\pipe\\zhiheng-' + id
    : process.platform === 'linux' ? '\0zhiheng-' + id
      : path.join(os.tmpdir(), 'zhiheng-' + id + '.sock');
}

/** Query the OS lock owner, rather than trusting removable/stale PID files.
 * A legacy owner closes immediately: still running, but cannot be identified. */
export async function inspectRuntime(directory, { timeoutMs = 1500 } = {}) {
  let endpoint;
  try { endpoint = await runtimeEndpoint(directory); }
  catch (error) { if (error.code === 'ENOENT') return { running: false, info: null }; throw error; }
  return new Promise((resolve, reject) => {
    let connected = false, settled = false, data = '';
    const socket = net.createConnection(endpoint);
    const finish = (info, extra = {}) => {
      if (settled) return;
      settled = true; socket.destroy(); resolve({ running: connected, info, ...extra });
    };
    const fail = error => {
      if (settled) return;
      settled = true; socket.destroy(); reject(error);
    };
    socket.setEncoding('utf8'); socket.setTimeout(timeoutMs);
    socket.on('connect', () => { connected = true; });
    socket.on('data', chunk => { data += chunk; if (data.length > 4096) finish(null); });
    socket.on('end', () => {
      try {
        const info = JSON.parse(data);
        const valid = info?.protocol === 'zhiheng-runtime/v1' && Number.isSafeInteger(info.pid) && info.pid > 0 &&
          typeof info.bootId === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(info.bootId) &&
          Number.isInteger(info.port) && info.port >= 0 && info.port <= 65535 && typeof info.host === 'string';
        finish(valid ? info : null);
      } catch { finish(null); }
    });
    socket.on('timeout', () => connected ? finish(null, { unresponsive: true }) : fail(Object.assign(new Error('查询本地服务实例超时，未确认其是否运行。'), { code: 'ETIMEDOUT' })));
    socket.on('error', error => {
      if (connected || ['ENOENT', 'ECONNREFUSED'].includes(error.code)) finish(null);
      else fail(error);
    });
    socket.on('close', () => finish(null));
  });
}

/** The OS owns this lock: a killed process cannot leave a stale PID lock behind
 * on Windows or Linux. Canonicalize aliases so one DATA_DIR has one writer. */
export async function acquireRuntimeLock(directory, { describe } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const endpoint = await runtimeEndpoint(directory);
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.setTimeout(1500, () => socket.destroy());
    try {
      if (!describe) return socket.end();
      socket.end(JSON.stringify({ ...describe(), protocol: 'zhiheng-runtime/v1', pid: process.pid }) + '\n');
    } catch { socket.destroy(); }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ path: endpoint, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    if (['EADDRINUSE', 'EACCES'].includes(error.code)) {
      throw Object.assign(new Error('此数据目录已有服务实例运行；请使用现有地址，或先停止原实例再启动。'), { code: 'instance_running' });
    }
    throw error;
  }
  server.on('error', () => {});
  server.unref();
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await new Promise(resolve => server.close(resolve));
  };
}
