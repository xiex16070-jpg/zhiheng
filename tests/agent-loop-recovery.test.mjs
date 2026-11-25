import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-loop-recovery-'));
const requests = [];
const scripted = [];
let child, model, baseUrl, cookie;
let upstreamFailure=false;

// Each scripted reply is one streamed chunk: { delta, finish }.
model = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  requests.push(body);
  const next = scripted.shift() || { delta: { content: '完成。' }, finish: 'stop' };
  if(upstreamFailure||next.status===500){upstreamFailure=true;res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture upstream unavailable'}}));return;}
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: next.delta, finish_reason: next.finish }] })}\n\n`);
  res.end('data: [DONE]\n\n');
});

test.before(async () => {
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: temp, STORE_FILE: path.join(temp, 'store.json'), KB_FILE: path.join(temp, 'kb.json'),
    VECTOR_FILE: path.join(temp, 'vectors.json'), MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', EMBEDDING_PROVIDER: 'local',
    EMBEDDING_BASE_URL: '', RAGFLOW_BASE_URL: '', AUTH_SECRET: 'loop-recovery-contract', LEARNING_ENABLED: 'false', EXEC_ENABLED: 'false',
    INFERENCE_AUDIT: 'false', RERANK_ENABLED: 'false', MINERU_ENABLED: 'false', MCP_SDK_ENABLED: 'false', SUGGEST_MODE: 'rules',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '127.0.0.1,localhost,::1',
  } });
  let logs = ''; child.stdout.on('data', (d) => { logs = (logs + d).slice(-4000); }); child.stderr.on('data', (d) => { logs = (logs + d).slice(-4000); });
  const deadline = Date.now() + 20000;
  while (true) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Server startup failed: ${logs}`);
    try {
      const port = Number((await fs.readFile(path.join(temp, '.server-port'), 'utf8')).trim());
      if (port > 0) { baseUrl = `http://127.0.0.1:${port}`; if ((await (await fetch(baseUrl + '/api/health')).json()).ready) break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  cookie = (await fetch(baseUrl + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
});

test.after(async () => {
  if (child && child.exitCode === null) { child.kill(); await new Promise((resolve) => child.once('exit', resolve)); }
  await new Promise((resolve) => model.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
});

async function chat(message) {
  const res = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    message, provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'loop-contract', apiKey: 'test-key' },
  }) });
  const events = (await res.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)));
  return { status: res.status, events, done: events.find((e) => e.type === 'done') };
}

