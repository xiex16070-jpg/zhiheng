import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createWorkflowJournal} from '../src/server/workflow-journal.mjs';
import {executeRecoverable,repairInterruptedTools,safeToolArguments,appendToolHookContext,checkpointMessages} from '../src/server/execution-safety.mjs';
test('durable receipts prevent duplicate effects; uncertain interruptions never auto-retry',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-execution-journal-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const journal=createWorkflowJournal({directory}),ctx={userId:'alice',taskId:'task',workspaceId:'default',executionRound:1},call={id:'write',function:{name:'write_file',arguments:'{}'}};
  let writes=0;const request={name:'write_file',args:{path:'note.md',content:'PRIVATE_DOCUMENT_CONTENT'},call,ctx,journal};
  await executeRecoverable({...request,attempt:1,execute:async()=>{writes++;return {text:'PRIVATE_TOOL_OUTPUT',summary:'写入 note.md',artifact:{path:'note.md',action:'write'}};}});
  const recovered=await executeRecoverable({...request,attempt:2,execute:async()=>{writes++;}});
  assert.equal(writes,1);assert.equal(recovered.replayed,true);assert.match(recovered.text,/上次尝试执行/);
  assert.ok(!JSON.stringify(await journal.read('alice','task')).includes('PRIVATE_'));
  const messages=[{role:'assistant',tool_calls:[call]}];
  await repairInterruptedTools(messages,{userId:'alice',taskId:'task',round:1,journal});assert.equal(messages[1].tool_call_id,'write');assert.match(messages[1].content,/上次尝试执行/);
  const interrupted={...request,args:{path:'other.md',content:'once'},call:{...call,id:'interrupted'}};
  await assert.rejects(executeRecoverable({...interrupted,attempt:1,execute:async()=>{throw new Error('crash after side effect');}}));
  const uncertain=await executeRecoverable({...interrupted,attempt:2,execute:async()=>{writes++;}});
  assert.equal(uncertain.isError,true);assert.match(uncertain.text,/尚未确认/);assert.equal(writes,1);
  const later=[{role:'assistant',tool_calls:[call]}];await repairInterruptedTools(later,{userId:'alice',taskId:'task',round:2,journal});assert.match(later[1].content,/执行前中断/,'reused provider call IDs cannot replay receipts from another round');
});
test('timeline arguments exclude document bodies and recognizable credentials',()=>{
  const data=safeToolArguments({path:'report.md',content:'PRIVATE_BODY',apiKey:'PRIVATE_KEY',nested:{authorization:'Bearer abc',url:'https://example.org/?token=PRIVATE_TOKEN'}});
  assert.equal(data.content.characters,12);assert.ok(!JSON.stringify(data).includes('PRIVATE_'));
});

test('hook guidance waits for every result and durable snapshots never retain native image bytes',()=>{
  const replies=[{role:'assistant',tool_calls:[{id:'a'},{id:'b'}]}, {role:'tool',tool_call_id:'a',content:'{"ok":false}',_hookContext:'tool failed'}];
  appendToolHookContext(replies);assert.equal(replies.length,2);assert.deepEqual(JSON.parse(replies[1].content),{ok:false});
  replies.push({role:'tool',tool_call_id:'b',content:'done'});appendToolHookContext(replies);assert.equal(replies.at(-1).role,'system');assert.equal(replies.at(-1).content,'tool failed');
  appendToolHookContext(replies);assert.equal(replies.length,4,'context delivered only once');
  const image={role:'user',content:[{type:'text',text:'read image'},{type:'image_url',image_url:{url:'data:image/png;base64,PRIVATE_PIXELS'}}]};
  const saved=checkpointMessages([...replies,image]);assert.ok(!JSON.stringify(saved).includes('PRIVATE_PIXELS'));assert.match(saved.at(-1).content[1].text,/重新调用/);assert.match(image.content[1].image_url.url,/PRIVATE_PIXELS/);
});
