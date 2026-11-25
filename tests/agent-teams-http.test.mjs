import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {readEvents} from '../evals/provider.mjs';

test('HTTP and browser: configure a private model team, delegate through the real orchestrator, inspect actual runs',async t=>{
  const root=fileURLToPath(new URL('..',import.meta.url)),directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-team-http-'));
  const requests=[];
  const model=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests.push(body);let delta;
    if(body.messages.some(message=>String(message.content).includes('Reply only TEAM_CONNECTION_OK')))delta={content:'TEAM_CONNECTION_OK'};
    else if(body.model==='lead-fixture'&&!body.messages.some(message=>message.role==='tool'))delta={tool_calls:[{index:0,id:'team-call',type:'function',function:{name:'delegate_task',arguments:JSON.stringify({tasks:[{goal:'独立查证',member_id:'researcher'},{goal:'反例核验',member_id:'reviewer'}]})}}]};
    else delta={content:body.model==='lead-fixture'?'团队已返回独立核查结果。':body.model+' 的独立核查：证据不足处保持不确定。'};
    res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
  });await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));await fs.writeFile(path.join(directory,'papers.jsonl'),'');
  const env={...process.env};
  try{for(const line of(await fs.readFile(path.join(root,'.env'),'utf8')).split(/\r?\n/)){if(!line.trim().startsWith('#')&&/^[A-Za-z_][A-Za-z0-9_]*=/.test(line.trim()))env[line.split('=')[0].trim()]='';}}catch{}
  Object.assign(env,{PORT:'0',HOST:'127.0.0.1',DATA_DIR:directory,STORE_FILE:path.join(directory,'store.json'),KB_FILE:path.join(directory,'kb.json'),VECTOR_FILE:path.join(directory,'vector.json'),CORPUS_JSONL:path.join(directory,'papers.jsonl'),MYSQL_ENABLED:'0',REDIS_ENABLED:'0',EMBEDDING_PROVIDER:'off',LEARNING_ENABLED:'0',INFERENCE_AUDIT:'0',AUX_LLM_MAX_CALLS:'0',AUTH_SECRET:'team-http-fixture',HTTP_PROXY:'',HTTPS_PROXY:'',NO_PROXY:'127.0.0.1,localhost,::1'});
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let logs='';for(const stream of[child.stdout,child.stderr])stream.on('data',chunk=>logs=(logs+chunk).slice(-4000));
  t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const stopped=once(child,'exit');child.kill();await stopped;}model.closeAllConnections();await new Promise(resolve=>model.close(resolve));assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  let base;const deadline=Date.now()+20000;
  while(!base){if(child.exitCode!==null||Date.now()>deadline)throw new Error('Server failed: '+logs);try{const port=(await fs.readFile(path.join(directory,'.server-port'),'utf8')).trim();if((await(await fetch('http://127.0.0.1:'+port+'/api/health')).json()).ready)base='http://127.0.0.1:'+port;}catch{}if(!base)await new Promise(resolve=>setTimeout(resolve,30));}
  const first=await fetch(base+'/api/bootstrap'),cookie=first.headers.get('set-cookie').split(';')[0],uid=(await first.json()).user.id;
  const stranger=(await fetch(base+'/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const get=(url,extra={})=>fetch(base+url,{headers:{cookie,...extra}});
  const post=(url,body,extra={})=>fetch(base+url,{method:'POST',headers:{cookie,origin:base,'content-type':'application/json','x-settings-request':'1',...extra},body:JSON.stringify(body)});
  const baseUrl='http://127.0.0.1:'+model.address().port+'/v1',provider={baseUrl,model:'lead-fixture',apiKey:''};let team,runId;
  await t.test('configuration enforces local signed owner, revision and credential privacy',async()=>{
    const initial=await get('/api/agent-teams');assert.equal(initial.status,200);const data=await initial.json();assert.equal(data.team.enabled,false);assert.ok(data.clis.every(cli=>!cli.executable&&!cli.identity));
    assert.equal((await get('/api/agent-teams',{'x-forwarded-for':'203.0.113.4'})).status,403);
    const draft={revision:data.team.revision,enabled:true,parallelism:2,timeoutSeconds:30,members:data.team.members.map((member,index)=>({id:member.id,name:member.name,role:member.role,instructions:member.instructions,enabled:true,type:'api',maxCalls:2,baseUrl,model:index?'review-fixture':'evidence-fixture',apiKey:'secret-member-'+index}))};
    assert.equal((await post('/api/agent-teams',draft,{origin:'https://foreign.invalid'})).status,403);
    const saved=await post('/api/agent-teams',draft);assert.equal(saved.status,200);team=(await saved.json()).team;assert.ok(!JSON.stringify(team).includes('secret-member'));
    assert.equal((await post('/api/agent-teams',draft)).status,409);
    assert.equal((await(await get('/api/agent-teams',{cookie:stranger})).json()).team.enabled,false);
    assert.ok(!(await fs.readFile(path.join(directory,'agent-teams',uid,'team.json'),'utf8')).includes('secret-member'));
  });
  await t.test('model can delegate by configured role, preserving separate calls and trace records',async()=>{
    const events=await readEvents(await post('/api/chat',{message:'分别委派查证与反例核验',provider}));const done=events.find(event=>event.type==='done');assert.ok(done,JSON.stringify(events));assert.equal(done.result.llmCalls.sub,2);
    assert.ok(requests.some(request=>request.model==='evidence-fixture'));assert.ok(requests.some(request=>request.model==='review-fixture'));
    const lead=requests.find(request=>request.model==='lead-fixture');assert.ok(lead.messages.some(message=>String(message.content).includes('researcher（研究员）')));
    const runs=(await(await get('/api/agent-teams/runs')).json()).runs;assert.equal(runs.length,1);assert.equal(runs[0].status,'completed');assert.equal(runs[0].taskId,done.taskId);runId=runs[0].id;
    assert.equal((await get('/api/agent-teams/runs/'+runId,{cookie:stranger})).status,404);
    const record=(await(await get('/api/agent-teams/runs/'+runId)).json()).run;assert.match(record.members[0].text,/独立核查/);assert.ok(!JSON.stringify(record).includes('secret-member'));
    const probe=await post('/api/agent-teams/test',{memberId:'reviewer'});assert.equal(probe.status,200);assert.equal((await probe.json()).ok,true);
    const stored=JSON.parse(await fs.readFile(path.join(directory,'store.json'),'utf8'));
    const settingsAudit=stored.audit.find(entry=>entry.action==='agent_team.settings_saved');
    assert.deepEqual(settingsAudit.detail,{revision:1,memberCount:2,enabled:true});
    const testAudit=stored.audit.find(entry=>entry.action==='agent_team.connection_test');
    assert.equal(testAudit.detail.outcome,'passed');assert.match(testAudit.detail.runId,/^team-/);
    assert.deepEqual(Object.keys(testAudit.detail).sort(),['outcome','runId']);
    assert.ok(!JSON.stringify([settingsAudit,testAudit]).includes('secret-member'));
  });
  await t.test('real browser edits cards, saves and tests; mobile layout has no native selects or overflow',async()=>{
    const {launchAgentChromium}=await import('../src/server/browser-runtime.mjs'),browser=await launchAgentChromium();t.after(()=>browser.close());const context=await browser.newContext();await context.addCookies([{name:'uid',value:cookie.slice(4),url:base}]);const page=await context.newPage();
    await page.route(base+'/team-fixture',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles/studio.css"><link rel="stylesheet" href="/src/styles/agent-teams.css"><style>body{margin:0;background:var(--paper);font-family:var(--sans)}main{max-width:980px;margin:auto;padding:10px}button{cursor:pointer;color:inherit}.btn{padding:8px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface)}</style><main id="teams"></main><script type="module">import {mountAgentTeams} from '/src/ui/agent-teams.js';mountAgentTeams(document.querySelector('#teams'),{getProvider:()=>(${JSON.stringify(provider)})});</script>`}));
    const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
    await page.goto(base+'/team-fixture');try{await page.locator('[data-team-member="researcher"]').waitFor({timeout:6000});}catch(error){throw new Error(JSON.stringify({pageErrors,body:await page.locator('body').innerText()})+' '+error.message);}assert.equal(await page.locator('select').count(),0);
    await page.locator('[data-field="name"]').fill('证据研究员');await page.locator('[data-team-save]').click();await page.getByText('团队配置已保存。启用后，模型可按任务需要委派角色。',{exact:true}).waitFor();
    assert.equal(await page.locator('[data-team-toggle]').isEnabled(),true);assert.match(await page.locator('[data-team-member="researcher"]').innerText(),/证据研究员/);
    await page.locator('[data-team-test]').click();await page.getByText('连接与最小推理测试通过。',{exact:true}).waitFor();
    await page.locator(`details[data-run="${runId}"] summary`).click();await page.locator(`details[data-run="${runId}"] pre`).first().waitFor();
    for(const width of[1200,768,390]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'overflow at '+width);}
  });
});