test('a length-cut answer is continued instead of failing the task', async () => {
  requests.length = 0;
  scripted.push({ delta: { content: '第一段，' }, finish: 'length' }, { delta: { content: '第二段。' }, finish: 'stop' });
  const { done, events } = await chat('写一段较长的说明');
  assert.ok(done, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(done.result.body, '第一段，第二段。');
  assert.ok(events.some((e) => e.type === 'step' && e.name === 'length_recovery'));
  assert.match(requests[1].messages.at(-1).content, /接着写/);
  // Core agent tools are offered directly, not behind tool_search.
  const offered = requests[0].tools.map((t) => t.function.name);
  for (const name of ['write_file', 'read_file', 'update_plan']) assert.ok(offered.includes(name), name);
});

test('a length-cut tool call is never executed and the model is told to append in chunks', async () => {
  requests.length = 0;
  scripted.push(
    { delta: { tool_calls: [{ index: 0, id: 'cut', type: 'function', function: { name: 'write_file', arguments: '{"path":"long.md","content":"开头' } }] }, finish: 'length' },
    { delta: { content: '内容过长，已改为分段写入计划。' }, finish: 'stop' });
  const { done } = await chat('把长报告写到 long.md');
  assert.ok(done);
  assert.match(requests[1].messages.at(-1).content, /append=true/);
  assert.equal((await fetch(baseUrl + '/api/workspace/file?path=long.md', { headers: { cookie } })).status, 404);
});

test('messages over the limit are rejected with 413 instead of silently truncated', async () => {
  const res = await fetch(baseUrl + '/api/chat', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({
    message: '长'.repeat(20001), provider: { baseUrl: `http://127.0.0.1:${model.address().port}/v1`, model: 'loop-contract', apiKey: 'test-key' },
  }) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'message_too_long');
});

test('finished tasks leave a training trajectory; a correction exports as a preference pair', async () => {
  requests.length = 0;
  scripted.push({ delta: { content: '模型的原始回答。' }, finish: 'stop' });
  const { done } = await chat('解释一下合取');
  const userId = (await (await fetch(baseUrl + '/api/bootstrap', { headers: { cookie } })).json()).user.id;
  const file = path.join(temp, 'trajectories', userId, done.taskId + '.json');
  let saved = null;
  for (let i = 0; i < 50 && !saved; i++) { saved = await fs.readFile(file, 'utf8').then(JSON.parse, () => null); if (!saved) await new Promise((r) => setTimeout(r, 20)); }
  assert.ok(saved, 'trajectory written');
  assert.equal(saved.outcome.status, 'completed');
  assert.equal(saved.messages[0].role, 'system');
  assert.equal(saved.messages.at(-1).content, '模型的原始回答。');
  assert.ok(saved.prompt.toolNames.includes('write_file'));
  assert.ok(!JSON.stringify(saved).includes('test-key'), 'provider credentials are never recorded');

  const feedback = (body) => fetch(`${baseUrl}/api/tasks/${done.taskId}/feedback`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await feedback({ rating: 'sideways' })).status, 400);
  assert.equal((await feedback({ rating: 'down', reasons: ['incomplete'], correction: '更完整的正确回答。' })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/tasks/${done.taskId}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"rating":"up"}' })).status, 401);

  const out = path.join(temp, 'dpo.jsonl');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['scripts/export-trajectories.mjs', '--format', 'dpo', '--out', out], { cwd: ROOT, env: { ...process.env, DATA_DIR: temp } });
  const rows = (await fs.readFile(out, 'utf8')).trim().split('\n').map(JSON.parse);
  const pair = rows.find((row) => row.meta.taskId === done.taskId);
  assert.equal(pair.chosen, '更完整的正确回答。');
  assert.equal(pair.rejected, '模型的原始回答。');
});

