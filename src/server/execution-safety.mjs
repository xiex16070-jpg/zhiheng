import { workflowJournal, journalKey } from './workflow-journal.mjs';
import { FILE_MUTATIONS } from './file-permissions.mjs';

const effects = new Set([...FILE_MUTATIONS, 'run_command','exec_start','exec_write','exec_stop','call_extension','desktop_open_url','start_background_task','cancel_background_task','update_preferences']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])) : value;
const clean = value => String(value).replace(/(?:Bearer\s+)[A-Za-z0-9._~+\/-]+/gi,'Bearer [hidden]').replace(/\b(?:sk-|tvly-)[A-Za-z0-9_-]{8,}/g,'[hidden]').replace(/([?&](?:key|api_key|token|access_token|secret)=)[^&#\s]+/gi,'$1[hidden]');
export function safeToolArguments(value, depth=0) {
  if(depth>5)return '[nested]';
  if(Array.isArray(value))return value.slice(0,24).map(item=>safeToolArguments(item,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,32).map(([key,item])=>[key,
    /password|secret|token|api.?key|authorization|cookie|credential|env/i.test(key)?'[hidden]':
    /^(content|markdown|text|old_text|new_text|program|prompt|body|context)$/.test(key)?{characters:String(item??'').length}:safeToolArguments(item,depth+1)]));
  return typeof value==='string'?clean(value).slice(0,600):value;
}
export function toolStepDetail({round,call,name,args,result}) {
  return {round,callId:call.id,tool:name,args:safeToolArguments(args),summary:clean(result?.summary||'').slice(0,240),...(result?.sessionId?{sessionId:result.sessionId}:{})};
}
export function appendToolHookContext(messages) {
  const last=messages.findLastIndex(message=>message.role==='assistant'&&message.tool_calls?.length);
  if(last<0)return;
  const replies=messages.slice(last+1).filter(message=>message.role==='tool');
  if(messages[last].tool_calls.some(call=>!replies.some(reply=>reply.tool_call_id===call.id)))return;
  const context=[...new Set(replies.map(reply=>reply._hookContext).filter(Boolean))];
  if(!context.length)return;
  for(const reply of replies)delete reply._hookContext;
  messages.push({role:'system',_contextKind:'injected',content:context.join('\n').slice(0,6000)});
}
/** Images remain request-local; a durable retry must explicitly read them again. */
export function checkpointMessages(messages) {
  return messages.map(message=>({...structuredClone(message),...(Array.isArray(message.content)?{content:message.content.map(part=>
    part.type==='image_url'?{type:'text',text:'[图片仅在当轮内存中；任务恢复后请重新调用图片读取工具，不能假定已观察到图片内容。]'}:structuredClone(part))}:{})}));
}
const receipt = result => ({text:'该调用已在上次尝试执行；没有重复执行。'+clean(result?.summary||'工具已返回。').slice(0,500),summary:clean(result?.summary||'已恢复执行记录').slice(0,500),
  isError:Boolean(result?.isError||result?.ok===false),evidence:[],...Object.fromEntries(['artifact','artifacts','plan','operation','backgroundTask'].filter(key=>result?.[key]!==undefined).map(key=>[key,result[key]]))});
/** Persist hashes and bounded receipts, never command output, source text or credentials. */
export async function executeRecoverable({name,args,call,ctx,attempt,execute,journal=workflowJournal}) {
  ctx.signal?.throwIfAborted();
  if(!effects.has(name))return execute();
  const key=journalKey(canonical({kind:'tool-execution',workspaceId:ctx.workspaceId,scope:ctx.scopedDocIds||null,name,args}));
  const previous=(await journal.read(ctx.userId,ctx.taskId)).filter(row=>row.kind==='tool-execution'&&row.key===key&&row.attempt<attempt);
  const last=previous.at(-1);
  if(last?.event==='result')return {...last.result,replayed:true};
  if(last?.event==='started')return {text:'上次尝试在操作开始后中断，结果尚未确认。为避免重复副作用，本次未重试；请先检查实际状态再发起明确的新操作。',summary:'上次操作结果待核对',isError:true,evidence:[],replayed:true};
  const identity={kind:'tool-execution',key,attempt,callId:call.id,round:ctx.executionRound};
  await journal.append(ctx.userId,ctx.taskId,{...identity,event:'started'});
  const result=await execute();
  await journal.append(ctx.userId,ctx.taskId,{...identity,event:'result',reusable:true,result:receipt(result)});
  return result;
}
export async function repairInterruptedTools(messages,{userId,taskId,round,journal=workflowJournal}) {
  const last=messages.findLastIndex(message=>message.role==='assistant'&&message.tool_calls?.length);
  if(last<0)return [];
  const answered=new Set(messages.slice(last+1).filter(message=>message.role==='tool').map(message=>message.tool_call_id));
  const unresolved=messages[last].tool_calls.filter(call=>!answered.has(call.id));
  if(!unresolved.length)return [];
  const records=await journal.read(userId,taskId),restored=[];
  for(const call of unresolved){
    const record=records.findLast(row=>row.kind==='tool-execution'&&row.callId===call.id&&row.round===round);
    const result=record?.event==='result'?record.result:{isError:true,text:record?.event==='started'?'上次尝试在操作中断开，状态未确认；未重复执行，请先核对实际结果。':'上一轮在调用执行前中断，未执行此项；如仍需要请重新提交。',evidence:[]};
    messages.push({role:'tool',tool_call_id:call.id,content:result.text,...(result.isError?{_toolError:true}:{})});
    restored.push({name:call.function.name,result});
  }
  return restored;
}
