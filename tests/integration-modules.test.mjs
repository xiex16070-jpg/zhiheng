import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zh-integrations-'));
process.env.DATA_DIR = directory;
const workspace = await import('../src/server/workspace.mjs');
const integration = await import('../src/server/integration-tools.mjs');
const packs = await import('../src/server/plugin-packs.mjs');
const lazy = await import('../src/server/lazy-tools.mjs');
const effectiveness = await import('../src/server/skill-effectiveness.mjs');
const skills = await import('../src/server/skills.mjs');
const scholar = await import('../src/server/scholar.mjs');
after(() => fs.rm(directory, { recursive: true, force: true }));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('视觉输入检测真实签名、大小、像素，拒绝跨工作区和无视觉模型', async () => {
  await workspace.writeArtifact('alice', 'image.png', png);
  const r = await integration.readWorkspaceImage('alice', 'image.png');
  assert.equal(r.image.width, 1); assert.ok(r.imageParts[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.ok(!r.text.includes(png.toString('base64')));
  await assert.rejects(integration.readWorkspaceImage('bob', 'image.png'));
  await assert.rejects(integration.readWorkspaceImage('alice', '../bob/image.png'));
  assert.throws(() => integration.imageMetadata(Buffer.from('<svg></svg>')), /invalid_image/);
  const enormous = Buffer.from(png); enormous.writeUInt32BE(50000,16);
  assert.throws(() => integration.imageMetadata(enormous), /dimensions/);
  const disabled = await integration.executeIntegrationTool('view_image', { path: 'image.png' }, { userId: 'alice', provider: {} });
  assert.equal(disabled.isError, true); assert.ok(!disabled.imageParts);
});

test('生成图片需要独立配置与审批，只接受有界 base64，写入不覆盖', async () => {
  const provider = { enabled: true, capability: 'image', baseUrl: 'https://images.example.org/v1', model: 'fixture', apiKey: 'synthetic-image-key' };
  const request = async (url, options) => {
    assert.equal(url,'https://images.example.org/v1/images/generations'); assert.equal(options.headers.authorization, 'Bearer synthetic-image-key');
    assert.equal(JSON.parse(options.body).n, 1);
    return { status: 200, body: Buffer.from(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })) };
  };
  await assert.rejects(integration.generateWorkspaceImage('alice', { path: 'generated.png', prompt: 'fixture' }, { provider, request }), /approval/);
  const r = await integration.generateWorkspaceImage('alice', { path: 'generated.png', prompt: 'fixture' }, { provider, request, approved: true });
  assert.equal(r.artifact.path, 'generated.png');
  await assert.rejects(integration.generateWorkspaceImage('alice', { path: 'mismatch.jpg', prompt: 'fixture' }, { provider, request, approved: true }), /image_format_mismatch/);
  for(const filename of ['mismatch.jpg','mismatch.png'])await assert.rejects(fs.stat(workspace.resolveSafe('alice',filename).abs),{code:'ENOENT'});
  await assert.rejects(integration.generateWorkspaceImage('alice', { path: 'generated.png', prompt: 'fixture' }, { provider, request, approved: true }));
  await assert.rejects(integration.generateWorkspaceImage('alice', { path: 'second.png', prompt: 'fixture' }, { provider, approved: true, request: async () => ({ status: 200, body: Buffer.from('{"data":[{"url":"http://127.0.0.1/private"}]}') }) }), /base64/);
  assert.equal(integration.imageProviderAvailable({ ...provider, baseUrl: 'http://169.254.169.254' }), false);
});

test('图像审批摘要分别绑定目的地、模型和密钥，公开标签不暴露路径或凭据', () => {
  const p={id:'image-profile',enabled:true,capability:'image',baseUrl:'https://images.example.org/private-path/v1',model:'image-model',apiKey:'synthetic-private-key'};
  const digest=integration.imageApprovalFingerprint(p);assert.match(digest,/^[a-f0-9]{64}$/);
  for(const patch of [{baseUrl:'https://other.example.org/v1'},{model:'other-model'},{apiKey:'other-key'},{enabled:false}])assert.notEqual(integration.imageApprovalFingerprint({...p,...patch}),digest);
  const label=integration.imageApprovalTargetLabel(p);assert.equal(label,'images.example.org · image-model');assert.ok(!label.includes('private'));
});