const fixtureCall=(name,args,id)=>({id,index:0,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function postJson(route,body){return fetch(baseUrl+route,{method:'POST',headers:{cookie,origin:baseUrl,'x-settings-request':'1','content-type':'application/json'},body:JSON.stringify(body)});}
const provider=()=>({baseUrl:`http://127.0.0.1:${model.address().port}/v1`,model:'loop-contract',apiKey:'test-key'});
const eventsOf=async response=>(await response.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));

test('update_plan persists to the owned task before an approval pause and survives resume',async()=>{
  const items=[{content:'收集材料',status:'completed'},{content:'写出文件',status:'in_progress'}];
  scripted.push({delta:{tool_calls:[fixtureCall('update_plan',{items},'persisted-plan'),{...fixtureCall('write_file',{path:'planned.md',content:'planned'},'planned-write'),index:1}]},finish:'tool_calls'});
  const paused=await chat('记录计划并保存结果。'),approval=paused.events.find(event=>event.type==='approval_required')?.approval;
  assert.equal(approval?.action,'write_file');
  const record=(await(await fetch(baseUrl+'/api/tasks/'+approval.taskId,{headers:{cookie}})).json()).task;
  assert.deepEqual(record.checkpoint.plan,items);
  const persisted=JSON.parse(await fs.readFile(path.join(temp,'store.json'),'utf8'));assert.deepEqual(persisted.tasks[approval.taskId].checkpoint.plan,items);
  await postJson('/api/approvals/'+approval.id+'/decide',{decision:'approved'});
  const resumed=await eventsOf(await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id}));
  assert.deepEqual(resumed.find(event=>event.type==='done').result.plan,items);
});
test('three file writes share one review card, read-only calls still execute, and results preserve all call pairs',async()=>{
  requests.length=0;
  const calls=[1,2,3].map(n=>fixtureCall('write_file',{path:`batch/${n}.md`,content:'# approved '+n},'batch-'+n));
  calls.push(fixtureCall('current_time',{},'clock-after-writes'));calls.forEach((c,i)=>c.index=i);
  scripted.push({delta:{tool_calls:calls},finish:'tool_calls'});
  const paused=await chat('生成三个独立文件，并读取当前时间。'),approval=paused.events.find(e=>e.type==='approval_required')?.approval;
  assert.equal(approval?.action,'tool_batch',JSON.stringify(paused.events));assert.equal(approval.payload.calls.length,3);
  assert.ok(paused.events.some(e=>e.type==='tool'&&e.name==='current_time'));
  const decisions=Object.fromEntries(approval.payload.calls.map(c=>[c.id,'approved']));
  assert.equal((await postJson('/api/approvals/'+approval.id+'/decide',{decision:'approved',decisions})).status,200);
  const resumed=await eventsOf(await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id}));
  const done=resumed.find(e=>e.type==='done');assert.ok(done,JSON.stringify(resumed));assert.equal(done.result.artifacts.length,3);
  const toolReplies=requests.at(-1).messages.filter(m=>m.role==='tool');assert.equal(toolReplies.length,4);assert.equal(new Set(toolReplies.map(m=>m.tool_call_id)).size,4);
  for(let n=1;n<=3;n++){const response=await fetch(baseUrl+'/api/workspace/file?path='+encodeURIComponent(`batch/${n}.md`),{headers:{cookie}});assert.equal(response.status,200);}
});
test('batch decisions reject unselected items and cannot be replayed',async()=>{
  scripted.push({delta:{tool_calls:[fixtureCall('write_file',{path:'selected.md',content:'yes'},'yes'),{...fixtureCall('write_file',{path:'unselected.md',content:'no'},'no'),index:1}]},finish:'tool_calls'});
  const paused=await chat('生成两个文件用于部分确认。'),approval=paused.events.find(e=>e.type==='approval_required').approval;
  assert.equal((await postJson('/api/approvals/'+approval.id+'/decide',{decision:'approved',decisions:{yes:'approved'}})).status,200);
  const resumed=await eventsOf(await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id}));
  assert.equal(resumed.find(e=>e.type==='done').result.artifacts.length,1);
  assert.equal((await fetch(baseUrl+'/api/workspace/file?path=unselected.md',{headers:{cookie}})).status,404);
  assert.equal((await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id})).status,409);
});
test('fifth-round upstream failure resumes from durable tool results without appending a file twice',async()=>{
  const permission=await(await fetch(baseUrl+'/api/file-permissions',{headers:{cookie}})).json();
  assert.equal((await postJson('/api/file-permissions',{...permission,mode:'trusted'})).status,200);
  requests.length=0;
  scripted.push({delta:{tool_calls:[fixtureCall('write_file',{path:'resume.txt',content:'ONCE\n',append:true},'once')]},finish:'tool_calls'});
  for(let n=2;n<=4;n++)scripted.push({delta:{tool_calls:[fixtureCall('current_time',{},'clock-'+n)]},finish:'tool_calls'});
  scripted.push({status:500});
  const failed=await chat('完成多轮状态核对并保存一次记录。');
  const error=failed.events.find(e=>e.type==='error');assert.ok(error,JSON.stringify(failed));
  const taskId=error.taskId||failed.events.find(e=>e.type==='conversation').taskId;
  const task=(await(await fetch(baseUrl+'/api/tasks/'+taskId,{headers:{cookie}})).json()).task;
  assert.equal(task.status,'failed');assert.equal(task.checkpoint.messages.filter(m=>m.role==='tool').length,4);
  assert.equal(task.checkpoint.llmCalls.main,5);assert.ok(task.checkpoint.messages.some(m=>m.tool_call_id==='once'));
  upstreamFailure=false;scripted.length=0;scripted.push({delta:{content:'已完成已有写入，并沿检查点继续。'},finish:'stop'});
  const resumed=await eventsOf(await postJson('/api/tasks/'+taskId+'/resume',{provider:provider()}));assert.ok(resumed.some(e=>e.type==='done'),JSON.stringify(resumed));
  const user=(await(await fetch(baseUrl+'/api/bootstrap',{headers:{cookie}})).json()).user.id;
  assert.equal(await fs.readFile(path.join(temp,'workspace',user,'resume.txt'),'utf8'),'ONCE\n');
  assert.equal(requests.filter(r=>!r.messages.some(m=>m.tool_call_id==='once')).length,1,'resume must not replay intake or first write');
});

