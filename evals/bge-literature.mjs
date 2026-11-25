/** Fixed real-text anchor retrieval comparison. No model-generated answer grading. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const args=process.argv.slice(2),arg=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const variant=arg('--variant','lexical'),output=arg('--output'),index=arg('--index','');
if(!output || !['lexical','hash','hybrid-hash','dense','hybrid-bge'].includes(variant))throw new Error('Require --variant lexical|hash|hybrid-hash|dense|hybrid-bge --output NEW_REPORT');
await fs.access(output).then(()=>{throw new Error('Report already exists')},e=>{if(e.code!=='ENOENT')throw e});
const semantic=['dense','hybrid-bge'].includes(variant),channels=variant==='lexical'?['paper']:variant.startsWith('hybrid')?['paper','vector']:['vector'];
Object.assign(process.env,{CORPUS_PROFILE:'formal',CORPUS_JSONL:'',CORPUS_MANIFEST:'',FILE_INDEX_LIMIT:'10000',MYSQL_ENABLED:'0',REDIS_ENABLED:'0',RERANK_ENABLED:'0',RAGFLOW_BASE_URL:'',QDRANT_URL:'',
  EMBEDDING_PROVIDER:semantic?'service':'local',EMBEDDING_BASE_URL:semantic?arg('--base-url','http://127.0.0.1:8092'):'',EMBEDDING_MODEL:semantic?'BAAI/bge-m3':'local-hash-512',
  EMBEDDING_DIM:semantic?'1024':'512',EMBEDDING_REVISION:semantic?arg('--revision',''):'',EMBEDDING_API_KEY:'',VECTOR_FILE:index});
const [{initRag,getPaper,ragStatus},{retrieveAll},{initVector,vectorStatus},{citationIntegrity}]=await Promise.all([import('../src/server/rag.mjs'),import('../src/server/retrieve.mjs'),import('../src/server/vector.mjs'),import('./formal.mjs')]);
const source=await fs.readFile(path.join(root,'data/formal/papers.jsonl'),'utf8');
const records=source.trim().split(/\r?\n/).map(JSON.parse),byId=new Map(records.map(p=>[String(p.id),p]));
const casesFile=arg('--cases',path.join(root,'evals/bge-literature-cases.json')),caseText=await fs.readFile(casesFile,'utf8'),spec=JSON.parse(caseText);
const frozen=JSON.parse(await fs.readFile(casesFile+'.sha256.json','utf8'));
if(sha(caseText.replace(/\r\n?/g,'\n'))!==frozen.sha256)throw new Error('Frozen comparison cases changed');
for(const c of spec.cases)for(const anchor of c.anchors || []){const p=byId.get(anchor.ref);if(!p || p.contentSha256!==anchor.contentSha256 || !p.abstract.includes(anchor.quote) || p.contentRole==='exercise')throw new Error('Invalid source anchor '+c.id)}
await initRag({mysqlReady:false});if(channels.includes('vector')){if(!index)throw new Error('Vector variants require an explicit index');await initVector();const state=vectorStatus();if(!state.ready||state.requiresReindex||state.stalePoints||state.error)throw new Error('Vector index unavailable or incompatible')}
let health=null;if(semantic){const res=await fetch(process.env.EMBEDDING_BASE_URL+'/health');health=await res.json();if(!res.ok || !health.ready || health.model!=='BAAI/bge-m3' || health.revision!==process.env.EMBEDDING_REVISION || health.dim!==1024 || health.verifiedWeights!==true || !/^[a-f0-9]{64}$/.test(health.weightsSha256||''))throw new Error('Real embedding service identity/weights verification failed')}
const cases=[],ragasSamples=[];
for(const c of spec.cases){const started=performance.now(),result=await retrieveAll(c.question,{k:5,channels,sourceKind:'paper',rewrite:false}),ms=performance.now()-started;
  const ranked=[];for(const [i,item]of result.results.entries()){const p=await getPaper(item.ref),record=byId.get(item.ref);ranked.push({rank:i+1,ref:item.ref,sourcePath:item.sourcePath,section:item.section,relevant:(c.anchors||[]).some(a=>a.ref===item.ref),integrity:citationIntegrity(item,p,record),channels:item.channels})}
  const channelErrors=result.channels.filter(s=>s.error).map(s=>({channel:s.name,error:s.error}));for(const channel of channels)if(!result.channels.some(s=>s.name===channel))channelErrors.push({channel,error:'channel_not_executed'});
  const rank=ranked.find(r=>r.relevant)?.rank || null;cases.push({...c,latencyMs:Math.round(ms),rank,hitAt5:rank!==null,reciprocalRank:rank?1/rank:0,weak:result.weak,channelErrors,channels:result.channels,results:ranked});
  ragasSamples.push({id:c.id,user_input:c.question,retrieved_context_ids:result.results.map(r=>r.ref),reference_context_ids:(c.anchors||[]).map(a=>a.ref),retrieved_contexts:result.results.map(r=>r.snippet||r.content),controlled_context:false,expectInsufficient:c.expectInsufficient});
}
const positive=cases.filter(c=>!c.expectInsufficient),negative=cases.filter(c=>c.expectInsufficient),results=cases.flatMap(c=>c.results),latencies=cases.map(c=>c.latencyMs).sort((a,b)=>a-b);
const avg=(rows,fn)=>rows.length?rows.reduce((s,r)=>s+fn(r),0)/rows.length:null;
const metrics={positiveCases:positive.length,negativeCases:negative.length,channelErrorCases:cases.filter(c=>c.channelErrors.length).length,channelSuccessCoverage:avg(cases,c=>+!c.channelErrors.length),anchorHitAt5:avg(positive,c=>+c.hitAt5),anchorMrrAt5:avg(positive,c=>c.reciprocalRank),anchorNdcgAt5:avg(positive,c=>c.rank?1/Math.log2(c.rank+1):0),usableAnchorHitAt5:avg(positive,c=>+(c.hitAt5&&!c.weak)),insufficientDetection:avg(negative,c=>+(c.weak||!c.results.length)),citationIntegrity:avg(results,r=>+r.integrity.valid),medianLatencyMs:latencies[Math.floor(latencies.length/2)],p95LatencyMs:latencies[Math.floor(latencies.length*.95)],
  ...Object.fromEntries(['zh','en'].flatMap(language=>{const subset=positive.filter(c=>c.language===language);return [[language+'AnchorHitAt5',avg(subset,c=>+c.hitAt5)],[language+'AnchorMrrAt5',avg(subset,c=>c.reciprocalRank)]]}))};
const report={schema:'zhiheng-real-literature-retrieval/1',status:metrics.channelErrorCases?'failed':'completed',createdAt:new Date().toISOString(),variant,metrics,caseSetSha256:frozen.sha256,corpusSha256:sha(source.replace(/\r\n?/g,'\n')),corpus:ragStatus(),
  configuration:{channels,topK:5,rewrite:false,rerank:false,modelCalls:0,index:index||null,indexSha256:index?sha(await fs.readFile(index)):null,embeddingProvider:process.env.EMBEDDING_PROVIDER,embeddingModel:process.env.EMBEDDING_MODEL,embeddingRevision:process.env.EMBEDDING_REVISION,health,vector:channels.includes('vector')?vectorStatus():null},
  limitations:['Questions and anchors are AI-authored and source-checked, not human blind labels.','Gold anchors are intentionally narrow; other valid passages may be scored as misses.','This is real textbook retrieval, not a benchmark of research-paper answers or semantic entailment.','No query or threshold tuned using BGE outcomes.'],cases,ragasSamples};
await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,variant,metrics}));if(report.status==='failed')process.exitCode=1;
