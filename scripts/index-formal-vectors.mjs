/** Explicit sidecar build. Never overwrite the live vector file or corpus. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sourceWindows } from '../src/server/source-windows.mjs';

export function formalVectorItems(papers, corpusId) {
  return papers.flatMap(paper => sourceWindows(paper.content).map((window, index) => ({
    ref: `formal-window:${paper.id}:${index}`, text: window.text,
    payload: { kind: 'paper', parentRef: String(paper.id), title: paper.title, discipline: paper.discipline,
      corpusId, ...window, parentSha256: createHash('sha256').update(paper.content).digest('hex') },
  })));
}
export async function main(args = process.argv.slice(2)) {
  const at = args.indexOf('--output'); if (at < 0 || !args[at + 1] || args[at + 1].startsWith('--')) throw new Error('Explicit --output NEW_VECTOR_FILE is required; live indexes are never replaced');
  const output = path.resolve(args[at + 1]);
  if (await fs.stat(output).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))) throw new Error('Output already exists; choose a fresh index version');
  if (await fs.stat(output+'.manifest.json').then(()=>true,error=>error.code==='ENOENT'?false:Promise.reject(error)))throw new Error('Output manifest already exists; choose a fresh index version');
  process.env.VECTOR_FILE = output; process.env.QDRANT_URL = ''; process.env.MYSQL_ENABLED = '0';
  const [{config}, rag, vector] = await Promise.all([import('../src/server/config.mjs'), import('../src/server/rag.mjs'), import('../src/server/vector.mjs')]);
  if (config.embedding.provider === 'local' && !args.includes('--allow-hash-contract')) throw new Error('Configure a semantic embedding provider; --allow-hash-contract is only for contract checks');
  await rag.initRag({ mysqlReady: false }); await vector.initVector();
  const raw = await fs.readFile(config.corpus.jsonl, 'utf8');
  const papers = [];
  for (const row of raw.trim().split(/\r?\n/).map(JSON.parse)) { const paper = await rag.getPaper(row.id); if (paper) papers.push(paper); }
  const items = formalVectorItems(papers, rag.ragStatus().corpusId);
  if(args.includes('--plan')) {const lengths=items.map(x=>x.text.length).sort((a,b)=>a-b);console.log(JSON.stringify({output,parents:papers.length,windows:items.length,p90Chars:lengths[Math.floor(lengths.length*.9)],maxChars:lengths.at(-1),activated:false,written:false}));return;}
  const startedAt=new Date().toISOString();
  console.log(JSON.stringify({event:'index_started',output,parents:papers.length,windows:items.length,startedAt}));
  // embed() already bounds outgoing batches. Persist only when every batch succeeds:
  // repeatedly rewriting the whole JSON can fail under Windows scanners and leaves
  // a misleading partial index. The explicit build is small enough to stage in RAM.
  await vector.upsertVectors(items);
  const indexSha256=createHash('sha256').update(await fs.readFile(output)).digest('hex');
  await fs.writeFile(output+'.manifest.json',JSON.stringify({schemaVersion:2,startedAt,builtAt:new Date().toISOString(),corpus:rag.ragStatus(),embedding:vector.vectorStatus(),
    indexSha256,corpusSha256:createHash('sha256').update(raw).digest('hex'),parents:papers.length,windows:items.length,maxChars:600,overlap:80,activated:false},null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({ output, parents: papers.length, windows: items.length, status: vector.vectorStatus(), activated: false }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
