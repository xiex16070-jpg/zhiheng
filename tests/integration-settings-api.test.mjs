import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
test('集成设置 HTTP：本机闸门、用户隔离、插件草案显式连接、独立图像配置与凭据脱敏', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-integration-api-'));
  await fs.writeFile(path.join(dir,'papers.jsonl'),JSON.stringify({id:1,title:'Formal logic',abstract:'Logic verifies the consequences of explicit assumptions.',discipline:'计算机'})+'\n');
  const child=spawn(process.execPath,['server.mjs'],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',HOST:'127.0.0.1',DATA_DIR:dir,ZHIHENG_DESKTOP:'1',
    STORE_FILE:'',CORPUS_JSONL:path.join(dir,'papers.jsonl'),KB_FILE:'',VECTOR_FILE:'',
    MYSQL_ENABLED:'false',REDIS_ENABLED:'false',EMBEDDING_PROVIDER:'off',QDRANT_URL:'',RAGFLOW_BASE_URL:'',RERANK_ENABLED:'false',MINERU_ENABLED:'false',
    LEARNING_ENABLED:'false',INFERENCE_AUDIT:'false',AUTH_SECRET:'integration-test-isolated-secret',SCHOLAR_SEARCH:'false',WEB_SEARCH_PROVIDER:'',WEB_SEARCH_KEY:'',OPENALEX_API_KEY:'',HTTP_PROXY:'',HTTPS_PROXY:''}});
  let logs='';for(const s of[child.stdout,child.stderr])s.on('data',c=>{logs=(logs+c).slice(-6000);});
  t.after(async()=>{if(child.exitCode===null&&!child.signalCode){const done=once(child,'exit');child.kill();await done;}assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));await fs.rm(dir,{recursive:true,force:true});});
  let base='';const deadline=Date.now()+20000;
  while(Date.now()<deadline&&child.exitCode===null){try{base='http://127.0.0.1:'+(await fs.readFile(path.join(dir,'.server-port'),'utf8')).trim();if((await(await fetch(base+'/api/health')).json()).ready)break;}catch{}await new Promise(r=>setTimeout(r,40));}
  assert.equal((await(await fetch(base+'/api/health')).json()).ready,true,logs);
  const boot=await fetch(base+'/api/bootstrap'),cookie=boot.headers.get('set-cookie').split(';')[0],uid=(await boot.json()).user.id;
  assert.match(cookie, /^zh_desktop_[0-9a-f]{16}=/);
  const mixedCookies = 'uid=development-session; ' + cookie;
  assert.equal((await (await fetch(base+'/api/bootstrap', { headers: { cookie: mixedCookies } })).json()).user.id, uid);
  const bob=(await fetch(base+'/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const get=(url,headers={})=>fetch(base+url,{headers:{cookie,...headers}});
  const send=(url,body,method='POST',headers={})=>fetch(base+url,{method,headers:{cookie,origin:base,'x-settings-request':'1','content-type':'application/json',...headers},body:JSON.stringify(body)});
  await t.test('桌面发布仅公开前端资源，错误会话可恢复，错误请求不会被记录为内部故障', async () => {
    for (const p of ['/', '/preview.html', '/src/ui/app.js', '/src/agent/text.js', '/src/styles/app.css', '/assets/vendor/NOTICE.txt']) {
      assert.equal((await get(p)).status, 200, p);
    }
    const image = await fetch(base + '/assets/illustrations/research-library.webp', { method: 'HEAD' });
    assert.equal(image.headers.get('content-type'), 'image/webp');
    assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Number(image.headers.get('content-length')) > 0);
    assert.equal((await image.arrayBuffer()).byteLength, 0);
    assert.equal((await get('/start-kb.bat')).status, 403);
    assert.equal((await get('/src/ui/missing.js')).status, 404);
    const expired = await get('/api/bootstrap', { cookie: 'uid=unreadable%' });
    assert.equal(expired.status, 200);
    assert.notEqual((await expired.json()).user.id, uid);
    const malformed = await fetch(base + '/api/conversations', { method: 'POST', headers: { cookie }, body: 'broken-synthetic-json' });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invalid_json');
    const overBudget = await send('/api/settings/plugin-packs/preflight', { path: 'a'.repeat(5000) });
    assert.equal(overBudget.status, 413);
    assert.ok(!logs.includes('broken-synthetic-json'));
  });
  for(const endpoint of['/api/settings/integrations','/api/settings/plugin-packs','/api/settings/models']){
    assert.equal((await fetch(base+endpoint)).status,401);
    assert.equal((await get(endpoint,{'x-forwarded-for':'8.8.8.8'})).status,403);
    assert.equal((await send(endpoint,{},'POST',{origin:'https://evil.example.org'})).status,403);
  }
  const secret='synthetic-zotero-local-key';
  const saved=await send('/api/settings/integrations',{revision:0,zoteroEnabled:true,zoteroLocalApiKey:secret});assert.equal(saved.status,200);assert.equal((await saved.json()).zoteroKeyConfigured,true);
  assert.equal((await send('/api/settings/integrations',{revision:0,zoteroEnabled:false})).status,409);
  assert.equal((await(await get('/api/settings/integrations',{cookie:bob})).json()).zoteroEnabled,false);
  assert.ok(!(await fs.readFile(path.join(dir,'integration-settings',uid+'.json'),'utf8')).includes(secret));
  assert.ok(!(await(await get('/api/settings/integrations')).text()).includes(secret));
  const chat=await(await send('/api/settings/models',{baseUrl:base+'/v1',model:'fixture-chat',apiKey:'synthetic-chat-key',vision:true,revision:0})).json();
  const image=await(await send('/api/settings/models',{baseUrl:base+'/v1',model:'fixture-image',apiKey:'synthetic-image-key',capability:'image',enabled:true,revision:1})).json();
  assert.equal(image.active.model,'fixture-chat');assert.equal(image.active.vision,true);assert.equal(image.activeImage.model,'fixture-image');assert.notEqual(chat.active.savedKeyId,image.activeImage.savedKeyId);
  const work=path.join(dir,'workspace',uid,'pack');await fs.mkdir(path.join(work,'flow'),{recursive:true});
  await fs.writeFile(path.join(work,'plugin.json'),JSON.stringify({name:'api-research',version:'1.0.0',description:'API fixture',skills:['flow/SKILL.md'],mcpServers:[{name:'Fixture server',kind:'stdio',command:process.execPath,args:[path.join(ROOT,'scripts','fixtures','extension-server.mjs')]}]}));
  await fs.writeFile(path.join(work,'flow','SKILL.md'),'---\nname: api-research-flow\ndescription: 核对证据来源\n---\n先核对来源和时间，再解释证据范围。');
  const preflight = '/api/settings/plugin-packs/preflight';
  const manifest = { path: 'pack/plugin.json' };
  assert.equal((await fetch(base + preflight, { method: 'POST' })).status, 401);
  assert.equal((await send(preflight, manifest, 'POST', { origin: 'https://foreign.example' })).status, 403);
  assert.equal((await send(preflight, manifest, 'POST', { 'x-settings-request': '' })).status, 403);
  assert.equal((await send(preflight, { ...manifest, user: uid })).status, 400);
  assert.equal((await send(preflight, manifest, 'POST', { cookie: bob })).status, 404);
  const preview = await send(preflight, manifest);
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.kind, 'plugin');
  assert.ok(previewBody.issues.some(i => i.code === 'mcp_not_connected'));
  assert.ok(previewBody.skills[0].issues.some(i => i.code === 'directory_mismatch'));
  assert.equal((await (await get('/api/settings/plugin-packs')).json()).packs.length, 0);
  assert.equal((await (await get('/api/settings/extensions')).json()).entries.length, 0);
  assert.equal((await get('/api/skills/api-research-flow')).status, 404);
  const installedResponse=await send('/api/settings/plugin-packs',{path:'pack/plugin.json'});assert.equal(installedResponse.status,200,await installedResponse.clone().text());
  const installed=await installedResponse.json();assert.equal(installed.packs.length,1);
  const download = '/api/skills/api-research-flow/export';
  assert.equal((await fetch(base + download)).status, 401);
  assert.equal((await get(download, { cookie: bob })).status, 404);
  assert.equal((await get(download + '?user=' + uid, { cookie: bob })).status, 400);
  assert.equal((await get(download + '?scope=global')).status, 404);
  assert.equal((await get(download + '?scope=own&scope=global')).status, 400);
  const zip = await get(download + '?scope=own');
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('cache-control'), /private, no-store/);
  assert.match(zip.headers.get('content-disposition'), /filename="api-research-flow\.zip"/);
  const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  assert.deepEqual(Object.keys(files), ['api-research-flow/SKILL.md']);
  const raw = strFromU8(files['api-research-flow/SKILL.md']);
  const detail = await (await get('/api/skills/api-research-flow')).json();
  assert.ok(raw.endsWith('\n---\n' + detail.body));
  assert.doesNotMatch(raw, /scopeId|userId|created_at|author:|plugin-pack|zhiheng-category/);
  const unpacked = path.join(work, 'api-research-flow');
  await fs.mkdir(unpacked);
  await fs.writeFile(path.join(unpacked, 'SKILL.md'), raw);
  const readback = await (await send(preflight, { path: 'pack/api-research-flow' })).json();
  assert.equal(readback.skills[0].standardValid, true);
  assert.ok(readback.skills[0].issues.some(i => i.code === 'local_name_conflict'));
  assert.equal((await(await get('/api/settings/plugin-packs',{cookie:bob})).json()).packs.length,0);
  assert.equal((await(await get('/api/settings/extensions')).json()).entries.length,0,'install must not start or register MCP');
  const connected=await send('/api/settings/plugin-packs/connect',{id:installed.pack.id,index:0});assert.equal(connected.status,200,await connected.clone().text());
  const ext=(await(await get('/api/settings/extensions')).json()).entries[0];assert.equal(ext.enabled,false);assert.ok(ext.tools.every(t=>!t.allowed));
  // A later global release can share a name with an existing private installation.
  const globalDir = path.join(dir, 'skills', '_global', 'api-research-flow');
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(path.join(globalDir, 'SKILL.md'), '---\nname: api-research-flow\ndescription: 公共流程\n---\n公共版本');
  assert.equal((await get(download + '?scope=global')).status, 404);
  assert.equal((await get(download + '?scope=global', { cookie: bob })).status, 200);
  assert.equal((await send('/api/settings/plugin-packs',{id:installed.pack.id},'DELETE',{cookie:bob})).status,400);
  const removed=await send('/api/settings/plugin-packs',{id:installed.pack.id},'DELETE');assert.equal(removed.status,200);
  assert.equal((await get(download + '?scope=own')).status, 404, 'archived skills cannot be downloaded through stale links');
  assert.equal((await get(download + '?scope=global')).status, 200);
  assert.equal((await(await get('/api/settings/extensions')).json()).entries.length,0);
  assert.equal((await(await get('/api/learn/effectiveness')).json()).tasks,0);
  assert.equal((await get('/src/server/integration-settings.mjs')).status,403);
  assert.equal((await get('/data/integration-settings/'+uid+'.json')).status,403);
  assert.ok(!logs.includes(secret));assert.ok(!(await fs.readFile(path.join(dir,'store.json'),'utf8')).includes(secret));
});
