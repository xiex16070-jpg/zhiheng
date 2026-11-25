import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'semantic-support-'));
// A locally deployed BGE revision must not leak into this mock service contract.
Object.assign(process.env,{DATA_DIR:dir,MYSQL_ENABLED:'0',REDIS_ENABLED:'0',EMBEDDING_PROVIDER:'service',EMBEDDING_REVISION:'',VECTOR_FILE:path.join(dir,'vectors.json'),QDRANT_URL:'',RERANK_ENABLED:'0'});
const {config}=await import('../src/server/config.mjs');
const {saveJudgeSettings,judgeSettings,resolveJudge,independentJudge}=await import('../src/server/judge-settings.mjs');
const {checkAnswerSupport,citedSentences}=await import('../src/server/support-check.mjs');
const {sourceWindows}=await import('../src/server/source-windows.mjs');
const {formalVectorItems}=await import('../scripts/index-formal-vectors.mjs');
const {initVector,upsertVectors,searchVectors,vectorChannelWeight,vectorStatus}=await import('../src/server/vector.mjs');
const {rerankCandidates}=await import('../src/server/rerank.mjs');
const {fuse}=await import('../src/server/retrieve.mjs');
const {supportMetrics}=await import('../evals/semantic-evaluate.mjs');
let calls=[], judgeRows=null, unavailable=false, finishReason='stop';
const server=http.createServer(async(req,res)=>{
  if(req.url==='/health'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,model:'fixture-reranker'}));return;}
  if(req.method==='GET'){res.writeHead(404);res.end('{}');return;}
  let text='';for await(const c of req)text+=c;const body=JSON.parse(text);calls.push({path:req.url,body});
  if(unavailable){res.writeHead(503);res.end('{}');return;}
  if(req.url==='/embed'){res.setHeader('content-type','application/json');res.end(JSON.stringify({model:body.model,data:body.input.map((x,i)=>({index:i,embedding:x.includes('合取')?[1,0,0]:[0,1,0]}))}));return;}
  if(req.url==='/rerank'){res.setHeader('content-type','application/json');res.end(JSON.stringify({results:body.documents.map((x,index)=>({index,relevance_score:index/10}))}));return;}
  const items=JSON.parse(body.messages.at(-1).content), rows=judgeRows || items.map(x=>({i:x.i,verdict:'unsupported',score:0.05}));
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:JSON.stringify(rows)},finish_reason:finishReason}],usage:{prompt_tokens:50,completion_tokens:20,total_tokens:70}})}\n\ndata: [DONE]\n\n`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});});

test('owner judge settings encrypt keys, persist, enforce revision and fail closed on corruption',async()=>{
  const saved=await saveJudgeSettings('owner',{revision:0,enabled:true,baseUrl:base+'/v1',model:'judge-fixture',apiKey:'secret-only-fixture'});
  assert.equal(saved.timeoutMs,45000);assert.equal(saved.maxOutputTokens,4096);
  assert.equal(saved.hasKey,true);assert.equal(saved.apiKey,'');assert.ok(!(await fs.readFile(path.join(dir,'judges/owner.json'),'utf8')).includes('secret-only-fixture'));
  const again=await saveJudgeSettings('owner',{revision:1,apiKey:''});assert.equal(again.hasKey,true);assert.equal((await resolveJudge('owner')).apiKey,'secret-only-fixture');
  assert.equal((await judgeSettings('foreign')).enabled,false);
  await assert.rejects(()=>saveJudgeSettings('owner',{revision:0,enabled:false}),{code:'settings_conflict'});
  assert.equal(independentJudge({baseUrl:base,model:'vendor/SAME:latest'},{model:'same'}),false);
  await fs.writeFile(path.join(dir,'judges/broken.json'),'{broken');await assert.rejects(()=>resolveJudge('broken'),{code:'judge_settings_unreadable'});
});

test('sentence attribution does not lend a final citation to preceding sentences or fenced code',()=>{
  const rows=citedSentences('第一条没有证据。第二条有依据。 [[r1]]\n```js\n假代码 [[bad]]\n```\n第三条 [[r2]]。');
  assert.deepEqual(rows.map(r=>r.refs),[[],['r1'],['r2']]);assert.ok(rows.every(r=>!r.sentence.includes('假代码')));
});

test('partial judge coverage is explicit and never turns unassessed positives into passes',()=>{
  const rows=[...Array.from({length:20},()=>({expected:'unsupported',verdict:'unsupported',independent:true})),
    ...Array.from({length:4},()=>({expected:'supported',verdict:'supported',independent:true})),
    ...Array.from({length:6},()=>({expected:'supported',verdict:'unassessed',independent:false}))];
  const metrics=supportMetrics(rows);assert.equal(metrics.assessed,24);assert.equal(metrics.positiveCoverage,0.4);assert.equal(metrics.negativeCoverage,1);
  assert.equal(metrics.falsePositive,0);assert.equal(metrics.falsePositiveUpperBound,0.6);assert.equal(metrics.supportedPositives,4);
  assert.equal(supportMetrics(rows.map(r=>({...r,independent:false,verdict:'unassessed'}))).falsePositive,null);
});

test('12 claims use one independent request; invalid and uncited claims cannot be laundered',async()=>{
  const before=calls.length,body=Array.from({length:12},(_,i)=>`第${i}条声称所有样本都成功 [[r]]。`).join('\n')+'\n不存在的引用 [[missing]]。\n没有提供来源的一句话。';
  const result=await checkAnswerSupport({body,evidence:new Map([['r',{content:'研究只记录了一个样本，未报告所有样本的结果。'}]]),userId:'owner',answerProvider:{model:'answer-fixture'}});
  assert.equal(calls.length-before,1);assert.equal(result.summary.llmCalls,1);assert.equal(result.summary.checked,12);assert.equal(result.summary.usage.total_tokens,70);
  assert.equal(calls.at(-1).body.max_tokens,4096);
  assert.equal(result.support[12].verdict,'invalid_reference');assert.equal(result.support[13].verdict,'uncited');assert.ok(result.support.slice(0,12).every(r=>r.independent&&r.verdict==='unsupported'));
});

test('reasoning judge output limit is explicit and cannot certify even parseable partial verdicts',async()=>{
  finishReason='length';
  try{
    const result=await checkAnswerSupport({body:'这是需要核对的判断 [[r]]。',evidence:new Map([['r',{content:'原文中的依据。'}]]),userId:'owner',answerProvider:{model:'answer-fixture'}});
    assert.equal(result.summary.reason,'judge_output_limit');assert.equal(result.summary.audited,false);assert.equal(result.support[0].verdict,'unassessed');assert.equal(result.summary.usage.total_tokens,70);
  }finally{finishReason='stop';}
});

test('support judge persists its budget before a call and never calls when reservation fails',async()=>{
  const opts={body:'这是需要核对的判断 [[r]]。',evidence:new Map([['r',{content:'原文中的依据。'}]]),userId:'owner',answerProvider:{model:'answer-fixture'}};
  const before=calls.length;
  for(const [onCall,reason] of [[async()=>false,'judge_budget'],[async()=>{throw new Error('cannot persist');},'judge_budget_unavailable']]){
    const result=await checkAnswerSupport({...opts,onCall});assert.equal(result.summary.reason,reason);assert.equal(result.summary.llmCalls,0);assert.equal(result.support[0].verdict,'unassessed');
  }
  assert.equal(calls.length,before);
  let reserved=0;await checkAnswerSupport({...opts,userId:'foreign',onCall:async()=>{reserved++;}});assert.equal(reserved,0);
});

test('absent/same judge makes zero requests; malformed verdicts remain unassessed; failure never retries',async()=>{
  const opts={body:'原文引用支持的声明 [[r]]。',evidence:new Map([['r',{content:'声明原文。'}]]),answerProvider:{model:'judge-fixture'}};
  let before=calls.length;const same=await checkAnswerSupport({...opts,userId:'owner'});assert.equal(same.summary.llmCalls,0);assert.equal(calls.length,before);
  const none=await checkAnswerSupport({...opts,userId:'foreign'});assert.equal(none.summary.reason,'judge_not_configured');
  judgeRows=[{i:0,verdict:'supported',score:1},{i:0,verdict:'unsupported',score:0}];
  const bad=await checkAnswerSupport({...opts,userId:'owner',answerProvider:{model:'answer-fixture'}});assert.equal(bad.support[0].verdict,'unassessed');judgeRows=null;
  unavailable=true;before=calls.length;const failed=await checkAnswerSupport({...opts,userId:'owner',answerProvider:{model:'answer-fixture'}});unavailable=false;
  assert.equal(failed.summary.reason,'judge_unavailable');assert.equal(calls.length-before,1);
});

test('long formal windows retain exact offsets and parent IDs without rewriting the source corpus',()=>{
  const content='形式逻辑\n\n'+('Definition proof := A.\n合取消去规则在这里。\n'.repeat(100));
  const windows=sourceWindows(content);assert.ok(windows.length>4);assert.ok(windows.every(w=>w.text.length<=600&&content.slice(w.start,w.end)===w.text));
  const items=formalVectorItems([{id:42,title:'形式逻辑',content}], 'corpus-v1');assert.ok(items.every(i=>i.payload.parentRef==='42'&&i.payload.corpusId==='corpus-v1'));
  assert.equal(items.at(-1).payload.end,content.length);
});

test('semantic service contract uses /embed, isolates same-dimension models and never falls back into hash space',async()=>{
  Object.assign(config.embedding,{provider:'service',baseUrl:base,model:'fixture-embed',dim:3,batch:16});await initVector();
  await upsertVectors([{ref:'p1',text:'合取',payload:{kind:'paper',parentRef:'1',corpusId:'fixture'}}]);
  assert.equal((await searchVectors('合取')).results[0].ref,'p1');assert.equal(vectorChannelWeight(),1);
  await upsertVectors([{ref:'owned-doc',text:'合取',payload:{kind:'doc',userId:'vector-owner',docId:'owned'}},{ref:'foreign-doc',text:'合取',payload:{kind:'doc',userId:'foreign-owner',docId:'foreign'}}]);
  assert.deepEqual((await searchVectors('合取',{userId:'vector-owner'})).results.map(r=>r.ref),['owned-doc']);
  assert.deepEqual(new Set((await searchVectors('合取',{userId:'vector-owner',includePublicPapers:true})).results.map(r=>r.ref)),new Set(['p1','owned-doc']));
  assert.equal((await searchVectors('合取',{userId:'vector-owner',includePublicPapers:true,docIds:[]})).results.length,0);
  config.embedding.model='another-same-dim-model';assert.equal((await searchVectors('合取')).results.length,0);assert.equal(vectorStatus().requiresReindex,true);
  unavailable=true;await assert.rejects(()=>searchVectors('合取'),/embedding_failed/);unavailable=false;
  Object.assign(config.embedding,{provider:'local',baseUrl:''});assert.equal(vectorChannelWeight(),0.3);
  const item={ref:'one'},rank=fuse([{name:'vector',weight:0.3,items:[item]}],60,1);assert.equal(rank[0].rrf,Number((0.3/61).toFixed(5)));
});

test('auto reranking checks health and retains original source objects',async()=>{
  const rows=[{ref:'a',content:'内容甲',start:2,end:5},{ref:'b',content:'内容乙',start:9,end:12}];
  const result=await rerankCandidates('问题',rows,{settings:{enabled:'auto',url:base+'/rerank',model:'fixture-reranker'}});
  assert.equal(result.applied,true);assert.equal(result.results[0].ref,'b');assert.equal(result.results[0].start,9);
  const unavailable=await rerankCandidates('问题',rows,{settings:{enabled:'auto',url:base+'/absent/rerank',model:'fixture-reranker'}});assert.equal(unavailable.applied,false);
});
