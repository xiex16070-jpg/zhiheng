import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readEvents} from '../evals/provider.mjs';

test('HTTP model autonomy, reviewable file approvals and project permission transitions',async t=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-autonomy-http-'));
  const requests=[];
  const call=(name,args)=>({tool_calls:[{index:0,id:'call-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const model=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);
    const prompt=body.messages.find(m=>m.role==='user')?.content||'',replies=body.messages.filter(m=>m.role==='tool');let delta;
    if(!body.tools?.length)delta={content:'预算内完成已有结果。'};
    else if(prompt.includes('DESKTOP_REQUEST')&&!replies.length)delta=call('desktop_open_url',{url:'https://www.bilibili.com/'});
    else if(prompt.includes('PARENT_CANCEL')&&!replies.length)delta=call('start_background_task',{goal:'CHILD_SLOW 独立整理',title:'待取消后台工作'});
    else if(prompt.includes('PARENT_CANCEL')&&replies.length===1)delta=call('cancel_background_task',{task_id:/"taskId":"([A-Za-z0-9_-]+)"/.exec(replies[0].content)[1]});
    else if(prompt.includes('PARENT_BACKGROUND')&&!replies.length)delta=call('start_background_task',{goal:'CHILD_WRITE 生成后台文件',title:'独立后台产物'});
    else if(prompt.includes('PARENT_BUDGET')&&replies.filter(m=>m.name==='start_background_task'||m.tool_call_id==='call-start_background_task').length<3)delta=call('start_background_task',{goal:'CHILD_EMPTY 独立总结',title:'预算验证'});
    else if(prompt.includes('CHILD_WRITE')&&!replies.length)delta=call('write_file',{path:'background/result.md',content:'# Background result\n真实落盘'});
    else if(prompt.includes('CHILD_EMPTY')&&!replies.length)delta=call('start_background_task',{goal:'ILLEGAL_RECURSION'});
    else if(prompt.includes('CHECK_BACKGROUND')&&!replies.length)delta=call('get_background_task',{});
    else if(prompt.includes('PATCH_EXISTING')&&!replies.length)delta=call('patch_file',{path:'existing.md',old_text:'Original',new_text:'Model replacement'});
    else if(prompt.includes('FILE_WRITE')&&!replies.length)delta=call('write_file',{path:'created.md',content:'# Approved output'});
    else if(prompt.includes('READ_ONLY_COMMAND')&&!replies.length)delta=call('run_command',{command:['node','-e','require("fs").writeFileSync("bypass.txt","bad")'],justification:'fixture'});
    else delta={content:'已按实际工具结果处理；后台状态可在任务列表查看。'};
    if(prompt.includes('CHILD_SLOW'))await new Promise(resolve=>setTimeout(resolve,1000));
    res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));await fs.writeFile(path.join(directory,'papers.jsonl'),'');
  const env={...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:directory,STORE_FILE:path.join(directory,'store.json'),KB_FILE:path.join(directory,'kb.json'),VECTOR_FILE:path.join(directory,'vector.json'),CORPUS_JSONL:path.join(directory,'papers.jsonl'),MYSQL_ENABLED:'false',REDIS_ENABLED:'false',QDRANT_URL:'',RAGFLOW_BASE_URL:'',EMBEDDING_PROVIDER:'off',LEARNING_ENABLED:'false',INFERENCE_AUDIT:'false',AUX_LLM_MAX_CALLS:'0',AUTH_SECRET:'autonomy-http-fixture',HTTP_PROXY:'',HTTPS_PROXY:'',NO_PROXY:'127.0.0.1,localhost,::1',WEB_SEARCH_KEY:'',WEB_SEARCH_PROVIDER:'',SCHOLAR_SEARCH:'false',EXEC_ENABLED:'1'};
  env.APPROVAL_TIMEOUT_MS='2500';
  // This protocol suite must never open a real desktop window, including when
  // an approval regression accidentally reaches the native dispatch boundary.
  const desktopSentinel=path.join(directory,'unexpected-desktop-launch');
  const nativeGuard=path.join(directory,'native-guard.mjs');
  await fs.writeFile(nativeGuard,`import cp from 'node:child_process';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=cp.execFile;cp.execFile=function(file,args,...rest){if(String(file).toLowerCase().endsWith('powershell.exe')&&args?.includes('-EncodedCommand')){fs.writeFileSync(${JSON.stringify(desktopSentinel)},'blocked');const callback=rest.findLast(x=>typeof x==='function');queueMicrotask(()=>callback(new Error('test_forbids_desktop_launch')));return {kill(){}};}return original.call(this,file,args,...rest);};syncBuiltinESMExports();`);
  env.NODE_OPTIONS=(env.NODE_OPTIONS||'')+' --import='+pathToFileURL(nativeGuard).href;
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs=(logs+b).slice(-5000));
  t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const ended=once(child,'exit');child.kill();await ended;}model.closeAllConnections();await new Promise(resolve=>model.close(resolve));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  let base;const deadline=Date.now()+20000;
  while(!base){if(child.exitCode!==null||Date.now()>deadline)throw new Error('Server failed: '+logs);try{const port=(await fs.readFile(path.join(directory,'.server-port'),'utf8')).trim();if((await(await fetch('http://127.0.0.1:'+port+'/api/health')).json()).ready)base='http://127.0.0.1:'+port;}catch{}if(!base)await new Promise(r=>setTimeout(r,30));}
  const bootstrap=await fetch(base+'/api/bootstrap'),cookie=bootstrap.headers.get('set-cookie').split(';')[0],uid=(await bootstrap.json()).user.id;
  const bob=(await fetch(base+'/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const provider={baseUrl:'http://127.0.0.1:'+model.address().port+'/v1',model:'autonomy-fixture',apiKey:''};
  const post=(url,body,extra={})=>fetch(base+url,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-settings-request':'1',...extra},body:JSON.stringify(body)});
  const get=(url,extra={})=>fetch(base+url,{headers:{cookie,...extra}}),chat=message=>post('/api/chat',{message,provider}).then(readEvents);
  const resume=approval=>post('/api/tasks/'+approval.taskId+'/resume',{provider,approvalId:approval.id}).then(readEvents);
  const mode=async selected=>{const policy=await(await get('/api/file-permissions')).json();const response=await post('/api/file-permissions',{...policy,mode:selected});assert.equal(response.status,200,await response.clone().text());};
  await t.test('default writes wait for exact owner approval and expose a stable diff; replay rejected',async()=>{
    assert.equal((await(await get('/api/file-permissions')).json()).mode,'ask');
    const events=await chat('FILE_WRITE 新建文件'),approval=events.find(e=>e.type==='approval_required')?.approval;
    const retrievalHint=requests.at(-1).messages.find(message=>String(message.content).includes('系统预检索到'))?.content;
    assert.equal(retrievalHint,undefined);assert.match(requests.at(-1).messages[0].content,/通用 Agent 模式/);
    assert.equal(approval?.action,'write_file');assert.equal(approval.fileReview.after,'# Approved output');
    assert.equal((await get('/api/workspace/file?path=created.md')).status,404);
    assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'},{cookie:bob})).status,404);
    const restored=await(await get('/api/approvals')).json();assert.equal(restored.approvals.find(a=>a.id===approval.id).fileReview.fingerprint,approval.fileReview.fingerprint);
    assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'})).status,200);
    const completed=await resume(approval);assert.ok(completed.some(e=>e.type==='tool_artifact'),JSON.stringify(completed));
    assert.equal(await fs.readFile(path.join(directory,'workspace',uid,'created.md'),'utf8'),'# Approved output');
    assert.equal((await post('/api/tasks/'+approval.taskId+'/resume',{provider,approvalId:approval.id})).status,409);
  });
  await t.test('external edit invalidates a previously approved patch without overwriting user content',async()=>{
    const filename=path.join(directory,'workspace',uid,'existing.md');await fs.writeFile(filename,'Original');
    const events=await chat('PATCH_EXISTING 修改文件'),approval=events.find(e=>e.type==='approval_required').approval;
    assert.equal(approval.fileReview.before,'Original');assert.equal(approval.fileReview.after,'Model replacement');
    await fs.writeFile(filename,'User edited during approval');
    await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'});
    const result=await resume(approval);assert.ok(result.some(e=>e.type==='error'&&/file_approval_content_changed/.test(e.message)),JSON.stringify(result));
    assert.equal(await fs.readFile(filename,'utf8'),'User edited during approval');
  });
  await t.test('trusted project performs writes; read-only blocks file and command bypass; no other user inherits grant',async()=>{
    await mode('trusted');const events=await chat('FILE_WRITE trusted project');assert.ok(events.some(e=>e.type==='tool_artifact'));assert.ok(!events.some(e=>e.type==='approval_required'));
    assert.equal((await(await get('/api/file-permissions',{cookie:bob})).json()).mode,'ask');
    await mode('read_only');for(const question of ['FILE_WRITE readonly','READ_ONLY_COMMAND bypass']){const denied=await chat(question);assert.ok(denied.some(e=>e.type==='tool'&&e.summary.includes('权限')));assert.ok(!denied.some(e=>e.type==='tool_artifact'||e.type==='approval_required'));}
    await assert.rejects(fs.stat(path.join(directory,'workspace',uid,'bypass.txt')),{code:'ENOENT'});await mode('ask');
  });
  await t.test('model starts a real independent background conversation, pauses for file approval, then delivers artifact',async()=>{
    const events=await chat('PARENT_BACKGROUND 需要独立的耗时工作'),done=events.find(e=>e.type==='done');assert.ok(done,JSON.stringify(events));
    const started=done.result.backgroundTasks[0];assert.ok(started.taskId);assert.notEqual(started.conversationId,events[0].conversationId);
    let task;for(let i=0;i<100;i++){task=(await(await get('/api/tasks/'+started.taskId)).json()).task;if(task.status==='awaiting_approval')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(task.status,'awaiting_approval');assert.equal(task.checkpoint.parentTaskId,done.taskId);assert.equal(task.checkpoint.backgroundDepth,1);
    const approval=(await(await get('/api/approvals')).json()).approvals.find(a=>a.taskId===started.taskId);assert.equal(approval.action,'write_file');
    assert.equal((await get('/api/workspace/file?path=background%2Fresult.md')).status,404);
    await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'});const resumed=await resume(approval);assert.ok(resumed.some(e=>e.type==='tool_artifact'),JSON.stringify(resumed));
    const record=(await(await get('/api/background')).json()).tasks.find(item=>item.taskId===started.taskId);assert.equal(record.status,'completed');
    assert.match(await fs.readFile(path.join(directory,'workspace',uid,'background','result.md'),'utf8'),/真实落盘/);
    const childRequests=requests.filter(r=>r.messages.find(m=>m.role==='user')?.content?.includes('CHILD_WRITE'));
    for(const request of childRequests)assert.ok(!request.tools?.some(tool=>['delegate_task','start_background_task'].includes(tool.function.name)));
    const status=await chat('CHECK_BACKGROUND 查看进度');assert.ok(status.some(e=>e.type==='tool'&&e.name==='get_background_task'));
  });
  await t.test('two-child budget survives tool iterations and recursive launch is rejected',async()=>{
    const result=await chat('PARENT_BUDGET 多个独立工作'),done=result.find(e=>e.type==='done');assert.ok(done,JSON.stringify(result));assert.equal(done.result.backgroundTasks.length,2);
    for(const record of done.result.backgroundTasks){let task;for(let i=0;i<100;i++){task=(await(await get('/api/tasks/'+record.taskId)).json()).task;if(['completed','failed'].includes(task.status))break;await new Promise(r=>setTimeout(r,20));}assert.equal(task.status,'completed');assert.ok(task.result.llmCalls.main<=5);assert.equal(task.result.backgroundTasks.length,0);}
    const pending=(await(await get('/api/background')).json()).tasks;assert.equal(pending.filter(task=>task.metadata.parentTaskId===done.taskId).length,2);
  });
  await t.test('model can cancel its running background work with consistent task and background status',async()=>{
    const events=await chat('PARENT_CANCEL 启动后取消'),done=events.find(event=>event.type==='done');
    assert.ok(done,JSON.stringify(events));assert.ok(events.some(event=>event.type==='tool'&&event.name==='cancel_background_task'));
    const started=done.result.backgroundTasks[0];let record;
    for(let i=0;i<100;i++){record=(await(await get('/api/background')).json()).tasks.find(item=>item.taskId===started.taskId);if(record?.status==='cancelled')break;await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(record?.status,'cancelled');
    const task=(await(await get('/api/tasks/'+started.taskId)).json()).task;
    assert.equal(task.status,'cancelled');
    assert.equal((await post('/api/tasks/'+task.id+'/resume',{provider})).status,409);
  });
  await t.test('desktop request respects platform, local identity, enablement and URL approval without opening',async()=>{
    const disabled=await chat('DESKTOP_REQUEST default disabled');
    assert.ok(!disabled.some(event=>event.type==='approval_required'));assert.ok(disabled.some(event=>event.type==='tool'&&event.name==='desktop_open_url'));
    assert.ok(!requests.at(-1).tools?.some(tool=>tool.function.name==='desktop_open_url'));
    const settings=await(await get('/api/runtime-settings')).json();
    const state=settings.settings||settings;
    assert.equal((await post('/api/runtime-settings',{...state,desktopEnabled:true})).status,200);
    try {
    const remote=await post('/api/chat',{message:'DESKTOP_REQUEST forged metadata',provider:{...provider,desktopAllowed:true},desktopAllowed:true},{origin:'https://remote.invalid','sec-fetch-site':'cross-site'});
    if(remote.ok) {
      const events=await readEvents(remote);assert.ok(!events.some(event=>event.type==='approval_required'));assert.ok(events.some(event=>event.type==='tool'&&event.name==='desktop_open_url'));
      assert.ok(!requests.at(-1).tools?.some(tool=>tool.function.name==='desktop_open_url'));
    } else assert.ok([400,403].includes(remote.status));
    const requestStart=requests.length;
    const events=await chat('DESKTOP_REQUEST 在本电脑打开网站'),approval=events.find(event=>event.type==='approval_required')?.approval;
    const platformRequests=requests.slice(requestStart);
    if(process.platform!=='win32') {
      assert.ok(platformRequests.length>0);
      assert.ok(platformRequests.every(request=>!request.tools?.some(tool=>tool.function.name==='desktop_open_url')));
      assert.equal(approval,undefined,'unsupported platforms must not offer desktop approval');
      assert.ok(events.some(event=>event.type==='tool'&&event.name==='desktop_open_url'&&event.summary.includes('未执行')),JSON.stringify(events));
      const done=events.find(event=>event.type==='done');assert.ok(done,JSON.stringify(events));
      assert.deepEqual(done.result.operationReceipts,[],'a fabricated tool call must never dispatch a browser');
      return;
    }
    assert.ok(platformRequests[0].tools.some(tool=>tool.function.name==='desktop_open_url'));
    assert.equal(approval?.action,'desktop_open_url',JSON.stringify(events));assert.deepEqual(approval.payload,{url:'https://www.bilibili.com/'});
    const before=requests.length;assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'rejected'})).status,200);
    const resumed=await resume(approval),done=resumed.find(event=>event.type==='done');assert.ok(done,JSON.stringify(resumed));
    assert.deepEqual(done.result.operationReceipts,[]);assert.match(requests.slice(before)[0].messages.find(message=>message.role==='tool').content,/拒绝/);
    } finally {
      const latest=await(await get('/api/runtime-settings')).json();assert.equal((await post('/api/runtime-settings',{...(latest.settings||latest),desktopEnabled:false})).status,200);
      await assert.rejects(fs.stat(desktopSentinel),{code:'ENOENT'},'the test must not reach the native desktop launcher');
    }
  });
  await t.test('expired background approvals retain delegation and call budgets on retry and update detached status',async()=>{
    const events=await chat('PARENT_BACKGROUND EXPIRE'),done=events.find(e=>e.type==='done'),started=done.result.backgroundTasks[0];
    let task;for(let i=0;i<100;i++){task=(await(await get('/api/tasks/'+started.taskId)).json()).task;if(task.status==='awaiting_approval')break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(task.status,'awaiting_approval');
    const checkpoint=structuredClone(task.checkpoint),approval=(await(await get('/api/approvals')).json()).approvals.find(a=>a.taskId===task.id);
    await new Promise(resolve=>setTimeout(resolve,2600));
    assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'})).status,410);
    const expired=(await(await get('/api/tasks/'+task.id)).json()).task;
    assert.equal(expired.status,'failed');assert.equal(expired.checkpoint.backgroundDepth,1);
    assert.equal(expired.checkpoint.parentTaskId,done.taskId);assert.deepEqual(expired.checkpoint.llmCalls,checkpoint.llmCalls);
    assert.deepEqual(expired.checkpoint.backgroundScope,checkpoint.backgroundScope);assert.deepEqual(expired.checkpoint.jointResearch,checkpoint.jointResearch);
    assert.equal(expired.checkpoint.pendingCall,undefined);assert.equal(expired.checkpoint.fileReview,undefined);
    assert.equal((await(await get('/api/background')).json()).tasks.find(item=>item.taskId===task.id).status,'failed');
    const retried=await post('/api/tasks/'+task.id+'/resume',{provider}).then(readEvents),fresh=retried.find(e=>e.type==='approval_required')?.approval;
    assert.equal(fresh?.action,'write_file',JSON.stringify(retried));assert.notEqual(fresh.id,approval.id);
    const current=(await(await get('/api/tasks/'+task.id)).json()).task;
    assert.equal(current.checkpoint.backgroundDepth,1);assert.equal(current.checkpoint.llmCalls.main,checkpoint.llmCalls.main+1);
    const latest=requests.filter(request=>request.messages.find(m=>m.role==='user')?.content?.includes('CHILD_WRITE')).at(-1);
    assert.ok(!latest.tools?.some(tool=>['delegate_task','start_background_task'].includes(tool.function.name)));
    await post('/api/approvals/'+fresh.id+'/decide',{decision:'rejected'});await resume(fresh);
  });
});
