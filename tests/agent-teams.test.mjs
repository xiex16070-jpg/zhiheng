import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAgentTeams } from '../src/server/agent-teams.mjs';
import { createAgentCliRegistry, cliArguments, parseCliResult, runCliProcess } from '../src/server/agent-cli.mjs';

const member = (id, extra={}) => ({id,name:id,role:'独立证据核验',instructions:'指出不确定性',type:'current',enabled:true,maxCalls:3,...extra});
const input = (members, revision=0, extra={}) => ({revision,enabled:true,parallelism:2,timeoutSeconds:30,members,...extra});
async function temporary(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'zh-team-test-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});});return dir; }

test('user-owned team credentials persist encrypted, preserve blank keys, reject stale updates and unsafe endpoints', async t=>{
  const directory=await temporary(t), teams=createAgentTeams({directory});
  assert.equal((await teams.read('alice')).enabled,false);
  const secret='sensitive-key-fixture';
  let saved=await teams.save('alice',input([member('reviewer',{type:'api',baseUrl:'https://93.184.216.34/v1',model:'alpha',apiKey:secret})]));
  assert.equal(saved.members[0].hasKey,true);assert.ok(!JSON.stringify(saved).includes(secret));
  const stored=await fs.readFile(path.join(directory,'alice','team.json'),'utf8');assert.ok(!stored.includes(secret));assert.match(stored,/sealedKey/);
  assert.equal((await teams.read('bob')).revision,0);
  saved=await teams.save('alice',input([member('reviewer',{type:'api',baseUrl:'https://93.184.216.34/v1',model:'beta',apiKey:''})],saved.revision));
  assert.equal(saved.members[0].hasKey,true);
  await assert.rejects(teams.save('alice',input([member('reviewer')],0)),{code:'team_conflict'});
  await assert.rejects(teams.save('alice',input([member('reviewer',{type:'api',baseUrl:'http://169.254.169.254/v1',model:'bad'})],saved.revision)),{code:'team_endpoint_blocked'});
  await assert.rejects(teams.save('alice',input([member('reviewer',{type:'cli',cli:'custom',command:'powershell'})],saved.revision)),{code:'team_invalid'});
  await fs.writeFile(path.join(directory,'alice','team.json'),'{broken');
  await assert.rejects(teams.read('alice'),{code:'team_unreadable'});await assert.rejects(teams.save('alice',input([member('reviewer')])),{code:'team_unreadable'});
  assert.equal(await fs.readFile(path.join(directory,'alice','team.json'),'utf8'),'{broken');
});

test('two real HTTP models receive independent roles, own keys, readonly tools and durable parent budget callbacks', async t=>{
  const directory=await temporary(t), requests=[];let active=0, peak=0;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));requests.push({body,key:req.headers.authorization});active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,20));active--;
    const used=body.messages.some(message=>message.role==='tool');
    const delta=used?{content:body.model+' reviewed without file writes'}:{tool_calls:[{index:0,id:'bad-write',type:'function',function:{name:'write_file',arguments:'{"path":"denied.md","content":"bad"}'}}]};
    res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:used?'stop':'tool_calls'}],usage:{prompt_tokens:7,completion_tokens:3}})+'\n\ndata: [DONE]\n\n');
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const teams=createAgentTeams({directory}),baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  await teams.save('owner',input([member('researcher',{type:'api',baseUrl,model:'alpha',apiKey:'key-alpha'}),member('reviewer',{type:'api',baseUrl,model:'beta',apiKey:'key-beta',role:'反例审阅'})],0,{parallelism:1}));
  let reserved=0,calls=0,writes=0;const journalRows=[];
  const result=await teams.delegate({userId:'owner',taskId:'team-parent',workspaceId:'default',tasks:[{goal:'独立研究',member_id:'researcher'},{goal:'寻找反例',member_id:'reviewer'}],toolContext:{evidence:new Map()},
    schemas:[{type:'function',function:{name:'write_file',parameters:{type:'object'}}}],directory:path.join(directory,'subagents'),
    onReserve:async count=>{reserved=count;},onCall:async()=>{assert.equal(reserved,2);calls++;},execute:async()=>{writes++;},
    journal:{append:async(...args)=>journalRows.push(args),cached:async()=>null}});
  assert.equal(result.results.length,2);assert.ok(result.results.every(item=>item.ok));assert.equal(result.llmCalls.sub,4);assert.equal(calls,4);assert.equal(writes,0);assert.equal(peak,1);
  assert.deepEqual(new Set(requests.map(row=>row.body.model)),new Set(['alpha','beta']));
  for(const request of requests){assert.equal(request.key,'Bearer key-'+request.body.model);assert.ok(!request.body.tools?.some(tool=>tool.function.name==='write_file'));}
  assert.ok(!JSON.stringify(journalRows).includes('key-alpha'));assert.ok(!JSON.stringify(journalRows).includes('key-beta'));
  const record=await teams.getRun('owner',result.teamRunId);assert.equal(record.taskId,'team-parent');assert.equal(record.workspaceId,'default');assert.equal(record.status,'completed');assert.equal(record.members[1].role,'反例审阅');
  assert.match(record.members[0].text,/alpha reviewed/);assert.deepEqual(record.members[0].usage,{inputTokens:14,outputTokens:6,reportedCalls:2});assert.ok(!(await teams.runs('owner'))[0].members[0].text);
  await assert.rejects(teams.getRun('other',result.teamRunId),{code:'team_run_missing'});
  const blocked=await teams.delegate({userId:'owner',taskId:'team-parent',workspaceId:'default',usedCount:5,tasks:[{goal:'over budget'}],toolContext:{},onReserve:async()=>assert.fail('budget reset')});
  assert.match(blocked.text,/预算已耗尽/);assert.equal(requests.length,4);
});

