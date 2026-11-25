/** Reuse the verified DATA_DIR owner, or start one detached local server. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { inspectRuntime } from '../src/server/runtime-lock.mjs';
import { ROOT, DATA, WANT_PORT, pause, probeRuntime, runtimeUrl, browserUrl, runRuntimeCommand } from './runtime-client.mjs';

const LOG_FILE = path.join(DATA, 'server.log');
const TIMEOUT_MS = 45000;

function openBrowser(info) {
  const url = browserUrl(info);
  console.log(`服务地址：${url}`);
  if (process.env.KB_NO_OPEN === '1') return;
  try {
    const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const browser = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', () => {});
    browser.unref();
  } catch { /* Opening a browser is optional. */ }
}

async function main() {
  let owner = await inspectRuntime(DATA);
  let child, spawnError;
  if (!owner.running) {
    fs.mkdirSync(DATA, { recursive: true });
    const out = fs.openSync(LOG_FILE, 'a');
    try {
      fs.writeSync(out, `\n===== ${new Date().toISOString()} launch =====\n`);
      child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
        cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', out, out],
        env: { ...process.env, PORT: String(WANT_PORT), DATA_DIR: DATA },
      });
      child.on('error', error => { spawnError = error; });
      child.unref();
    } finally { fs.closeSync(out); }
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let reason = '等待服务就绪超时（45 秒），请检查初始化日志。';
  while (Date.now() < deadline) {
    owner = await inspectRuntime(DATA);
    if (process.env.ZHIHENG_DESKTOP === '1' && owner.info && (!owner.info.desktop || owner.info.host !== '127.0.0.1')) {
      reason = '数据目录已有其他服务实例。请关闭原实例或选用独立的桌面数据目录。';
      break;
    }
    if (owner.running && !owner.info && !owner.unresponsive) {
      reason = '此数据目录已有实例，但无法确认其地址（可能是旧版服务）。请确认原服务进程并停止后重启；未删除记录或终止未知进程。';
      break;
    }
    if (owner.info?.failed) { reason = '服务初始化失败。'; break; }
    if (owner.info && await probeRuntime(owner.info)) {
      if (process.argv.includes('--json')) {
        const { pid, bootId } = owner.info;
        const result = { pid, bootId, url: runtimeUrl(owner.info) };
        console.log(JSON.stringify(result));
        return result;
      }
      console.log(child?.pid === owner.info.pid ? `启动完成（pid ${owner.info.pid}）。` : `已在运行（pid ${owner.info.pid}），直接复用。`);
      if (WANT_PORT && owner.info.port !== WANT_PORT) console.log(`配置端口 ${WANT_PORT}，实际服务端口 ${owner.info.port}。`);
      openBrowser(owner.info);
      return;
    }
    if (spawnError) { reason = `无法创建服务进程：${spawnError.code || spawnError.message}`; break; }
    if (child && (child.exitCode !== null || child.signalCode) && !owner.running) { reason = `服务进程已退出（${child.exitCode ?? child.signalCode}）。`; break; }
    if (!child && !owner.running) { reason = '原服务实例在等待期间退出，请重新启动。'; break; }
    await pause(250);
  }
  if (child) {
    if (!process.argv.includes('--json')) {
      try { console.error(fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n')); } catch {}
    }
    // Only this launcher's child may be stopped. Never signal an arbitrary PID file.
    if (child.exitCode === null && !child.signalCode) { try { child.kill(); } catch {} }
  }
  throw new Error(`启动失败：${reason}\n数据目录：${DATA}\n日志：${LOG_FILE}`);
}

await runRuntimeCommand(main);
