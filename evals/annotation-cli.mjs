import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBlindBatch, digest, ingestReviews } from './annotation-workflow.mjs';

const HELP = `Offline public-source annotation (no installation, network or model calls).
Export: node evals/annotation-cli.mjs export --input PUBLIC_PACK.json --out-dir NEW_DIRECTORY
Import: node evals/annotation-cli.mjs import --manifest coordinator-manifest.json --review-a A.json --review-b B.json
        --roster ROSTER.json [--adjudications DECISIONS.json] --out-dir NEW_DIRECTORY
Roster: {"a":{"id":"REAL_PERSON_A","exportUserId":1,"kind":"human","attestedBy":"COORDINATOR","attestedAt":"ISO_DATE"},"b":{...}}
Independent reviewer exports must come from separate blind copies. A coordinator must verify actual identities.
Valid imports write a completeness report; only complete reviews emit reviewed-cases.json.
Malformed or tampered inputs fail before writing output.
Use kind synthetic_fixture for software tests. It never becomes humanReviewed.
Existing files/directories are never overwritten. Freeze the generated SHA before evaluation.`;

async function read(filename) {
  if (!filename) throw new Error('missing_input_path');
  const info = await fs.stat(filename); if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('input_size_limit_32mb');
  const text = await fs.readFile(filename, 'utf8'); return { text, data: JSON.parse(text) };
}
async function write(directory, name, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(path.join(directory, name), text, { flag: 'wx' }); return digest(text);
}
export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help')) { console.log(HELP); return; }
  const [command, ...rest] = argv, args = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!/^--[a-z-]+$/.test(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--') || args[rest[i].slice(2)]) throw new Error('invalid_or_duplicate_argument');
    args[rest[i].slice(2)] = rest[i + 1];
  }
  if (!args['out-dir']) throw new Error('new_output_directory_required');
  const output = path.resolve(args['out-dir']); let result;
  if (command === 'export') result = createBlindBatch((await read(args.input)).data);
  else if (command === 'import') {
    const manifest = (await read(args.manifest)).data, roster = (await read(args.roster)).data;
    const reviews = [];
    for (const key of ['a', 'b']) {
      const exported = await read(args[`review-${key}`]);
      reviews.push({ reviewer: roster[key], tasks: exported.data, exportText: exported.text, exportFileSha256: digest(exported.text) });
    }
    result = ingestReviews({ manifest, reviews, adjudications: args.adjudications ? (await read(args.adjudications)).data : [] });
  } else throw new Error('unknown_command');
  // Validation finishes before any mutation. An existing directory is rejected, including frozen benchmark paths.
  await fs.mkdir(output);
  if (command === 'export') {
    await write(output, 'coordinator-manifest.json', result.manifest);
    await write(output, 'blind-a.json', result.tasks); await write(output, 'blind-b.json', result.secondTasks);
    await fs.copyFile(fileURLToPath(new URL('./labeling-templates/claim-support.xml', import.meta.url)), path.join(output, 'claim-support.xml'), fs.constants.COPYFILE_EXCL);
    console.log(JSON.stringify({ output, tasks: result.tasks.length, manifestSha256: result.manifest.sha256, humanLabelsCreated: 0 }));
  } else {
    const { dataset, ...report } = result;
    await write(output, 'import-report.json', report);
    if (dataset) {
      const sha256 = await write(output, 'reviewed-cases.json', dataset);
      await write(output, 'reviewed-cases.json.sha256.json', { sha256, normalization: 'LF', automaticallyPromotable: false });
    }
    console.log(JSON.stringify({ output, status: report.status, expected: report.expectedCases, resolved: report.resolvedCases, humanReviewed: dataset?.humanReviewed || false }));
    if (!dataset) process.exitCode = 2;
  }
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
