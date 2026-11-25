import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';

// On failure keep the final shrunk synthetic input outside the checkout.
// Replay one named test with the recorded FC_SEED and FC_PATH.
export async function checkProperty(name, property, numRuns, examples = []) {
  const seed = Number(process.env.FC_SEED ?? 651442);
  if (!Number.isSafeInteger(seed) || seed < -2147483648 || seed > 2147483647) throw new Error('FC_SEED must be a signed 32-bit integer');
  const result = await fc.check(property, { seed, numRuns, examples, path: process.env.FC_PATH || '' });
  if (!result.failed) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-property-'));
  const file = path.join(directory, name + '.json');
  await fs.writeFile(file, JSON.stringify({ name, seed: result.seed, path: result.counterexamplePath,
    numShrinks: result.numShrinks, counterexample: result.counterexample }, null, 2), 'utf8');
  throw new Error(fc.defaultReportMessage(result) + '\nShrunk input: ' + file, { cause: result.errorInstance });
}
