/**
 * CSL 数据导入：TSV → data/papers.jsonl（+ MySQL papers 表）。
 *
 * 用法：
 *   node scripts/ingest-csl.mjs <csl.tsv> [--no-mysql]
 *
 * TSV 表头：title / abstract / keywords / discipline / category
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const src = process.argv[2];
const noMysql = process.argv.includes('--no-mysql');
if (!src) {
  console.error('用法: node scripts/ingest-csl.mjs <csl.tsv> [--no-mysql]');
  process.exit(1);
}

const outJsonl = path.join(ROOT, 'data', 'papers.jsonl');
await fs.mkdir(path.join(ROOT, 'data'), { recursive: true });

const papers = [];
const rl = readline.createInterface({ input: createReadStream(src, 'utf8'), crlfDelay: Infinity });

let header = true;
let skipped = 0;
for await (const line of rl) {
  if (header) {
    header = false;
    if (/title\s*\t/i.test(line)) continue;
  }
  if (!line.trim()) continue;
  const parts = line.split('\t');
  if (parts.length < 5) {
    skipped++;
    continue;
  }
  const [title, abstract, keywords, discipline, category] = parts;
  if (!title.trim() || !abstract.trim()) {
    skipped++;
    continue;
  }
  papers.push({
    id: papers.length + 1,
    title: title.trim(),
    abstract: abstract.trim(),
    keywords: (keywords || '').trim(),
    discipline: (discipline || '').trim(),
    category: (category || '').trim(),
  });
}

console.log(`解析完成：${papers.length} 条（跳过 ${skipped} 条）`);

const out = papers.map((p) => JSON.stringify(p)).join('\n');
await fs.writeFile(outJsonl, out);
const stat = await fs.stat(outJsonl);
console.log(`写入 ${outJsonl}（${(stat.size / 1024 / 1024).toFixed(1)} MB）`);

if (noMysql) {
  console.log('已跳过 MySQL 写入');
  process.exit(0);
}

const { initMysql, getPool, closeMysql } = await import('../src/server/db.mjs');
const pool = await initMysql();
if (!pool) {
  console.warn('MySQL 不可用，仅生成本地 JSONL');
  process.exit(0);
}

console.log('清空 papers 表…');
await pool.query('TRUNCATE TABLE papers');

const BATCH = 500;
const t0 = Date.now();
for (let i = 0; i < papers.length; i += BATCH) {
  const batch = papers.slice(i, i + BATCH);
  const values = batch.map((p) => [
    p.id,
    p.title,
    p.abstract,
    p.keywords,
    p.discipline,
    p.category,
    `${p.title}\n\n${p.abstract}${p.keywords ? `\n\n关键词：${p.keywords}` : ''}`,
    p.title.length + 2,
  ]);
  await pool.query(
    `INSERT INTO papers (id, title, abstract, keywords, discipline, category, content, abstract_start) VALUES ?`,
    [values]
  );
  if ((i / BATCH) % 10 === 0) process.stdout.write(`\r已写入 ${Math.min(i + BATCH, papers.length)} / ${papers.length}`);
}
console.log(`\nMySQL 写入完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const [rows] = await pool.query('SELECT COUNT(*) AS n FROM papers');
console.log(`校验：papers 表 ${rows[0].n} 行`);

await closeMysql();
