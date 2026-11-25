/** Private local state manifest: configuration and hashes, never text or credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {config} from '../src/server/config.mjs';

const args=process.argv.slice(2), output=args[args.indexOf('--output')+1];
if(!args.includes('--output')||!output||output.startsWith('--'))throw new Error('--output NEW_REPORT required');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileInfo(file){try{const bytes=await fs.readFile(file);return {sha256:digest(bytes),bytes:bytes.length};}catch(e){if(e.code==='ENOENT')return {exists:false};throw e;}}
const kb=JSON.parse(await fs.readFile(config.kbFile,'utf8'));
let gpu='unavailable';try{gpu=execFileSync('nvidia-smi',['--query-gpu=name,memory.total,memory.used','--format=csv,noheader'],{encoding:'utf8',windowsHide:true}).trim();}catch{}
const report={schemaVersion:1,status:'completed',recordedAt:new Date().toISOString(),
  git:execFileSync('git',['rev-parse','HEAD'],{cwd:config.root,encoding:'utf8',windowsHide:true}).trim(),
  source:{corpus:await fileInfo(config.corpus.jsonl),knowledge:await fileInfo(config.kbFile),vectors:await fileInfo(config.vectorFile)},
  configuration:{embedding:{provider:config.embedding.provider,model:config.embedding.model,dimension:config.embedding.dim,revision:config.embedding.revision||'',batch:config.embedding.batch},vectorFile:path.resolve(config.vectorFile),rerankEnabled:config.rerank?.enabled},
  metrics:{documents:kb.docs?.length||0,chunks:kb.chunks?.length||0,owners:new Set((kb.docs||[]).map(d=>d.userId)).size},gpu,
  privateInputsKeptLocal:true,contentsRecorded:false};
await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});
await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,status:report.status,metrics:report.metrics,configuration:report.configuration}));
