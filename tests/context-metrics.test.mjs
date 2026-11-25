import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-context-review-'));
process.env.DATA_DIR=directory;process.env.STORE_FILE=path.join(directory,'store.json');process.env.MYSQL_ENABLED='false';
const {createStore}=await import('../src/server/store.mjs');
const store=await createStore(false);
const {estimateTokens,estimateToolTokens}=await import('../src/server/context.mjs');
const {contextComposition,withContextTelemetry,beginContextRequest,finishContextRequest,contextDashboard}=await import('../src/server/context-metrics.mjs');
after(()=>fs.rm(directory,{recursive:true,force:true}));
const marker='SECRET_QUESTION_SOURCE_ARGUMENT';
test('Chinese tool schema and call arguments use the same conservative estimator as Chinese prose',()=>{
  const tools=[{type:'function',function:{name:'read_file',description:'汉'.repeat(800),parameters:{type:'object'}}}];
  assert.ok(estimateToolTokens(tools)>=800);
  const messages=[{role:'assistant',content:'',tool_calls:[{id:'call',function:{name:'write_file',arguments:JSON.stringify({content:'汉'.repeat(800)})}}]}];
  assert.ok(estimateTokens(messages)>=800);
  const composition=contextComposition([{role:'system',content:'rules'},{role:'user',content:marker},{role:'user',_contextKind:'injected',content:'资料'.repeat(50)},{role:'tool',content:marker}],tools);
  assert.equal(composition.total,Object.values(composition.parts).reduce((a,b)=>a+b,0));assert.ok(composition.parts.injected>=100);assert.ok(composition.parts.tools>=800);assert.ok(!JSON.stringify(composition).includes(marker));
});
test('context stats bind owner, deduplicate request phases, preserve missing usage and count failed-task budgets',async()=>{
  await store.ensureUser('alice');await store.ensureUser('bob');
  await store.createConversation({id:'conversation',userId:'alice',title:'fixture'});
  await store.createTask({id:'task',conversationId:'conversation',userId:'alice',question:marker,checkpoint:{workspaceId:'default',llmCalls:{main:2,aux:1,sub:0}}});
  const events=[],input={provider:{model:'fixture',apiKey:'NEVER_PERSIST_SECRET'},messages:[{role:'user',content:marker}],tools:[{type:'function',function:{name:'read_file',description:marker,parameters:{type:'object'}}}],maxTokens:400};
  assert.equal(await withContextTelemetry({userId:'bob',taskId:'task'},()=>beginContextRequest(input)),null);
  await withContextTelemetry({userId:'alice',taskId:'task',emit:event=>events.push(event)},async()=>{
    const request=await beginContextRequest(input);await finishContextRequest(request,{content:marker,toolCalls:[],finishReason:'stop'},null);
    const measured=await beginContextRequest({...input,attempt:1});await finishContextRequest(measured,{content:'ok',toolCalls:[],usage:{prompt_tokens:120,completion_tokens:30,prompt_tokens_details:{cached_tokens:80}}},null);
  });
  await store.updateTask('task',{status:'failed',error:'fixture'});
  const stats=await contextDashboard('alice');assert.equal(stats.requests.length,2);assert.equal(stats.requests[0].usage,null);assert.equal(stats.totals.unreportedRequests,1);
  assert.equal(stats.totals.input,120);assert.equal(stats.totals.output,30);assert.equal(stats.totals.cachedInput,80);assert.equal(stats.taskCalls,3);
  assert.equal(stats.pricing.available,false);assert.ok(stats.requests.every(row=>row.estimated));assert.ok(stats.requests.every(row=>row.outputReserve===400));
  const serialized=JSON.stringify({stats,events,steps:await store.listSteps('task')});assert.ok(!serialized.includes(marker));assert.ok(!serialized.includes('NEVER_PERSIST_SECRET'));
  await assert.rejects(contextDashboard('bob',{conversationId:'conversation'}),/not_found/);assert.equal((await contextDashboard('bob')).taskCount,0);
});
test('missing or malformed provider usage remains unknown, and local Qwen records its real context window',async()=>{
  await store.ensureUser('usage-owner');
  await store.createConversation({id:'usage-conversation',userId:'usage-owner',title:'usage fixture'});
  await store.createTask({id:'usage-task',conversationId:'usage-conversation',userId:'usage-owner',question:'fixture'});
  const input={provider:{model:'qwen3-8b-zhiheng',baseUrl:'http://127.0.0.1:11434/v1'},messages:[{role:'user',content:'短问题'}],tools:[],maxTokens:384};
  await withContextTelemetry({userId:'usage-owner',taskId:'usage-task'},async()=>{
    for(const usage of [{},{prompt_tokens:'120',completion_tokens:30},{prompt_tokens:-1,completion_tokens:30},{prompt_tokens:120,completion_tokens:30}]){
      const record=await beginContextRequest(input);await finishContextRequest(record,{content:'ok',usage},null);
    }
  });
  const stats=await contextDashboard('usage-owner');
  assert.equal(stats.requests.length,4);assert.equal(stats.totals.unreportedRequests,3);assert.equal(stats.totals.reportedRequests,1);
  assert.equal(stats.requests.at(-1).usage.cachedInput,null);assert.equal(stats.requests.at(-1).usage.reasoning,null);
  assert.equal(stats.totals.cacheReportedRequests,0);assert.equal(stats.totals.cacheInputBase,0);
  assert.ok(stats.requests.every(row=>row.budget===4096&&row.outputReserve===384));
});
