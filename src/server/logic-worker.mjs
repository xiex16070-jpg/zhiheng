import { parentPort, workerData } from 'node:worker_threads';
import { runProgram, parseProgram } from '../logic/hanlogic.mjs';
import { runVerifiedProgram } from './logic-verification.mjs';

try {
  const evaluate = { inspect: parseProgram, run: runProgram, agent: runVerifiedProgram }[workerData.mode];
  parentPort.postMessage({ result: evaluate(workerData.source, workerData.options) });
} catch (error) {
  parentPort.postMessage({ error: {
    code: error.code || 'logic_runtime_error', message: error.message,
    ...(Number.isFinite(error.line) ? { line: error.line } : {}),
    ...(Number.isFinite(error.column) ? { column: error.column } : {}),
  } });
}
