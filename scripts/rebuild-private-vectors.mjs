/** Explicit offline migration: seed a NEW index with public vectors, then embed private chunks locally. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';

// This CLI writes private document text. Restrict every atomic temporary file
// created by the existing vector writer, as well as the final hard-linked file.
process.umask(0o077);
const args=process.argv.slice(2);
function option(name){const index=args.indexOf(name);if(index<0||!args[index+1]||args[index+1].startsWith('--'))throw new Error(`${name} required`);return path.resolve(args[index+1]);}
const publicFile=option('--public-index'), output=option('--output'), reportFile=option('--report');
const working=output+'.building';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
for(const file of [output,working,reportFile,output+'.manifest.json']){
  if(await fs.stat(file).then(()=>true,e=>e.code==='ENOENT'?false:Promise.reject(e)))throw new Error('Choose fresh output and report paths');
}
if(publicFile===output||publicFile===working)throw new Error('Public input must remain unchanged');
process.env.VECTOR_FILE=working;process.env.QDRANT_URL='';process.env.MYSQL_ENABLED='0';
const {config}=await import('../src/server/config.mjs');
const endpoint=new URL(config.embedding.baseUrl);
if(config.embedding.provider!=='service'||!['http:','https:'].includes(endpoint.protocol)||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password)throw new Error('Private migration requires the local embedding service');
const source=await fs.readFile(config.kbFile), originalPublic=await fs.readFile(publicFile);
const records=JSON.parse(source),publicIndex=JSON.parse(originalPublic);
const publicManifestBytes=await fs.readFile(publicFile+'.manifest.json');
const publicManifest=JSON.parse(publicManifestBytes);
if(publicManifest.schemaVersion!==2||!publicManifest.builtAt||publicManifest.indexSha256!==hash(originalPublic))throw new Error('Public seed lacks a valid completed manifest');
if(publicIndex.version!==2||publicIndex.dim!==config.embedding.dim||!publicIndex.fingerprint)throw new Error('Invalid public seed index');
if(!Array.isArray(records.docs)||!Array.isArray(records.chunks)||records.docs.some(d=>typeof d.userId!=='string'||!d.userId))throw new Error('Missing document ownership');
if(Object.values(publicIndex.points||{}).some(p=>p.payload?.kind!=='paper'))throw new Error('Seed may contain only public paper points');
await fs.mkdir(path.dirname(output),{recursive:true});await fs.mkdir(path.dirname(reportFile),{recursive:true});
await fs.copyFile(publicFile,working,constants.COPYFILE_EXCL);
await fs.chmod(working,0o600);
const report={schemaVersion:2,status:'running',startedAt:new Date().toISOString(),activated:false,
  inputs:{publicIndexSha256:hash(originalPublic),publicManifestSha256:hash(publicManifestBytes),knowledgeSha256:hash(source)},
  configuration:{model:config.embedding.model,revision:config.embedding.revision,dimension:config.embedding.dim,batch:config.embedding.batch},
  metrics:{publicWindows:Object.keys(publicIndex.points||{}).length,documents:0,privateChunks:0,owners:new Set(records.docs.map(d=>d.userId)).size},privateContentsKeptLocal:true};
const started=Date.now();
try{
  const vector=await import('../src/server/vector.mjs'), kb=await import('../src/server/kb.mjs');
  await vector.initVector();
  if(vector.vectorStatus().requiresReindex)throw new Error('Public index embedding fingerprint differs');
  await kb.initKb({mysqlReady:false});
  const docs=await kb.listDocuments('*',{limit:2147483647});
  for(const [i,doc] of docs.entries()){
    const result=await kb.indexDocumentVectors(doc.id,doc.userId);
    if(result.indexed!==doc.chunkCount)throw new Error('Private chunk count mismatch');
    report.metrics.documents++;report.metrics.privateChunks+=result.indexed;
    console.log(JSON.stringify({progress:i+1,total:docs.length,indexed:result.indexed,elapsedMs:Date.now()-started}));
  }
  if(hash(await fs.readFile(config.kbFile))!==report.inputs.knowledgeSha256)throw new Error('Knowledge changed during rebuild; do not activate');
  if(hash(await fs.readFile(publicFile))!==report.inputs.publicIndexSha256)throw new Error('Public seed changed during rebuild; do not activate');
  const bytes=await fs.readFile(working), rebuilt=JSON.parse(bytes), points=Object.values(rebuilt.points||{});
  const docsById=new Map(records.docs.map(d=>[d.id,d])), chunks=new Map(records.chunks.map(c=>[c.id,c]));
  for(const point of points){
    const p=point.payload;
    if(point.vector?.length!==config.embedding.dim||point.vector.some(x=>!Number.isFinite(x))||p?._embeddingFingerprint!==rebuilt.fingerprint)throw new Error('Vector identity validation failed');
    if(p.kind==='doc'){
      const doc=docsById.get(p.docId), chunk=chunks.get(p.ref);
      if(!doc||!chunk||p.userId!==doc.userId||chunk.docId!==doc.id||p.text!==chunk.text||p.start!==chunk.start||p.end!==chunk.end)throw new Error('Private ownership or source mapping mismatch');
    }
  }
  if(points.length!==report.metrics.publicWindows+report.metrics.privateChunks)throw new Error('Final point count mismatch');
  if(docs.length){
    const sample=records.chunks.find(c=>c.docId===docs[0].id);
    if(!sample?.text)throw new Error('Cannot verify ownership without a source chunk');
    const own=await vector.searchVectors(sample.text.slice(0,200),{userId:docs[0].userId,kind:'doc',k:3});
    const ownerIds=new Set(records.docs.map(d=>d.userId));
    let foreignId='migration-audit-foreign';while(ownerIds.has(foreignId))foreignId+='-x';
    const foreign=await vector.searchVectors(sample.text.slice(0,200),{userId:foreignId,kind:'doc',k:3});
    if(!own.results.length||own.results.some(x=>x.payload.userId!==docs[0].userId)||foreign.results.length)throw new Error('Live owner isolation check failed');
    report.metrics.ownerLookupHits=own.results.length;report.metrics.foreignLookupHits=foreign.results.length;
  }
  // The live isolation checks above await HTTP. Recheck all inputs AFTER those
  // requests, immediately before publication; activation must recheck once more.
  if(hash(await fs.readFile(config.kbFile))!==report.inputs.knowledgeSha256)throw new Error('Knowledge changed before publication; do not activate');
  if(hash(await fs.readFile(publicFile))!==report.inputs.publicIndexSha256)throw new Error('Public seed changed before publication; do not activate');
  if(hash(await fs.readFile(publicFile+'.manifest.json'))!==report.inputs.publicManifestSha256)throw new Error('Public manifest changed before publication; do not activate');
  // link is an atomic no-overwrite publication on this same volume.
  await fs.link(working,output);await fs.unlink(working);
  Object.assign(report,{status:'completed',finishedAt:new Date().toISOString(),durationMs:Date.now()-started,outputSha256:hash(bytes),outputBytes:bytes.length,output});
  await fs.writeFile(output+'.manifest.json',JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
}catch(error){report.status='failed';report.error=String(error.message).slice(0,250);report.durationMs=Date.now()-started;process.exitCode=1;}
await fs.writeFile(reportFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:report.status,report:reportFile,metrics:report.metrics,error:report.error}));