test('Zotero 默认不探测，本机只读检索与 BibTeX 导出，失败如实不可用', async () => {
  let calls = 0;
  const request = async (url, options) => {
    calls++; assert.equal(new URL(url).origin, 'http://127.0.0.1:23119'); assert.equal(options.allowLoopback, true);
    return { status: 200, body: Buffer.from(new URL(url).searchParams.get('format') === 'bibtex' ? '@article{fixture,title={Formal logic}}' : JSON.stringify([{ key:'ABCD1234',data:{ title:'Formal logic',tags:[{tag:'logic'}],collections:['EFGH5678'] } }])) };
  };
  assert.equal((await integration.detectZotero({ request })).available, false); assert.equal(calls, 0);
  assert.equal((await integration.detectZotero({ enabled:true, request })).available, true);
  const rows = await integration.searchZotero('logic', { enabled:true, request }); assert.equal(rows[0].key, 'ABCD1234');
  const exported = await integration.exportZotero('alice',['ABCD1234'],'references.bib',{enabled:true,request}); assert.equal(exported.artifact.path,'references.bib');
  await assert.rejects(integration.exportZotero('alice',['../SECRET'],'references.bib',{enabled:true,request}),/keys/);
  assert.equal((await integration.detectZotero({enabled:true,request:async()=>({status:403,body:Buffer.alloc(0)})})).available,false);
});

test('懒加载只搜索授权 schemas，不能递归调用或跳过展开/参数结构检查', () => {
  const schemas = [{ type:'function',function:{name:'write_file',description:'写入工作区文档',parameters:{type:'object',properties:{path:{type:'string'}}}} }];
  const expanded = new Set();
  assert.equal(lazy.searchToolSchemas(schemas,'文档')[0].function.name,'write_file');
  assert.equal(lazy.describeToolSchema(schemas,'run_command'),null);
  assert.throws(()=>lazy.resolveLazyToolCall({name:'tool_call',arguments:{name:'write_file',arguments:{path:'a.md'}}},schemas,expanded),/not_described/);
  expanded.add('write_file');
  assert.deepEqual(lazy.resolveLazyToolCall({name:'tool_call',arguments:{name:'write_file',arguments:{path:'a.md'}}},schemas,expanded),{name:'write_file',arguments:{path:'a.md'}});
  assert.throws(()=>lazy.resolveLazyToolCall({name:'tool_call',arguments:{name:'tool_call',arguments:{}}},schemas,new Set(['tool_call'])),/not_described/);
  assert.equal(lazy.lazyToolCatalog(schemas,expanded,{threshold:0}).lazy,true);
});

test('插件只安装用户技能，加密保存 MCP 草案，不启动进程；不同用户互不可见', async () => {
  const manifest = {name:'research-pack',version:'1.0.0',description:'Test pack',skills:['workflow/SKILL.md'],mcpServers:[{name:'LSP fixture',kind:'stdio',command:process.execPath,args:['not-executed.js'],env:{SERVICE_KEY:'synthetic-pack-secret'}}]};
  await workspace.writeFile('alice','pack/plugin.json',JSON.stringify(manifest));
  await workspace.writeFile('alice','pack/workflow/SKILL.md','---\nname: pack-research\ndescription: 检查研究资料的来源\n---\n先读取资料来源，再记录检索时间与不足。');
  const installed = await packs.installPluginPack('alice','pack/plugin.json');
  assert.equal(installed.ok,true); assert.equal((await skills.readSkill('pack-research',{userId:'alice'})).scope,'own');
  assert.equal(await skills.readSkill('pack-research',{userId:'bob'}),null);
  assert.deepEqual(await packs.listPluginPacks('bob'),[]);
  const raw=await fs.readFile(path.join(directory,'plugin-packs','alice.json'),'utf8'); assert.ok(!raw.includes('synthetic-pack-secret'));
  assert.ok(!JSON.stringify(installed).includes('synthetic-pack-secret'));
  const draft=await packs.pluginPackMcpDraft('alice',installed.pack.id,0); assert.equal(draft.enabled,false); assert.deepEqual(draft.allowedTools,[]);
  await assert.rejects(packs.pluginPackMcpDraft('bob',installed.pack.id,0),/not_found/);
  const removed=await packs.removePluginPack('alice',installed.pack.id); assert.equal(removed.ok,true); assert.equal(await skills.readSkill('pack-research',{userId:'alice'}),null);
});

