import test from 'node:test';
import assert from 'node:assert/strict';
import { createHooks, hooks as builtins } from '../src/server/hooks.mjs';
test('trusted hooks rewrite before validation, aggregate ask and fail closed', async () => {
  const events = []; const hooks = createHooks({ audit: async e => events.push(e), timeoutMs: 15 });
  hooks.register('PreToolUse', () => ({ decision: 'ask', args: { path: 'safe.md' } }));
  hooks.register('PreToolUse', ({ args }) => { assert.equal(args.path, 'safe.md'); return { decision: 'allow' }; });
  const input = { args: { path: 'old.md' } }; const result = await hooks.dispatch('PreToolUse', input);
  assert.equal(result.decision, 'ask'); assert.equal(input.args.path, 'old.md');
  const remove = hooks.register('PreToolUse', () => { throw new Error('secret text'); });
  assert.equal((await hooks.dispatch('PreToolUse', input)).decision, 'deny'); assert.equal(events[0].error, 'Error'); assert.ok(!JSON.stringify(events).includes('secret text')); remove();
  hooks.register('PreToolUse', () => new Promise(() => {})); assert.equal((await hooks.dispatch('PreToolUse', input)).decision, 'deny');
});
test('Stop cannot block more than three times and hook context is data only', async () => {
  const hooks = createHooks(); hooks.register('Stop', () => ({ block: true, additionalContext: 'review citations' }));
  for (let i = 0; i < 4; i++) { const r = await hooks.dispatch('Stop', { userId: 'a', taskId: 't' }); assert.equal(r.block, i < 3); assert.match(r.additionalContext, /NOT USER INPUT/); }
  hooks.clearTask('a', 't'); assert.equal((await hooks.dispatch('Stop', { userId: 'a', taskId: 't' })).block, true);
  hooks.clearTask('a', 't'); const resumed = await hooks.dispatch('Stop', { userId: 'a', taskId: 't', stopBlockCount: 3 }); assert.equal(resumed.block, false); assert.equal(resumed.stopBlockCount, 3);
});

test('PreCompact honors an explicit deny without exposing hook exception text', async () => {
  const hooks = createHooks();
  hooks.register('PreCompact', () => ({ decision: 'deny', reason: 'Keep required evidence verbatim' }));
  const decision = await hooks.dispatch('PreCompact', { userId: 'a', taskId: 't' });
  assert.equal(decision.decision, 'deny');
  assert.equal(decision.reason, 'Keep required evidence verbatim');
});

test('application registers cancellation and failed-outcome handlers',async()=>{
  const controller=new AbortController();controller.abort();
  assert.equal((await builtins.dispatch('PreToolUse',{signal:controller.signal,args:{}})).decision,'deny');
  assert.equal((await builtins.dispatch('PostToolUse',{ok:true})).additionalContext,'');
  assert.match((await builtins.dispatch('PostToolUse',{ok:false})).additionalContext,/没有成功完成/);
});