test('CLI discovery distinguishes install from safe adapter; process arguments never include bypass flags or project cwd', async t=>{
  const directory=await temporary(t), executable=path.join(directory,'fixture.exe');await fs.writeFile(executable,'fixture');
  const invocations=[];
  const registry=createAgentCliRegistry({findCandidates:id=>id==='deepseek'?[]:[executable],run:async(command,args,options)=>{
    invocations.push({command,args,options});
    if(args.includes('--help'))return {code:0,stdout:args[0]==='exec'?'--sandbox --ignore-user-config --ignore-rules --ephemeral --json':'--safe-mode --tools --strict-mcp-config --no-session-persistence --output-format'};
    return {code:0,stdout:JSON.stringify({type:'result',result:'TEAM_CONNECTION_OK',usage:{input_tokens:4,output_tokens:2}})};
  }});
  const discovered=await registry.discover();assert.equal(discovered.find(item=>item.id==='claude').ready,true);assert.equal(discovered.find(item=>item.id==='hermes').ready,false);assert.equal(discovered.find(item=>item.id==='hermes').installed,true);assert.equal(discovered.find(item=>item.id==='deepseek').installed,false);
  const prompt='$(touch BAD) `payload` ; & quotes';const result=await registry.execute('claude',{prompt,model:'sonnet'});assert.equal(result.text,'TEAM_CONNECTION_OK');
  const launched=invocations.at(-1);assert.equal(launched.options.input,prompt);assert.ok(!launched.args.some(arg=>arg.includes(prompt)));assert.equal(path.dirname(launched.options.cwd),os.tmpdir());assert.equal(launched.options.env.AUTH_SECRET,undefined);
  assert.equal(launched.args[launched.args.indexOf('--tools')+1],'');assert.ok(launched.args.includes('--safe-mode'));assert.ok(!launched.args.some(arg=>/dangerously|bypassPermissions|yolo/.test(arg)));
  const codex=cliArguments('codex');assert.equal(codex[codex.indexOf('--sandbox')+1],'read-only');assert.ok(codex.includes('--ignore-user-config'));assert.ok(codex.includes('shell_tool'));
  await assert.rejects(registry.execute('hermes',{prompt}),{code:'cli_adapter_unavailable'});
  assert.throws(()=>cliArguments('codex','--bad'),{code:'cli_model_invalid'});
  assert.equal(parseCliResult('codex','{"type":"item.completed","item":{"type":"agent_message","text":"verified"}}\n{"type":"turn.completed","usage":{"input_tokens":1}}').text,'verified');
  assert.throws(()=>parseCliResult('codex','{"type":"turn.failed"}'),{code:'cli_run_failed'});
  await fs.appendFile(executable,' changed');
  await assert.rejects(registry.execute('claude',{prompt}),{code:'cli_changed'});
});

test('real subprocess receives literal stdin and respects cancellation and output budgets', async t=>{
  const directory=await temporary(t), payload='$(whoami) `x` & ; 中文';
  const echoed=await runCliProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],{input:payload,cwd:directory});assert.equal(echoed.stdout,payload);assert.equal(echoed.code,0);
  await assert.rejects(runCliProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:directory,timeoutMs:40}),{code:'cli_timeout'});
  const controller=new AbortController();const pending=runCliProcess(process.execPath,['-e','setInterval(()=>{},1000)'],{cwd:directory,signal:controller.signal});setTimeout(()=>controller.abort(),40);await assert.rejects(pending,{code:'cli_cancelled'});
  await assert.rejects(runCliProcess(process.execPath,['-e','process.stdout.write("x".repeat(2000))'],{cwd:directory,maxBytes:1000}),{code:'cli_output_limit'});
});

test('fixed connection tests are traceable, redact upstream failures, and CLI budget is one process invocation', async t=>{
  const directory=await temporary(t);let actualPrompt;
  const clis={discover:async()=>[{id:'claude',ready:true}],execute:async(_id,options)=>{actualPrompt=options.prompt;return {text:'TEAM_CONNECTION_OK'};}};
  const teams=createAgentTeams({directory,clis});await teams.save('owner',input([member('reviewer',{type:'cli',cli:'claude',maxCalls:6})]));
  assert.equal((await teams.read('owner')).members[0].maxCalls,1);
  const probe=await teams.testMember('owner','reviewer');assert.equal(probe.ok,true);assert.match(actualPrompt,/TEAM_CONNECTION_OK/);
  const record=await teams.getRun('owner',probe.runId);assert.equal(record.kind,'connection_test');assert.equal(record.members[0].calls,1);assert.equal(record.status,'completed');
  const cancelled=createAgentTeams({directory,clis:{...clis,execute:async()=>{throw new Error('SECRET raw backend error');}}});
  const result=await cancelled.testMember('owner','reviewer');assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(!JSON.stringify(await cancelled.getRun('owner',result.runId)).includes('SECRET'));
});
