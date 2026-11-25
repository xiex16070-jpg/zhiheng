import path from 'node:path';
import { listFiles, readFile } from './workspace.mjs';

const textTypes = new Set('txt md rst tex csv tsv json jsonl yaml yml toml xml html css js mjs cjs jsx ts tsx vue py java c h cpp hpp rs go rb sh ps1 sql v lean zhl'.split(' '));
const scanFileBytes = 256 * 1024;
const scanTotalBytes = 4 * 1024 * 1024;

function textCandidate(name) {
  const base = path.posix.basename(name).toLowerCase();
  return textTypes.has(path.posix.extname(base).slice(1)) || ['readme', 'license', 'makefile', 'dockerfile'].includes(base);
}

export async function searchFiles(userId, query, signal) {
  if (typeof query !== 'string' || !query.trim() || query.length > 160 || /[\r\n]/.test(query)) {
    return { ok: false, message: '请输入单行检索文本（1–160 字符）。' };
  }
  const files = await listFiles(userId);
  const matches = [];
  let scanned = 0, partial = 0, remaining = scanTotalBytes;
  for (const file of files) {
    signal?.throwIfAborted();
    if (!textCandidate(file.path)) continue;
    if (matches.length >= 20 || remaining <= 0) break;
    const cap = Math.min(scanFileBytes, remaining);
    const r = await readFile(userId, file.path, cap);
    if (!r.ok) continue;
    remaining -= Math.min(r.bytes, cap);
    if (r.content.includes('\0')) continue;
    scanned++;
    if (r.truncated) partial++;
    const lines = r.content.split(/\r?\n/);
    for (let i = 0; i < lines.length && matches.length < 20; i++) {
      const at = lines[i].indexOf(query);
      if (at < 0) continue;
      const start = Math.max(0, at - 50);
      const end = Math.min(lines[i].length, at + query.length + 80);
      matches.push({ path: file.path, line: i + 1, snippet: (start ? '…' : '') + lines[i].slice(start, end) + (end < lines[i].length ? '…' : '') });
    }
  }
  return { ok: true, scanned, partial, matches, limitReached: matches.length >= 20 || remaining <= 0 };
}

export async function readFileLines(userId, file, start = 1, count = 30) {
  if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(count) || count < 1 || count > 100) {
    return { ok: false, code: 'invalid_range', message: 'start_line 从 1 开始，line_count 须为 1–100 的整数。' };
  }
  const r = await readFile(userId, file, 1024 * 1024);
  if (!r.ok) return r;
  if (r.content.includes('\0')) return { ok: false, code: 'binary', message: '指定文件含二进制内容。' };
  const lines = r.content.split(/\r?\n/);
  if (!lines.at(-1)) lines.pop();
  if (start > lines.length) return { ok: false, code: 'out_of_range', message: r.truncated ? '起始行超出可读取的前 1 MiB。' : `起始行超出文件的 ${lines.length} 行。` };
  const selected = lines.slice(start - 1, start - 1 + count).map((line, i) => `${start + i} | ${line}`).join('\n');
  return { ...r, content: selected.slice(0, 8000), truncated: selected.length > 8000 || (r.truncated && start - 1 + count >= lines.length) };
}
