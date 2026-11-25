import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const run=(args,env)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,args,{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let out='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);
  child.on('error',reject);child.on('close',code=>resolve({code,out}));
});
test('offline private rebuild preserves owners and offsets, rejects reuse, and leaves changed sources unactivated',async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'zh-private-migration-'));
  let mutate=false, requests=0, mutateAt=0, mutateManifestAt=0, manifestFile='';
  const source=path.join(temp,'kb.json');
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests++;
    if(mutate||requests===mutateAt){mutate=false;const data=JSON.parse(await fs.readFile(source));data.updatedDuringMigration=true;await fs.writeFile(source,JSON.stringify(data));}
    if(requests===mutateManifestAt)await fs.appendFile(manifestFile,'\n');
    res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'fixture',revision:'r1',data:body.input.map((_,index)=>({index,embedding:[1,0,0,0]}))}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>server.close(r));assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep+'zh-private-migration-'));await fs.rm(temp,{recursive:true,force:true});});
  const env={...process.env,DATA_DIR:temp,KB_FILE:source,QDRANT_URL:'',MYSQL_ENABLED:'0',EMBEDDING_PROVIDER:'service',EMBEDDING_BASE_URL:`http://127.0.0.1:${server.address().port}`,EMBEDDING_MODEL:'fixture',EMBEDDING_REVISION:'r1',EMBEDDING_DIM:'4',EMBEDDING_BATCH:'2',EMBEDDING_API_KEY:''};
  const docs=[{id:'doc-a',userId:'owner-a',name:'a.md',text:'Synthetic alpha source.',chunkCount:1},{id:'doc-b',userId:'owner-b',name:'b.md',text:'Synthetic beta source.',chunkCount:1}];
  const chunks=docs.map(d=>({id:d.id+'_0',docId:d.id,heading:'',text:d.text,start:0,end:d.text.length}));
  await fs.writeFile(source,JSON.stringify({docs,chunks}));
  const seed=path.join(temp,'public.json');
  manifestFile=seed+'.manifest.json';
  const seeded=await run(['--input-type=module','--eval',"const v=await import('./src/server/vector.mjs');await v.initVector();await v.upsertVectors([{ref:'public-1',text:'Public source',payload:{kind:'paper',corpusId:'fixture'}}]);"],{...env,VECTOR_FILE:seed});
  assert.equal(seeded.code,0,seeded.out);const original=await fs.readFile(seed,'utf8');
  await fs.writeFile(seed+'.manifest.json',JSON.stringify({schemaVersion:2,builtAt:new Date().toISOString(),indexSha256:createHash('sha256').update(original).digest('hex')}));
  const output=path.join(temp,'complete.json'),report=path.join(temp,'report.json');
  const args=['scripts/rebuild-private-vectors.mjs','--public-index',seed,'--output',output,'--report',report];
  const result=await run(args,env);assert.equal(result.code,0,result.out);
  const indexed=JSON.parse(await fs.readFile(output));assert.equal(Object.keys(indexed.points).length,3);
  if(process.platform!=='win32')assert.equal((await fs.stat(output)).mode & 0o777,0o600,'private index readable only by its owner');
  assert.equal(indexed.points['doc-b_0'].payload.userId,'owner-b');assert.equal(indexed.points['doc-b_0'].payload.end,docs[1].text.length);
  const summary=JSON.parse(await fs.readFile(report));assert.equal(summary.status,'completed');assert.equal(summary.metrics.foreignLookupHits,0);assert.equal(summary.activated,false);
  assert.equal(await fs.readFile(seed,'utf8'),original);assert.ok(!JSON.stringify(summary).includes('Synthetic beta source'));
  const before=requests,again=await run(args,env);assert.notEqual(again.code,0);assert.equal(requests,before,'existing output rejected before embedding');
  const failedOutput=path.join(temp,'changed.json'),failedReport=path.join(temp,'changed-report.json');mutate=true;
  const changed=await run(['scripts/rebuild-private-vectors.mjs','--public-index',seed,'--output',failedOutput,'--report',failedReport],env);
  assert.notEqual(changed.code,0,changed.out);assert.equal(JSON.parse(await fs.readFile(failedReport)).status,'failed');
  await assert.rejects(fs.access(failedOutput),{code:'ENOENT'});await fs.access(failedOutput+'.building');
  for(const kind of ['knowledge','manifest']){
    await fs.writeFile(source,JSON.stringify({docs,chunks}));
    // Each document is a single embedding call; the third request is the
    // owner lookup, after the original early source-integrity check.
    if(kind==='knowledge')mutateAt=requests+3;else mutateManifestAt=requests+3;
    const lateOutput=path.join(temp,`late-${kind}.json`),lateReport=path.join(temp,`late-${kind}-report.json`);
    const late=await run(['scripts/rebuild-private-vectors.mjs','--public-index',seed,'--output',lateOutput,'--report',lateReport],env);
    assert.notEqual(late.code,0,late.out);assert.equal(JSON.parse(await fs.readFile(lateReport)).status,'failed');
    await assert.rejects(fs.access(lateOutput),{code:'ENOENT'});await fs.access(lateOutput+'.building');
  }
});
