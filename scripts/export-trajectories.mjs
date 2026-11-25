#!/usr/bin/env node
/**
 * Export captured agent trajectories (DATA_DIR/trajectories) as training data.
 *
 *   node scripts/export-trajectories.mjs --format sft --out data/exports/sft.jsonl
 *   node scripts/export-trajectories.mjs --format dpo --out dpo.jsonl --profile local-qwen
 *   node scripts/export-trajectories.mjs --format raw --user <userId> --since 2026-11-01 --out raw.jsonl
 *
 * sft: completed tasks rated 👍 with exact per-call snapshots and passing checks.
 *      Unrated, secret-redacted, truncated or structurally invalid traces remain raw curation candidates.
 * dpo: 👎 with a written correction → {prompt, chosen: correction, rejected: model answer}.
 * raw: every record with its labels, for the lab's own curation.
 * Every exported string is scrubbed (API keys, bearer tokens, user paths, e-mail addresses).
 */
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { readTrajectories, toSftRows, toDpoRow, scrubDeep, trajectoryRoot } from '../src/server/trajectory.mjs';

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const format = option('format') || 'sft';
const out = option('out');
const since = option('since') ? Date.parse(option('since')) : null;
const profile = option('profile');
if (args.includes('--help') || !out || !['sft', 'dpo', 'raw'].includes(format) || (option('since') && Number.isNaN(since))) {
  console.log('用法：node scripts/export-trajectories.mjs --format sft|dpo|raw --out <文件.jsonl> [--user <id>] [--since YYYY-MM-DD] [--profile local-qwen|api]');
  process.exit(args.includes('--help') ? 0 : 2);
}

const destination = path.resolve(out);
const inside = path.relative(trajectoryRoot(), destination);
if (!inside.startsWith('..') && !path.isAbsolute(inside)) throw new Error('Export must not overwrite the trajectory capture directory');
if (fs.existsSync(destination)) throw new Error('Export already exists; choose a new versioned filename');
fs.mkdirSync(path.dirname(destination), { recursive: true });
const temporary = destination + '.tmp-' + process.pid;
const stream = fs.createWriteStream(temporary, { encoding: 'utf8', mode: 0o600, flags: 'wx' });
const completed = once(stream, 'close');
// Register rejection handling immediately, including write errors before end().
completed.catch(() => {});
const counts = { read: 0, written: 0, skipped: 0 };
for await (const { record, labels, tools } of readTrajectories({ userId: option('user') || null })) {
  counts.read++;
  if ((since && Date.parse(record.createdAt) < since) || (profile && record.model?.profile !== profile)) { counts.skipped++; continue; }
  const rows = format === 'sft' ? toSftRows(record, labels) : [format === 'raw' ? scrubDeep({ record, labels, tools }) : toDpoRow(record, labels, tools)].filter(Boolean);
  if (!rows.length) { counts.skipped++; continue; }
  for (const row of rows) {
    if (!stream.write(JSON.stringify(row) + '\n')) await once(stream, 'drain');
    counts.written++;
  }
}
stream.end(); await completed;
// Hard-link creation is exclusive: an intervening exporter cannot silently overwrite an existing artifact.
fs.linkSync(temporary, destination); fs.unlinkSync(temporary);
console.log(`轨迹 ${counts.read} 条，导出 ${counts.written} 条（${format}），跳过 ${counts.skipped} 条 → ${out}`);
