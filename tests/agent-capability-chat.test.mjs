import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readEvents } from '../evals/provider.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('真实 HTTP 编排：子代理证据/预算、延迟工具审批、视觉 parts、后台生命周期和服务令牌边界',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zh-capability-chat-')), seen=[];
  let imageRequests=0;
  let resourceRevision=0, resourceLists=0, resourceReads=0;
  const tool=(name,args,id)=>({tool_calls:[{index:0,id:id||name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const model=http.createServer(async(req,res)=>{
    if(req.url==='/mcp'){
      const mcp=new Server({name:'resource-chat-fixture',version:'1.0'},{capabilities:{resources:{}}});
      mcp.setRequestHandler(ListResourcesRequestSchema,async()=>{resourceLists++;return{resources:[{uri:'research://paper/logic',name:'Formal Logic',mimeType:'text/plain'}]};});
      mcp.setRequestHandler(ReadResourceRequestSchema,async({params})=>{resourceReads++;return{contents:[{uri:params.uri,mimeType:'text/plain',text:'Source text: modus ponens preserves truth.'}]};});
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
      res.on('close',()=>{transport.close().catch(()=>{});mcp.close().catch(()=>{});});
      await mcp.connect(transport);await transport.handleRequest(req,res);return;
    }
    const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    if(req.url.endsWith('/images/generations')){imageRequests++;res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({data:[{b64_json:PNG}]}));}
    seen.push(body);
    const messages=body.messages||[], text=messages.filter(m=>m.role==='user'&&typeof m.content==='string').map(m=>m.content).join('\n');
    const replies=messages.filter(m=>m.role==='tool'), sub=messages.some(m=>m.role==='system'&&String(m.content).includes('你是只读研究子代理'));
    let delta={content:'任务已完成。'},finish='stop';
    if(sub){delta=replies.length?{content:'Banach contraction evidence is in the retrieved paper [[2]].'}:tool('search_knowledge',{query:'Banach contraction fixed point',source:'paper',top_k:1});}
    else if(text.includes('CAP_DELEGATE')){delta=replies.length?{content:'子代理查阅的文献讨论 Banach contraction fixed point [[2]]。'}:tool('delegate_task',{tasks:[{goal:'查阅 Banach contraction fixed point 的本地文献并给出 ref',context:'只检索知识库，交回准确来源。'}]});}
    else if(text.includes('CAP_IMAGE')){delta=!replies.length?tool('tool_describe',{name:'generate_image'}):replies.length===1?tool('tool_call',{name:'generate_image',arguments:{prompt:'A simple research diagram',path:'generated/figure.png'}},'image-call'):{content:'图像生成流程已结束。'};}
    else if(text.includes('CAP_VISION')||text.includes('CAP_NOVISION')){delta=!replies.length?tool('tool_describe',{name:'view_image'}):replies.length===1?tool('tool_call',{name:'view_image',arguments:{path:'input.png'}},'view-call'):{content:'已完成图片能力检查。'};}
    else if(text.includes('CAP_APPROVAL')){delta=replies.length?{content:'已收到结果。'}:tool('ask_user',{question:'选择研究方向',options:['逻辑','验证'],recommended:0});}
    else if(text.includes('CAP_RESOURCE')){
      const catalog=replies.map(m=>{try{return JSON.parse(m.content);}catch{return null;}}).find(r=>r?.catalog&&r?.resources);
      delta=!replies.length?tool('tool_describe',{name:'extension_resources'}):replies.length===1?tool('tool_call',{name:'extension_resources',arguments:{extension:'library',revision:resourceRevision,kind:'resources'}})
        :replies.length===2&&catalog?tool('tool_describe',{name:'read_extension_resource'})
          :replies.length===3&&catalog?tool('tool_call',{name:'read_extension_resource',arguments:{extension:'library',revision:resourceRevision,catalog:catalog.catalog,uri:catalog.resources[0].uri}})
            :{content:'资源读取流程已结束；未把插件文本冒充已核验文献。'};
    }
    else if(text.includes('CAP_WAIT')){await new Promise(resolve=>{const timer=setTimeout(resolve,10000);res.on('close',()=>{clearTimeout(timer);resolve();});});if(res.destroyed)return;}
    if(delta.tool_calls)finish='tool_calls';res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(r=>model.listen(0,'127.0.0.1',r));
  await fs.writeFile(path.join(dir,'papers.jsonl'),[{id:1,title:'Formal logic',abstract:'Formal logic studies valid reasoning.',discipline:'计算机'},
    {id:2,title:'Banach contraction fixed point',abstract:'Banach contraction fixed point theorem: a contraction map on a complete metric space has a unique fixed point.',discipline:'计算机'}].map(JSON.stringify).join('\n')+'\n');
  const serviceToken='fixture-service-token-0123456789';
  const env={...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir,STORE_FILE:path.join(dir,'store.json'),KB_FILE:path.join(dir,'kb.json'),VECTOR_FILE:path.join(dir,'vec.json'),CORPUS_JSONL:path.join(dir,'papers.jsonl'),MYSQL_ENABLED:'false',REDIS_ENABLED:'false',QDRANT_URL:'',RAGFLOW_BASE_URL:'',EMBEDDING_PROVIDER:'off',RERANK_ENABLED:'false',MINERU_ENABLED:'false',LEARNING_ENABLED:'false',INFERENCE_AUDIT:'false',AUX_LLM_MAX_CALLS:'0',AUTH_SECRET:'capability-contract-test',HTTP_PROXY:'',HTTPS_PROXY:'',NO_PROXY:'127.0.0.1,localhost,::1',WEB_SEARCH_KEY:'',WEB_SEARCH_PROVIDER:'',SCHOLAR_SEARCH:'false',SERVICE_TOKENS:serviceToken+':servicefixture',MAX_TOOL_ROUNDS:'8'};
  const child=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';for(const stream of[child.stdout,child.stderr])stream.on('data',c=>{logs=(logs+c).slice(-5000);});
  t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const done=once(child,'exit');child.kill();await done;}model.closeAllConnections();await new Promise(r=>model.close(r));assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});});
  let base='';const deadline=Date.now()+20000;
  while(!base){if(child.exitCode!==null||Date.now()>deadline)throw new Error('Server failed: '+logs);try{const p=(await fs.readFile(path.join(dir,'.server-port'),'utf8')).trim();if((await(await fetch('http://127.0.0.1:'+p+'/api/health')).json()).ready)base='http://127.0.0.1:'+p;}catch{}if(!base)await new Promise(r=>setTimeout(r,30));}
  const bootstrap=await fetch(base+'/api/bootstrap'),cookie=bootstrap.headers.get('set-cookie').split(';')[0],uid=(await bootstrap.json()).user.id;
  const bob=(await fetch(base+'/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const provider={baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'capability-contract',apiKey:''};
  const post=(url,body,headers={})=>fetch(base+url,{method:'POST',headers:{cookie,origin:base,'x-settings-request':'1','content-type':'application/json',...headers},body:JSON.stringify(body)});
  const get=(url,headers={})=>fetch(base+url,{headers:{cookie,...headers}});
  const chat=async(message,p=provider,extra={})=>readEvents(await post('/api/chat',{message,provider:p,...extra}));
  await t.test('子代理实际检索证据回传父任务，调用次数单独记账',async()=>{
    const events=await chat('CAP_DELEGATE 独立核验');const done=events.find(e=>e.type==='done');assert.ok(done,JSON.stringify(events));
    assert.equal(done.result.llmCalls.sub,2);assert.ok(done.result.llmCalls.main>=2);
    assert.ok(done.result.citations.some(c=>String(c.ref)==='2'),JSON.stringify(done.result));
    assert.ok(events.some(e=>e.type==='subagent'&&e.status==='completed'));
  });
  await t.test('tool_describe→tool_call 不能绕过图像外发审批，批准后才请求服务',async()=>{
    const saved=await post('/api/settings/models',{baseUrl:provider.baseUrl,model:'fixture-image',capability:'image',enabled:true,apiKey:'synthetic-image-capability-key',revision:0});assert.equal(saved.status,200,await saved.clone().text());
    const events=await chat('CAP_IMAGE 绘制图像');const approval=events.find(e=>e.type==='approval_required')?.approval;assert.equal(approval?.action,'generate_image',JSON.stringify(events));assert.equal(imageRequests,0);
    assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'},{cookie:bob})).status,404);
    assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'})).status,200);
    const resumed=await readEvents(await post('/api/tasks/'+approval.taskId+'/resume',{provider,approvalId:approval.id}));assert.ok(resumed.some(e=>e.type==='done'),JSON.stringify(resumed));assert.equal(imageRequests,1);
    const bytes=await fs.readFile(path.join(dir,'workspace',uid,'generated','figure.png'));assert.equal(bytes.subarray(1,4).toString(),'PNG');
  });
  await t.test('工作区图像以原生 content parts 到达视觉模型，非视觉模型不注册或发送图片',async()=>{
    await fs.mkdir(path.join(dir,'workspace',uid),{recursive:true});await fs.writeFile(path.join(dir,'workspace',uid,'input.png'),Buffer.from(PNG,'base64'));
    const before=seen.length,events=await chat('CAP_VISION 查看工作区图片',{...provider,vision:true});assert.ok(events.some(e=>e.type==='done'),JSON.stringify(events));
    const requests=seen.slice(before),parts=requests.flatMap(r=>r.messages||[]).filter(m=>Array.isArray(m.content));assert.ok(parts.some(m=>m.content.some(p=>p.type==='image_url'&&p.image_url.url.startsWith('data:image/png;base64,'))));
    assert.ok(!JSON.stringify(requests).includes('[object Object]'));
    const start=seen.length;await chat('CAP_NOVISION 不能看图',provider);
    assert.ok(seen.slice(start).every(r=>!(r.tools||[]).some(s=>s.function.name==='view_image')));
    assert.ok(seen.slice(start).every(r=>!(r.messages||[]).some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'))));
    const store=await fs.readFile(path.join(dir,'store.json'),'utf8');assert.ok(!store.includes(PNG),'raw image must not enter persisted task/trace');
  });
  await t.test('MCP资源目录与正文分别审批，配置变化使旧审批失效且不访问服务',async()=>{
    const response=await post('/api/settings/extensions',{id:'library',name:'Logic Library',kind:'http',url:`http://127.0.0.1:${model.address().port}/mcp`,enabled:true,resourcesEnabled:true,revision:0});
    assert.equal(response.status,200,await response.clone().text());const state=await response.json();resourceRevision=state.entries[0].revision;
    let events=await chat('CAP_RESOURCE 读取已连接的逻辑资源');
    const listing=events.find(e=>e.type==='approval_required')?.approval;assert.equal(listing?.action,'extension_resources',JSON.stringify(events));
    assert.equal(resourceLists,0);assert.equal(resourceReads,0);
    assert.equal((await post('/api/approvals/'+listing.id+'/decide',{decision:'approved'})).status,200);
    events=await readEvents(await post('/api/tasks/'+listing.taskId+'/resume',{provider,approvalId:listing.id}));
    const reading=events.find(e=>e.type==='approval_required')?.approval;assert.equal(reading?.action,'read_extension_resource',JSON.stringify(events));
    assert.equal(resourceLists,1);assert.equal(resourceReads,0);
    assert.equal((await post('/api/approvals/'+reading.id+'/decide',{decision:'approved'})).status,200);
    events=await readEvents(await post('/api/tasks/'+reading.taskId+'/resume',{provider,approvalId:reading.id}));
    assert.ok(events.some(e=>e.type==='done'),JSON.stringify(events));assert.equal(resourceReads,1);
    assert.ok(seen.at(-1).messages.some(m=>m.role==='tool'&&m.content.includes('modus ponens')));
    events=await chat('CAP_RESOURCE 配置更新边界');const stale=events.find(e=>e.type==='approval_required')?.approval;assert.equal(stale?.action,'extension_resources');
    const disabled=await post('/api/settings/extensions',{id:'library',resourcesEnabled:false,revision:state.revision});assert.equal(disabled.status,200,await disabled.clone().text());
    assert.equal((await post('/api/approvals/'+stale.id+'/decide',{decision:'approved'})).status,200);
    events=await readEvents(await post('/api/tasks/'+stale.taskId+'/resume',{provider,approvalId:stale.id}));
    assert.ok(events.some(e=>e.type==='done'),JSON.stringify(events));assert.equal(resourceLists,1);assert.equal(resourceReads,1);
    assert.ok(seen.at(-1).messages.some(m=>m.role==='tool'&&/配置.*(?:变更|变化|改变)|extension_changed/.test(m.content)),JSON.stringify(seen.at(-1).messages.filter(m=>m.role==='tool')));
    assert.equal((await post('/api/tasks/'+stale.taskId+'/resume',{provider,approvalId:stale.id})).status,409);
  });
  await t.test('更改图像目的地/模型/密钥后旧审批作废，恢复不触发模型或图像请求',async()=>{
    const events=await chat('CAP_IMAGE 审批目标变更检查');
    const approval=events.find(e=>e.type==='approval_required')?.approval;assert.equal(approval?.action,'generate_image',JSON.stringify(events));
    assert.ok(approval.reason.includes('127.0.0.1:'));assert.ok(approval.reason.includes('fixture-image'));
    const storedBefore=JSON.parse(await fs.readFile(path.join(dir,'store.json'),'utf8'));
    const checkpoint=storedBefore.tasks[approval.taskId].checkpoint;
    assert.match(checkpoint.imageApprovalHash,/^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(checkpoint).includes('synthetic-image-capability-key'));
    assert.equal((await post('/api/approvals/'+approval.id+'/decide',{decision:'approved'})).status,200);
    const settings=await(await get('/api/settings/models')).json();
    const changed=await post('/api/settings/models',{baseUrl:provider.baseUrl.replace('/v1','/v2'),model:'other-image',capability:'image',enabled:true,apiKey:'synthetic-new-image-key',revision:settings.revision});assert.equal(changed.status,200);
    const beforeImages=imageRequests,beforeModelCalls=seen.length;
    const resumed=await post('/api/tasks/'+approval.taskId+'/resume',{provider,approvalId:approval.id});
    assert.equal(resumed.status,409,await resumed.clone().text());assert.equal((await resumed.json()).error,'image_approval_target_changed');
    assert.equal(imageRequests,beforeImages);assert.equal(seen.length,beforeModelCalls);
    const stored=JSON.parse(await fs.readFile(path.join(dir,'store.json'),'utf8'));
    assert.equal(stored.approvals[approval.id].status,'consumed');assert.equal(stored.tasks[approval.taskId].status,'failed');
    assert.ok(!JSON.stringify(stored).includes('synthetic-new-image-key'));
    const replay=await post('/api/tasks/'+approval.taskId+'/resume',{provider,approvalId:approval.id});assert.equal(replay.status,409);assert.equal(imageRequests,beforeImages);
  });
  await t.test('后台 202、完成、审批暂停、用户隔离、取消和服务令牌最小路由',async()=>{
    async function waitTask(id,status){const until=Date.now()+8000;while(Date.now()<until){const rows=(await(await get('/api/background')).json()).tasks,row=rows.find(r=>r.taskId===id);if(row?.status===status)return row;await new Promise(r=>setTimeout(r,30));}throw new Error('Background status did not reach '+status);}
    const accepted=await post('/api/chat',{message:'CAP_DONE 后台完成',provider,background:true});assert.equal(accepted.status,202);const job=await accepted.json();await waitTask(job.taskId,'completed');
    const pause=await(await post('/api/chat',{message:'CAP_APPROVAL 后台提问',provider,background:true})).json();await waitTask(pause.taskId,'awaiting_approval');
    assert.equal((await(await get('/api/background',{cookie:bob})).json()).tasks.length,0);
    const pending=await(await post('/api/chat',{message:'CAP_WAIT 等待取消',provider,background:true})).json();
    assert.equal((await post('/api/background/'+pending.taskId+'/cancel',{}, {cookie:bob})).status,404);
    assert.equal((await post('/api/background/'+pending.taskId+'/cancel',{})).status,200);await waitTask(pending.taskId,'cancelled');
    for(const url of['/api/settings/models','/api/background','/api/learn/effectiveness'])assert.equal((await fetch(base+url,{headers:{authorization:'Bearer '+serviceToken}})).status,401);
    const service=await fetch(base+'/api/chat',{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:JSON.stringify({message:'CAP_DONE scheduled fixture',provider,background:true})});assert.equal(service.status,202,await service.clone().text());
    assert.equal((await fetch(base+'/api/preferences',{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:'{"preferences":{"followups":false}}'})).status,401);
    assert.ok(!(await fs.readFile(path.join(dir,'store.json'),'utf8')).includes('synthetic-image-capability-key'));
  });
});
