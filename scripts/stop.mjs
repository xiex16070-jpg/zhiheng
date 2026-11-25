/** Stop only the process identified by the DATA_DIR's live OS lock. */
import { inspectRuntime } from '../src/server/runtime-lock.mjs';
import { requestDesktopStop } from '../src/server/desktop-shutdown.mjs';
import { DATA, pause, runRuntimeCommand } from './runtime-client.mjs';

async function main() {
  const owner = await inspectRuntime(DATA);
  if (!owner.running) { console.log('此数据目录没有运行中的实例。'); return; }
  if (!owner.info) throw new Error('已有实例无法确认身份（可能是旧版服务）；请核对原服务进程后停止。未使用 PID 文件结束未知进程。');
  const { pid, bootId } = owner.info;
  const expected = process.argv.indexOf('--boot-id');
  if (expected !== -1 && process.argv[expected + 1] !== bootId) {
    console.log('原实例已退出，保留新实例。');
    return;
  }
  if (process.env.ZHIHENG_DESKTOP === '1' && owner.info.desktop !== true) throw new Error('该数据目录由其他服务使用，无法通过桌面入口停止。');
  if (pid === process.pid) throw new Error('拒绝结束停止脚本自身。');
  const checked = await inspectRuntime(DATA);
  if (checked.info?.pid !== pid || checked.info?.bootId !== bootId) throw new Error('服务实例已变化，请重新执行停止。');
  if (owner.info.desktop) await requestDesktopStop(DATA, bootId);
  else {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const next = await inspectRuntime(DATA);
    if (!next.running || (next.info && next.info.bootId !== bootId)) { console.log(`已停止 pid ${pid}。`); return; }
    await pause(100);
  }
  throw new Error(`pid ${pid} 尚未释放实例锁；保留运行记录，请检查服务状态。`);
}

await runRuntimeCommand(main);