test('20 deterministic rule fixtures complete propose, confirm, execute and explain with four-valued labels',async()=>{
  const labels=['true','false','both','unknown'];
  for(let index=0;index<20;index++){
    const expected=labels[index%4],subject='样本'+index;
    const program=[...(['true','both'].includes(expected)?[`事实 满足(${subject})。`]:[]),...(['false','both'].includes(expected)?[`事实 非 合格(${subject})。`]:[]),
      `事实 存在(${subject})。`,'规则 条件：若 满足(?对象) 则 合格(?对象)。',`查询 合格(${subject})。`].join('\n');
    scripted.push({delta:{tool_calls:[fixtureCall('propose_logic_program',{program,mode:'assumptions',explanation:'按给定事实判断，不自动补充逆命题。'},'proposal-'+index)]},finish:'tool_calls'});
    const paused=await chat(`若样本满足条件则合格，依据给定规则能否推出样本${index}合格？`),approval=paused.events.find(e=>e.type==='approval_required')?.approval;
    assert.equal(approval?.action,'propose_logic_program',JSON.stringify(paused.events));
    assert.ok(!paused.events.some(e=>e.type==='logic_result'),'no execution before human confirmation');
    assert.ok(requests.at(-1).tools.some(tool=>tool.function.name==='propose_logic_program'));
    assert.equal((await postJson('/api/approvals/'+approval.id+'/decide',{decision:'approved'})).status,200);
    scripted.push({delta:{content:'已按确认前提验算，结论只相对于该程序成立。'},finish:'stop'});
    const resumed=await eventsOf(await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id}));
    const done=resumed.find(e=>e.type==='done');assert.ok(done,JSON.stringify(resumed));
    assert.equal(done.result.logicResults[0].queries[0].status,expected);assert.equal(done.result.logicRouting.state,'completed');
  }
});
test('user edits the proposed program before execution, while refusal blocks another proposal',async()=>{
  const original='事实 满足(甲)。\n规则 条件：若 满足(?对象) 则 合格(?对象)。\n查询 合格(甲)。';
  scripted.push({delta:{tool_calls:[fixtureCall('propose_logic_program',{program:original,mode:'assumptions'},'editable')]},finish:'tool_calls'});
  let paused=await chat('若满足则合格，是否能推出甲合格？'),approval=paused.events.find(e=>e.type==='approval_required').approval;
  const edited=original.replace('事实 满足(甲)。','事实 非 合格(甲)。');
  assert.equal((await postJson('/api/approvals/'+approval.id+'/decide',{decision:'approved',program:edited})).status,200);
  let resumed=await eventsOf(await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id}));
  assert.equal(resumed.find(e=>e.type==='done').result.logicResults[0].queries[0].status,'false');
  scripted.push({delta:{tool_calls:[fixtureCall('propose_logic_program',{program:original,mode:'assumptions'},'reject')]},finish:'tool_calls'});
  paused=await chat('若满足则合格，能否推出甲合格？');approval=paused.events.find(e=>e.type==='approval_required').approval;
  await postJson('/api/approvals/'+approval.id+'/decide',{decision:'rejected'});
  scripted.push({delta:{tool_calls:[fixtureCall('propose_logic_program',{program:original,mode:'assumptions'},'retry-rejected')]},finish:'tool_calls'});
  resumed=await eventsOf(await postJson('/api/tasks/'+approval.taskId+'/resume',{provider:provider(),approvalId:approval.id}));
  assert.ok(!resumed.some(e=>e.type==='approval_required'||e.type==='logic_result'));assert.equal(resumed.find(e=>e.type==='done').result.logicRouting.state,'rejected');
});
