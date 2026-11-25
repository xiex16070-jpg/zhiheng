import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, isConfigured, isLocalQwenProvider, loadProvider, restoreProvider } from '../src/ui/settings.js';

const local = { baseUrl:'http://127.0.0.1:8018/v1', model:'qwen3-8b-base', preset:'zhiheng-local', profileId:'local-qwen', profileSha:'a'.repeat(64), adapterSha:null };
function browserFixture(t, vault, migrate) {
  const previousWindow=globalThis.window, previousStorage=globalThis.localStorage, values=new Map(),calls=[];
  globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,String(value))};
  globalThis.window={apiFetch:async(url,options={})=>{
    calls.push({url,method:options.method||'GET',body:options.body?JSON.parse(options.body):null});
    return {ok:true,json:async()=>options.method==='POST'?migrate(calls.at(-1).body):structuredClone(vault)};
  }};
  t.after(()=>{if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;
    if(previousStorage===undefined)delete globalThis.localStorage;else globalThis.localStorage=previousStorage;});
  return {values,calls};
}
test('local preset defaults to base with explicit protocol; cloud default remains unchanged',t=>{
  assert.equal(PRESETS.find(p=>p.id==='zhiheng-local').model,'qwen3-8b-base');
  assert.equal(PRESETS.find(p=>p.id==='zhiheng-local').profileId,'local-qwen');
  browserFixture(t,{profiles:[]});assert.equal(loadProvider().model,'deepseek-chat');assert.equal(loadProvider().preset,'deepseek');
  assert.equal(isConfigured({...local,profileSha:''}),false);assert.equal(isConfigured(local),true);
  assert.equal(isLocalQwenProvider({...local,baseUrl:'https://remote.example/v1'}),false);
});
test('restore keeps saved exact local model and binding instead of stale browser model',async t=>{
  const saved={...local,model:'qwen3-8b-zhiheng-explicit-adapter',adapterSha:'b'.repeat(64)};
  const fixture=browserFixture(t,{revision:3,profiles:[saved],active:saved});
  const result=await restoreProvider({...local,model:'qwen3-8b-base'});
  assert.deepEqual(result,saved);assert.deepEqual(loadProvider(),saved);assert.equal(fixture.calls.length,1);assert.equal(fixture.calls[0].method,'GET');
});
test('old local model and credential cannot silently overwrite a saved base connection on restore',async t=>{
  const fixture=browserFixture(t,{revision:3,profiles:[local],active:local},()=>assert.fail('restore must not rewrite an explicitly saved local connection'));
  const result=await restoreProvider({...local,model:'qwen3-8b-zhiheng',apiKey:'synthetic-legacy-key'});
  assert.deepEqual(result,local);assert.equal(fixture.calls.length,1);assert.ok(!JSON.stringify(loadProvider()).includes('synthetic-legacy-key'));
});
test('restore preserves cloud model override and ordinary credential migration behavior',async t=>{
  const cloud={baseUrl:'https://api.example.com/v1',model:'saved-cloud-model',preset:'custom',savedKeyId:'fixture-key-id',profileId:''};
  const fixture=browserFixture(t,{revision:4,profiles:[cloud],active:cloud},body=>({active:{...cloud,model:body.model},profiles:[cloud]}));
  assert.equal((await restoreProvider({...cloud,model:'selected-cloud-model'})).model,'selected-cloud-model');
  const migrated=await restoreProvider({...cloud,model:'selected-cloud-model',apiKey:'synthetic-migration-key'});
  assert.equal(migrated.model,'selected-cloud-model');assert.equal(fixture.calls.at(-1).method,'POST');
  assert.deepEqual(fixture.calls.at(-1).body,{baseUrl:cloud.baseUrl,model:'selected-cloud-model',preset:'custom',apiKey:'synthetic-migration-key',revision:4});
});
