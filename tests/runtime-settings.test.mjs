import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-runtime-review-'));
process.env.DATA_DIR=directory;process.env.EXEC_ENABLED='0';delete process.env.LATEX_ENGINE_PATH;
const {getRuntimeSettings,saveRuntimeSettings}=await import('../src/server/runtime-settings.mjs');
after(()=>fs.rm(directory,{recursive:true,force:true}));

test('runtime grants persist per user without mutating global defaults; stale revisions cannot overwrite',async()=>{
  const initial=getRuntimeSettings('alice');assert.equal(initial.desktopEnabled,false);assert.equal(initial.execEnabled,false);
  const saved=await saveRuntimeSettings('alice',{...initial,execEnabled:true,desktopEnabled:true,sessionEnabled:true,contextBudget:8000,compactRatio:.7,keepTail:12,microKeepRecent:3});
  assert.equal(saved.revision,1);assert.deepEqual(getRuntimeSettings('alice'),saved);assert.equal(getRuntimeSettings('bob').execEnabled,false);assert.equal(getRuntimeSettings().execEnabled,false);
  await assert.rejects(saveRuntimeSettings('alice',{...initial,execEnabled:false}),/conflict/);
  for(const patch of [{contextBudget:2047},{contextBudget:1048577},{contextBudget:4096.5},{compactRatio:.95},{keepTail:3},{microKeepRecent:0},{desktopEnabled:'true'},{unexpected:'value'},{latexEnginePath:'relative/tectonic.exe'}])await assert.rejects(saveRuntimeSettings('alice',{...saved,...patch}));
  assert.deepEqual(getRuntimeSettings('alice'),saved);
  await assert.rejects(saveRuntimeSettings('../bob',saved));
});
test('malformed or incomplete runtime files fail closed and remain preserved',async()=>{
  await fs.mkdir(path.join(directory,'runtime-settings'),{recursive:true});
  for(const [index,content] of ['{invalid','null','[]','{}','{"revision":1,"execEnabled":true}'].entries()) {
    const uid='corrupt'+index,filename=path.join(directory,'runtime-settings',uid+'.json');await fs.writeFile(filename,content);
    assert.throws(()=>getRuntimeSettings(uid),/unreadable/);
    await assert.rejects(saveRuntimeSettings(uid,{...getRuntimeSettings(),revision:0,execEnabled:true}),/unreadable/);
    assert.equal(await fs.readFile(filename,'utf8'),content);
  }
});