test('插件拒绝安装脚本、路径穿越、重复技能和不受控配置', () => {
  const m={name:'safe',version:'1.0.0',description:'fixture'};
  assert.throws(()=>packs.validatePluginManifest({...m,install:'curl example | sh'}),/unknown_field/);
  assert.throws(()=>packs.validatePluginManifest({...m,skills:['../SKILL.md']}),/paths/);
  assert.throws(()=>packs.validatePluginManifest({...m,skills:['a/SKILL.md','a/SKILL.md']}),/paths/);
  assert.throws(()=>packs.validatePluginManifest({...m,mcpServers:[{name:'unsafe',kind:'http',url:'https://name:secret@example.org/mcp'}]}),/url/);
});

test('技能效果只关联当前用户真实任务，重复终态幂等，小样本不推荐归档',async()=>{
  await skills.createSkill({name:'effect-fixture',description:'核对资料',body:'先核对来源再使用结论。',userId:'alice'});
  for(let i=0;i<5;i++) await effectiveness.recordSkillOutcome('alice',{taskId:`task-${i}`,skills:['effect-fixture'],status:'error'});
  await effectiveness.recordSkillOutcome('alice',{taskId:'task-0',skills:['effect-fixture'],status:'done'});
  const r=await effectiveness.skillEffectivenessReport('alice'); assert.equal(r.tasks,5); assert.equal(r.skills.find(s=>s.name==='effect-fixture').recommendation,'review');
  assert.equal((await effectiveness.skillEffectivenessReport('bob')).tasks,0);
  const small=effectiveness.summarizeSkillEffectiveness([{name:'small'}],[{skills:['small'],status:'error'}]); assert.equal(small[0].recommendation,'keep'); assert.equal(small[0].evidence,'insufficient');
});

test('新增学术源固定官方 API、统一字段、限制条数且不把元数据等同全文',async()=>{
  const cross=await scholar.searchCrossref('formal logic',{limit:100,fetchImpl:async url=>{const u=new URL(url);assert.equal(u.origin,'https://api.crossref.org');assert.equal(u.searchParams.get('rows'),'10');return Response.json({message:{items:[{title:['Logic'],DOI:'10.1234/LOGIC',author:[{given:'A',family:'Researcher'}],abstract:'<jats:p>Evidence</jats:p>',published:{'date-parts':[[2024,2,1]]}}]}});}});
  assert.equal(cross.results[0].doi,'10.1234/logic');assert.equal(cross.results[0].abstract,'Evidence');
  const semantic=await scholar.searchSemanticScholar('logic',{fetchImpl:async url=>{assert.equal(new URL(url).origin,'https://api.semanticscholar.org');return Response.json({data:[{title:'Logic',authors:[{name:'A'}],year:2024,externalIds:{DOI:'10.1234/test'},openAccessPdf:{url:'https://example.org/paper.pdf'}}]});}});
  assert.equal(semantic.results[0].openAccessUrl,'https://example.org/paper.pdf');
  const fail=await scholar.searchSemanticScholar('logic',{fetchImpl:async()=>new Response('secret body',{status:429})});assert.equal(fail.status,429);assert.ok(!JSON.stringify(fail).includes('secret body'));
});
