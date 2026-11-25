import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { estimateTokens, estimateToolTokens } from './context.mjs';
import { getRuntimeSettings } from './runtime-settings.mjs';
import { getStore } from './store.mjs';
import { isLocalQwen, LOCAL_QWEN_CONTEXT } from './local-qwen.mjs';

const scope = new AsyncLocalStorage();
export const withContextTelemetry = (identity, run) => scope.run(identity, run);
const number = n => Number.isFinite(Number(n)) && Number(n)>=0 ? Math.floor(Number(n)) : 0;
const kinds = ['system','tools','user','injected','assistant','toolResults'];
export function contextComposition(messages=[],tools=[]) {
  const parts=Object.fromEntries(kinds.map(k=>[k,0]));
  for(const m of messages) {
    const kind=m._contextKind==='injected'?'injected':({system:'system',user:'user',assistant:'assistant',tool:'toolResults'}[m.role]||'injected');
    parts[kind]+=estimateTokens([m]);
  }
  parts.tools=estimateToolTokens(tools);
  return {parts,total:Object.values(parts).reduce((a,b)=>a+b,0),messages:messages.length,
    topTools:tools.map(t=>({name:String(t.function?.name||'tool').slice(0,100),tokens:estimateToolTokens([t])})).sort((a,b)=>b.tokens-a.tokens).slice(0,5)};
}
/** Records numbers only. No questions, prompts, schemas, tool arguments or credentials. */
export async function beginContextRequest({provider,messages,tools,maxTokens,attempt=0}) {
  const owner=scope.getStore(); if(!owner?.userId||!owner.taskId)return null;
  const store=getStore(),task=await store.getTaskForUser(owner.taskId,owner.userId); if(!task)return null;
  const settings=getRuntimeSettings(owner.userId),composition=contextComposition(messages,tools);
  const detail={id:crypto.randomUUID(),at:new Date().toISOString(),model:String(provider.model||'').slice(0,120),...composition,
    budget:isLocalQwen(provider)?LOCAL_QWEN_CONTEXT:settings.contextBudget,outputReserve:number(maxTokens),attempt,estimated:true,phase:'request'};
  await store.addStep({taskId:owner.taskId,name:'context.request',status:'running',detail});
  owner.emit?.({type:'context_snapshot',...detail});
  return {owner,detail,started:Date.now()};
}
export async function finishContextRequest(record,result,error) {
  if(!record)return;
  const {owner,detail,started}=record,u=result?.usage;
  const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  const input=count(u?.prompt_tokens ?? u?.input_tokens),output=count(u?.completion_tokens ?? u?.output_tokens);
  const usage=input!==null&&output!==null?{input,output,
    cachedInput:count(u?.prompt_tokens_details?.cached_tokens ?? u?.prompt_cache_hit_tokens ?? u?.cache_read_input_tokens),
    reasoning:count(u?.completion_tokens_details?.reasoning_tokens)}:null;
  const final={...detail,phase:error?'error':'complete',ms:Date.now()-started,usage,outputEstimate:result?estimateTokens([{role:'assistant',content:result.content||'',tool_calls:result.toolCalls||[]}]):0,
    finishReason:result?.finishReason||null,error:error?String(error.code||'request_failed').slice(0,100):null};
  await getStore().addStep({taskId:owner.taskId,name:'context.request',status:error?'error':'ok',detail:final,ms:final.ms});
  owner.emit?.({type:'context_snapshot',...final});
}
export async function contextDashboard(userId,{conversationId='',days=7}={}) {
  const store=getStore(); if(conversationId){const c=await store.getConversation(conversationId);if(!c||c.userId!==userId)throw Object.assign(new Error('not_found'),{status:404});}
  const recent=await store.listTasks(userId,300),cutoff=days?Date.now()-days*86400000:0;
  const tasks=recent.filter(t=>(!conversationId||t.conversationId===conversationId)&&new Date(t.updatedAt||t.createdAt).getTime()>=cutoff);
  const requests=[],events=[],tools=new Map(),skills=new Map(),files=[];
  let taskCalls=0;
  for(const task of tasks){
    const records=new Map(),steps=await store.listSteps(task.id);
    const calls = task.result?.llmCalls || task.checkpoint?.llmCalls || {};
    taskCalls+=number(calls.main)+number(calls.aux)+number(calls.sub);
    for(const step of steps){
      const at=step.detail?.at || step.createdAt || task.updatedAt;
      if(cutoff && new Date(at).getTime()<cutoff) continue;
      if(step.name==='context.request'&&step.detail?.id)records.set(step.detail.id,{...step.detail,taskId:task.id,conversationId:task.conversationId,workspaceId:task.checkpoint?.workspaceId||'default'});
      else if(/^(compact|micro_compact|context_prune)$/.test(step.name))events.push({taskId:task.id,name:step.name,status:step.status,at:step.createdAt||task.updatedAt,detail:step.detail});
      else if(/^tool[:#]/.test(step.name)&&!['running','pending'].includes(step.status)){const name=step.name.replace(/^tool[:#]/,'').split(':')[0];tools.set(name,(tools.get(name)||0)+1);}
    }
    requests.push(...records.values());
    for(const name of new Set(task.result?.usedSkills||task.checkpoint?.usedSkills||[]))skills.set(name,(skills.get(name)||0)+1);
    for(const a of task.result?.artifacts||[])if(a.path)files.push({taskId:task.id,path:a.path,action:a.action||'write',workspaceId:a.workspaceId||task.checkpoint?.workspaceId||'default'});
  }
  requests.sort((a,b)=>a.at.localeCompare(b.at));events.sort((a,b)=>String(a.at).localeCompare(String(b.at)));
  const totals={input:0,output:0,cachedInput:0,cacheInputBase:0,cacheReportedRequests:0,reasoning:0,ms:0,reportedRequests:0,unreportedRequests:0};
  const daily=new Map();
  for(const row of requests){totals.ms+=row.ms||0;if(row.usage){totals.reportedRequests++;for(const key of ['input','output','cachedInput','reasoning'])totals[key]+=row.usage[key]||0;if(row.usage.cachedInput!==null&&row.usage.cachedInput!==undefined){totals.cacheReportedRequests++;totals.cacheInputBase+=row.usage.input;}}else totals.unreportedRequests++;
    const day=row.at.slice(0,10),d=daily.get(day)||{day,input:0,output:0,requests:0};d.requests++;d.input+=row.usage?.input||0;d.output+=row.usage?.output||0;daily.set(day,d);}
  return {version:1,conversationId,days,taskCount:tasks.length,taskCalls,requests:requests.slice(-250),latest:requests.at(-1)||null,totals,daily:[...daily.values()],events:events.slice(-100),
    toolActivity:[...tools].map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count),skillActivity:[...skills].map(([name,count])=>({name,count})),fileActivity:files.slice(-100),
    coverage:{maxTasks:300,recordedRequests:requests.length,legacyTasks:tasks.filter(t=>!requests.some(r=>r.taskId===t.id)).length},
    pricing:{available:false,reason:'未配置可信单价，不推算账单。'},storage:'只保存统计元数据，不复制问题、文档或工具原文。'};
}
