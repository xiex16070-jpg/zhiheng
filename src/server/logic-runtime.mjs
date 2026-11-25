import { Worker } from 'node:worker_threads';

let active = 0;
const failure = (message, code) => Object.assign(new Error(message), { code });

/** Isolate user programs from the HTTP event loop, including parsing and proof construction. */
export function runLogicProgram(source, options = {}) {
  return execute(source, options, 'run');
}

export function inspectLogicProgram(source, options = {}) {
  return execute(source, options, 'inspect');
}

export function runAgentProgram(source, options) {
  return execute(source, options, 'agent');
}

function execute(source, options, mode) {
  if (typeof source !== 'string' || !source.trim()) return Promise.reject(failure('请输入知衡程序。', 'invalid_program'));
  if (source.length > 50000) return Promise.reject(failure('程序超过 50000 字符上限。', 'limit_exceeded'));
  if (active >= 4) return Promise.reject(failure('推演任务繁忙，请稍后重试。', 'logic_busy'));
  active += 1;
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const settle = () => { active -= 1; if (error) reject(error); else resolve(result); };
      if (worker) worker.terminate().then(settle, settle);
      else settle();
    };
    try {
      worker = new Worker(new URL('./logic-worker.mjs', import.meta.url), {
        workerData: { source, options, mode },
        resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
      });
      timer = setTimeout(() => finish(failure('推演超过运行时间上限，未返回截断结论。', 'limit_exceeded')), 2500);
      worker.once('message', (message) => {
        if (message.error) finish(Object.assign(new Error(message.error.message), message.error));
        else finish(null, message.result);
      });
      worker.once('error', (error) => finish(failure(error.message, error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'limit_exceeded' : 'logic_runtime_error')));
      worker.once('exit', (code) => { if (!settled) finish(failure(`推演进程提前结束（${code}）`, 'logic_runtime_error')); });
    } catch (error) { finish(error); }
  });
}
