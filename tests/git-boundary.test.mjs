import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The default workspace lives under DATA_DIR. Put DATA_DIR inside a git
// repository, as it is in a source checkout of this application.
const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'zh-git-boundary-'));
let gitAvailable = true;
try { execFileSync('git', ['init', '-q', outer], { stdio: 'ignore' }); } catch { gitAvailable = false; }
const dataDir = path.join(outer, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.EXEC_ENABLED = '1';

const exec = await import('../src/server/exec.mjs');
const ws = await import('../src/server/workspace.mjs');
after(() => fs.rmSync(outer, { recursive: true, force: true }));

test('file tools refuse .git paths so executable git config cannot be planted', async () => {
  for (const bad of ['.git/config', '.GIT/hooks/pre-commit', 'sub/.git/config']) {
    assert.equal((await ws.writeFile('alice', bad, '[core]\n\tfsmonitor = evil')).ok, false, bad);
    assert.equal(ws.resolveSafe('alice', bad).error, 'reserved_dir', bad);
  }
  assert.equal((await ws.writeFile('alice', '.gitignore', 'node_modules\n')).ok, true, 'ordinary dotfiles stay writable');
});

test('auto-allowed git commands cannot climb out of the workspace into the application repository', { skip: !gitAvailable }, async () => {
  await ws.writeFile('alice', 'note.txt', 'x');
  assert.equal(exec.classifyCommand(['git', 'status'], { userId: 'alice', taskId: 't1' }).mode, 'allow');
  const result = await exec.runCommand({ userId: 'alice', taskId: 't1', argv: ['git', 'status'] });
  // Without the ceiling, git would report the outer repository's status here.
  assert.notEqual(result.code, 0, JSON.stringify(result));
  assert.match(`${result.stderr || ''}${result.stdout || ''}`, /not a git repository/i);
});

test('a repository the user created inside the workspace still works', { skip: !gitAvailable }, async () => {
  const root = ws.workspaceRoot('bob');
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  const result = await exec.runCommand({ userId: 'bob', taskId: 't2', argv: ['git', 'status'] });
  assert.equal(result.code, 0, JSON.stringify(result));
});

test('appending writes extend the file under the same lock and size limit', async () => {
  assert.equal((await ws.writeFile('alice', 'long.md', '第一段\n')).ok, true);
  const second = await ws.writeFile('alice', 'long.md', '第二段\n', { append: true });
  assert.equal(second.appended, true);
  assert.equal((await ws.readFile('alice', 'long.md')).content, '第一段\n第二段\n');
  const fresh = await ws.writeFile('alice', 'new.md', '只有一段', { append: true });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.appended, undefined, 'appending to a missing file creates it');
});

test('automatic git rejects redirected metadata and command-config escape routes', {skip:!gitAvailable},async()=>{
  const root=ws.workspaceRoot('redirected');fs.mkdirSync(root,{recursive:true});
  fs.writeFileSync(path.join(root,'.git'),'gitdir: '+path.join(outer,'.git')+'\n');
  assert.equal(exec.classifyCommand(['git','status'],{userId:'redirected',taskId:'redirect'}).mode,'ask');
  const denied=await exec.runCommand({userId:'redirected',taskId:'redirect',argv:['git','status']});assert.equal(denied.denied,true);
  for(const argv of [['git','-C',outer,'status'],['git','--git-dir='+path.join(outer,'.git'),'status'],['git','--config-env=core.fsmonitor=BAD','status'],['git','log','--ext-diff'],['git','show','--textconv']])assert.notEqual(exec.classifyCommand(argv,{userId:'bob',taskId:'args'}).mode,'allow',JSON.stringify(argv));
  const linkRoot=ws.workspaceRoot('linked');fs.mkdirSync(linkRoot,{recursive:true});
  fs.symlinkSync(path.join(outer,'.git'),path.join(linkRoot,'.git'),process.platform==='win32'?'junction':'dir');
  assert.equal(exec.classifyCommand(['git','status'],{userId:'linked',taskId:'link'}).mode,'ask');
});
test('automatic git ignores inherited GIT_DIR, GIT_WORK_TREE and injected git configuration', {skip:!gitAvailable},async()=>{
  const keys=['GIT_DIR','GIT_WORK_TREE','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0'],before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,{GIT_DIR:path.join(outer,'.git'),GIT_WORK_TREE:outer,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.fsmonitor',GIT_CONFIG_VALUE_0:'not-a-real-command'});
    await ws.writeFile('env-owner','note.txt','x');
    const result=await exec.runCommand({userId:'env-owner',taskId:'env',argv:['git','status']});
    assert.notEqual(result.code,0);assert.match(result.stderr,/not a git repository/i);
  } finally {for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}}
});

test('auto git does not create branches or traverse nested redirected objects, includes or bare repositories',{skip:!gitAvailable},async()=>{
  for(const argv of [['git','branch','new-topic'],['git','branch','--delete=main'],['git','branch','-Dmain'],['git','branch','--track','topic']])assert.notEqual(exec.classifyCommand(argv,{userId:'bob',taskId:'branch'}).mode,'allow',JSON.stringify(argv));
  assert.equal(exec.classifyCommand(['git','branch','--list','topic*'],{userId:'bob',taskId:'list'}).mode,'allow');
  const bare=ws.workspaceRoot('bare');fs.mkdirSync(bare,{recursive:true});execFileSync('git',['init','--bare','-q',bare]);
  assert.equal(exec.classifyCommand(['git','log'],{userId:'bare',taskId:'bare'}).mode,'ask');
  const linked=ws.workspaceRoot('nestedmeta');fs.mkdirSync(linked,{recursive:true});execFileSync('git',['init','-q',linked]);
  fs.symlinkSync(path.join(outer,'.git','objects'),path.join(linked,'.git','objects','aa'),process.platform==='win32'?'junction':'dir');
  assert.equal(exec.classifyCommand(['git','show'],{userId:'nestedmeta',taskId:'nested'}).mode,'ask');
  const config=path.join(ws.workspaceRoot('bob'),'.git','config'),previous=fs.readFileSync(config,'utf8');
  for(const unsafe of ['[include]\npath = '+path.join(outer,'.git','config').replaceAll('\\','/'),'[diff "malicious"]\ncommand = blocked-not-executed','[filter "malicious"]\nclean = blocked-not-executed','[core]\nattributesFile = '+path.join(outer,'private.txt').replaceAll('\\','/')]){
    try{fs.writeFileSync(config,previous+'\n'+unsafe+'\n');assert.equal(exec.classifyCommand(['git','status'],{userId:'bob',taskId:'config'}).mode,'ask');}finally{fs.writeFileSync(config,previous);}
  }
});
