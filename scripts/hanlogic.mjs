#!/usr/bin/env node
import fs from 'node:fs';
import { runProgram, HanLogicError, DEFAULT_LIMITS } from '../src/logic/hanlogic.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const positional = args.filter((arg) => arg !== '--json');
if (args.includes('--help') || positional.length !== 1 || positional.some((arg) => arg.startsWith('--'))) {
  console.log('用法：node scripts/hanlogic.mjs <程序.han | -> [--json]\n使用 - 从标准输入读取。证明只相对于程序给定的事实与规则成立。');
  process.exitCode = args.includes('--help') ? 0 : 2;
} else {
  try {
    const filename = positional[0];
    // Bound bytes before decoding too; CLI input must not allocate an unbounded file.
    const descriptor = filename === '-' ? 0 : fs.openSync(filename, 'r');
    const chunks = [], buffer = Buffer.alloc(8192);
    let bytes = 0;
    try {
      while (true) {
        const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
        if (!length) break;
        bytes += length;
        if (bytes > DEFAULT_LIMITS.maxSourceChars * 4) throw new HanLogicError('limit_exceeded', '输入文件过大');
        chunks.push(Buffer.from(buffer.subarray(0, length)));
      }
    } finally { if (descriptor !== 0) fs.closeSync(descriptor); }
    const result = runProgram(Buffer.concat(chunks).toString('utf8'));
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log('知衡 HanLogic 0.1 · 相对于给定前提的形式推演\n');
      const proofs = new Map(result.proofs.map((proof) => [proof.id, proof]));
      for (const query of result.queries) {
        console.log(`${query.query} → ${query.label}`);
        const pending = [query.positiveProof, query.negativeProof].filter(Boolean), visited = new Set();
        while (pending.length) {
          const id = pending.shift();
          if (visited.has(id)) continue;
          visited.add(id);
          const proof = proofs.get(id);
          console.log(`  ${id} ${proof.conclusion} ← ${proof.kind === 'fact' ? '给定事实' : `规则「${proof.rule}」 / ${proof.premises.join('、')}`}（第 ${proof.line} 行）${proof.refs.length ? ` 依据：${proof.refs.join('、')}` : ''}`);
          for (const assumption of proof.assumptions) console.log(`     缺省假设：当前程序未导出 ${assumption.literal}`);
          pending.push(...proof.premises);
        }
      }
      console.log(`\n事实 ${result.stats.facts} 条，规则 ${result.stats.rules} 条，匹配 ${result.stats.steps} 步。`);
      for (const warning of result.warnings) console.log(`说明：${warning}`);
    }
  } catch (error) {
    const result = { error: error.code || 'io_error', message: error.message, ...(error instanceof HanLogicError ? { line: error.line, column: error.column } : {}) };
    if (json) console.error(JSON.stringify(result));
    else console.error(`知衡错误 [${result.error}]${result.line ? ` 第 ${result.line} 行，第 ${result.column} 列` : ''}：${result.message}`);
    process.exitCode = 1;
  }
}
