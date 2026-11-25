import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runSubagent, runSubagentBatch, clearSubagentBudget } from '../src/server/subagent.mjs';
import { createWorkflowJournal } from '../src/server/workflow-journal.mjs';
const schema = name => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
const call = name => ({ id: name, type: 'function', function: { name, arguments: '{}' } });

test('subagents reject writes/delegation and preserve scope while bounding model calls', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-sub-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0; const invoked = [];
  const result = await runSubagent({ userId: 'alice', taskId: 'task1', goal: '核对引文', directory, maxCalls: 3,
    schemas: ['read_source','write_file','delegate_task','web_fetch'].map(schema), toolContext: { scopedDocIds: ['private'], preferences: { subject: 'logic' } },
    chat: async ({ tools, messages }) => { assert.deepEqual(tools.map(x => x.function.name), ['read_source']); calls++; return calls === 1 ? { toolCalls: [call('write_file'), call('delegate_task'), call('read_source'), call('web_fetch')] } : { content: '原文支持结论 [1]' }; },
    execute: async (name, args, ctx) => { invoked.push(name); assert.deepEqual(ctx.scopedDocIds, ['private']); assert.equal(ctx.approvalVerified, false); assert.equal(ctx.provider, null); return { text: '来源原文', evidence: [{ ref: '1', text: 'evidence' }] }; },
  });
  assert.equal(result.ok, true); assert.equal(result.llmCalls.sub, 2); assert.deepEqual(invoked, ['read_source']); assert.equal(result.evidence[0].ref, '1');
  assert.match(result.text, /不是指令/); assert.ok((await fs.readFile(result.transcriptPath, 'utf8')).includes('started'));
  const bad = await runSubagent({ userId: 'alice', taskId: 'task1', goal: 'x', depth: 2 }); assert.equal(bad.llmCalls.sub, 0);
  const missingOwner = await runSubagent({ taskId: 'task1', goal: 'x' }); assert.equal(missingOwner.ok, false); assert.equal(missingOwner.llmCalls.sub, 0);
});
test('batch reservation survives supplied checkpoint count and read-only retry uses journal', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-sub-journal-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = createWorkflowJournal({ directory }); let reserved = 0, calls = 0;
  const opts = { userId: 'alice', taskId: 'retrytask', directory, journal, tasks: [{ goal: 'read' }], chat: async () => { calls++; return { content: 'source verified' }; }, execute: async () => ({}), onReserve: n => { reserved = n; } };
  const first = await runSubagentBatch(opts); assert.equal(first.llmCalls.sub, 1); assert.equal(reserved, 1);
  clearSubagentBudget('alice', 'retrytask');
  const retry = await runSubagentBatch({ ...opts, usedCount: reserved, resumeFromRunId: 'retrytask' }); assert.equal(retry.llmCalls.sub, 0); assert.equal(calls, 1); assert.equal(reserved, 2);
  clearSubagentBudget('alice', 'retrytask');
  const denied = await runSubagentBatch({ ...opts, usedCount: 5 }); assert.equal(denied.llmCalls.sub, 0); assert.equal(calls, 1);
});
test('subagent truncated model calls never execute tools, and aborted tasks spend no calls', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-sub-limit-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let executed = false;
  const opts = { userId: 'alice', taskId: 'bounded', goal: 'verify', directory, schemas: [schema('read_source')], execute: async () => { executed = true; }, chat: async () => ({ content: 'partial', toolCalls: [call('read_source')], finishReason: 'length' }) };
  const result = await runSubagent(opts); assert.equal(result.budget_exhausted, true); assert.equal(executed, false);
  const c = new AbortController(); c.abort(); const stopped = await runSubagent({ ...opts, signal: c.signal }); assert.equal(stopped.llmCalls.sub, 0); assert.equal(stopped.ok, false);
});
test('subagent waits for durable call reservation and does not call the model when persistence fails', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-sub-account-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = []; const opts = { userId: 'alice', taskId: 'account', goal: 'verify', directory, execute: async () => ({}), onCall: async () => { await new Promise(resolve => setTimeout(resolve, 5)); events.push('durable'); }, chat: async () => { events.push('model'); return { content: 'done' }; } };
  assert.equal((await runSubagent(opts)).llmCalls.sub, 1); assert.deepEqual(events, ['durable','model']);
  events.length = 0; const failed = await runSubagent({ ...opts, onCall: async () => { throw new Error('storage failed'); } }); assert.equal(failed.ok, false); assert.equal(failed.llmCalls.sub, 0); assert.deepEqual(events, []);
});
test('cached delegation retains newly cited evidence even when the parent already has many sources', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-sub-evidence-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journal = createWorkflowJournal({ directory }); let calls = 0;
  const parent = new Map(Array.from({ length: 20 }, (_, i) => [String(i), { ref: String(i), content: 'parent source' }]));
  const options = { userId: 'alice', taskId: 'evidencetask', directory, journal, tasks: [{ goal: 'find new evidence' }], schemas: [schema('read_source')], toolContext: { evidence: parent },
    chat: async () => ++calls === 1 ? { toolCalls: [call('read_source')] } : { content: '新依据 [[new_ref]]' }, execute: async () => ({ text: 'new evidence', evidence: [{ ref: 'new_ref', content: 'cited source' }] }) };
  const result = await runSubagentBatch(options); assert.deepEqual(result.evidence.map(x => x.ref), ['new_ref']);
  const retry = await runSubagentBatch({ ...options, resumeFromRunId: 'evidencetask' }); assert.deepEqual(retry.evidence.map(x => x.ref), ['new_ref']); assert.equal(retry.llmCalls.sub, 0); assert.equal(calls, 2);
});

test('subagent web search is available only outside private scopes and controlled joint research',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-sub-web-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const toolContext of [{},{scopedDocIds:[]},{scopedDocIds:['doc']},{jointResearch:{enabled:true}}]){
    let calls=0,executed=0;const allowed=!toolContext.scopedDocIds&&!toolContext.jointResearch?.enabled;
    const result=await runSubagent({userId:'web-owner',taskId:'webtask',goal:'查阅公开标准',directory,schemas:[schema('web_search')],toolContext,
      chat:async({tools})=>{assert.equal(tools.some(tool=>tool.function.name==='web_search'),allowed);return ++calls===1?{toolCalls:[call('web_search')]}:{content:'按实际结果交回。'};},
      execute:async(name,args,ctx)=>{executed++;assert.equal(ctx.subagentDepth,1);assert.equal(ctx.approvalVerified,false);return {text:'来源',evidence:[]};}});
    assert.equal(result.ok,true);assert.equal(executed,allowed?1:0);
  }
});
