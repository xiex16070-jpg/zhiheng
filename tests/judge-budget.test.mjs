import test from 'node:test';
import assert from 'node:assert/strict';
import {createJudgeBudget} from '../src/server/judge-budget.mjs';

test('independent judge budget is persisted before requests and survives task retry',async()=>{
  let saved;const state={},calls={main:5,aux:1,sub:2};
  const budget=createJudgeBudget({state,calls,persist:async()=>{saved=structuredClone({state,calls});}});
  assert.equal(await budget.reserve('support'),true);assert.equal(saved.calls.judge,1);assert.equal(saved.state.support.reserved,true);
  await budget.record('support',{llmCalls:1,usage:{prompt_tokens:50,completion_tokens:20,total_tokens:70}});
  assert.equal(budget.usage().support.usage.total_tokens,70);assert.equal(calls.main,5);
  const resumed=createJudgeBudget({state:structuredClone(saved.state),calls:structuredClone(saved.calls),persist:async()=>{}});
  assert.equal(await resumed.reserve('support'),false);assert.equal(await resumed.reserve('inference'),true);assert.equal(await resumed.reserve('inference'),false);
  assert.equal(resumed.usage().inference.uncertain,true);assert.equal(resumed.usage().inference.usage,null,'unknown usage is never zero');
});

test('failed judge budget persistence prevents an outgoing call',async()=>{
  let sent=0;const budget=createJudgeBudget({state:{},calls:{},persist:async()=>{throw new Error('disk unavailable');}});
  await assert.rejects(async()=>{if(await budget.reserve('support'))sent++;},/disk unavailable/);assert.equal(sent,0);
});
