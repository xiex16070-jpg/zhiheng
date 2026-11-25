import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { currentWorkspace } from './workspace-selection.mjs';
import { resolveSafe } from './workspace.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';
import { fileVersion, withFileWriteContext } from './file-write-context.mjs';

export const FILE_MUTATIONS = new Set(['write_file','patch_file','create_document','create_visualization','pdf_fill','pdf_split','pdf_merge','notebook_edit','latex_compile','zotero_export','generate_image']);
const EFFECTFUL_TOOLS = new Set(['run_command','exec_start','exec_write','call_extension','extension_resources','read_extension_resource']);
const modes = ['ask','trusted','read_only'];
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function policyFile(userId) { if (!ID_RE.test(String(userId))) throw fail('invalid_user','用户无效。',400); return path.join(config.dataDir,'file-permissions',userId+'.json'); }
async function policyStore(userId) {
  try {
    const raw = await fs.readFile(policyFile(userId),'utf8');
    if (raw.length > 200000) throw new Error('size');
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || !data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects) || Object.values(data.projects).some(p => !modes.includes(p.mode))) throw new Error('invalid');
    return data;
  } catch(error) { if(error.code === 'ENOENT') return {version:1,revision:0,projects:{}}; throw fail('permissions_unreadable','文件权限配置无法读取，已停止模型写入；请恢复配置后重试。'); }
}
export async function readFilePermission(userId, workspaceId = currentWorkspace(userId).id) {
  const data = await policyStore(userId);
  return { workspaceId, revision:data.revision, mode:data.projects[workspaceId]?.mode || 'ask' };
}
export async function saveFilePermission(userId, input) {
  if (!input || Object.keys(input).some(k=>!['workspaceId','revision','mode'].includes(k)) || !modes.includes(input.mode)) throw fail('invalid_permission','请选择逐次确认、信任此项目或只读。',400);
  return withFileLock(policyFile(userId),async()=>{
    const workspace = currentWorkspace(userId), data = await policyStore(userId);
    if (!workspace.available || input.workspaceId !== workspace.id) throw fail('workspace_changed','当前项目已变化，请重新打开权限设置。');
    if(input.revision !== data.revision) throw fail('permissions_changed','权限已变化，请刷新后重试。');
    data.projects[workspace.id]={mode:input.mode}; data.revision++;
    await writeJsonAtomic(policyFile(userId),data);
    return readFilePermission(userId,workspace.id);
  });
}
export async function fileToolPolicy(name, ctx) {
  if (!FILE_MUTATIONS.has(name) && (!EFFECTFUL_TOOLS.has(name)||ctx.extensionReadOnly===true&&['call_extension','extension_resources','read_extension_resource'].includes(name))) return null;
  const workspace = currentWorkspace(ctx.userId);
  if (!workspace.available || workspace.id !== (ctx.workspaceId || workspace.id)) throw fail('workspace_changed','任务对应项目已变化，未执行写操作。');
  const policy = await readFilePermission(ctx.userId,workspace.id);
  if(policy.mode === 'read_only') throw fail('project_read_only','当前项目为只读，模型不能修改文件、执行命令或调用可能产生副作用的插件。');
  return policy;
}
export async function prepareFileMutation(name,args,ctx,previous = null) {
  const policy = await fileToolPolicy(name,ctx);
  if(!FILE_MUTATIONS.has(name)) return null;
  const outputPath = name === 'create_visualization' ? (previous?.outputPath || `visualizations/${crypto.randomUUID()}.html`) : String(args.output_path || args.path || '');
  const out = resolveSafe(ctx.userId, outputPath);
  if(out.error) throw fail('invalid_file_target','文件目标不在当前项目可写范围内。',400);
  const inputs = name === 'write_file' || name === 'patch_file' || name === 'generate_image' || name === 'zotero_export' || name === 'create_visualization' ? [] : [args.source_path,args.path !== outputPath ? args.path : null,args.font_path,...(args.paths || [])].filter(Boolean);
  const files = [];
  const snapshot=async relative=>{
    const target = resolveSafe(ctx.userId,relative);
    if(target.error) throw fail('invalid_file_target','输入或输出文件路径不可用。',400);
    if(files.some(file=>file.path===target.rel))return;
    const version=await fileVersion(target.abs);
    if(relative!==outputPath&&!version.exists)throw fail('input_file_missing','输入文件不存在，请先读取并确认来源文件。',400);
    files.push({path:target.rel,...version});
  };
  for(const relative of [...new Set([outputPath,...inputs])])await snapshot(relative);
  if(name==='create_document' && args.rows===undefined && !/\.xlsx$/i.test(outputPath)) {
    let markdown=String(args.markdown||'');
    if(args.source_path) {
      const source=resolveSafe(ctx.userId,args.source_path),version=files.find(file=>file.path===source.rel);
      if(version.bytes>240000)throw fail('file_too_large','文档源文件超过长度上限。',400);
      markdown=await fs.readFile(source.abs,'utf8');
      if(digest(markdown)!==version.sha256)throw fail('file_changed','文档源文件已变化，请重新读取。');
    }
    const {documentImagePaths}=await import('./documents.mjs');
    for(const image of await documentImagePaths(markdown)) {
      if(!/\.(png|jpe?g)$/i.test(image))throw fail('invalid_file_target','文档图片须为项目内 PNG/JPEG 文件。',400);
      inputs.push(image);await snapshot(image);
    }
  }
  if(previous && (previous.argsHash!==digest(canonical(args)) || previous.policyRevision!==policy.revision || previous.workspaceId!==policy.workspaceId ||
      JSON.stringify(previous.files)!==JSON.stringify(files))) throw fail('file_approval_content_changed','file_approval_content_changed：文件、权限或操作内容已变化，旧批准失效；请重新读取并发起修改。');
  const target = files[0];
  let before = '', after = '', action = target.exists ? 'replace' : 'create';
  if (['write_file','patch_file'].includes(name)) {
    if(target.bytes > config.workspace.maxFileBytes) throw fail('file_too_large','文件超过文本编辑上限。',400);
    before = target.exists ? await fs.readFile(out.abs,'utf8') : '';
    if(target.exists && digest(before)!==target.sha256) throw fail('file_changed','文件在生成审批预览时已变化，请重新读取。');
    after = String(args.content || '');
    if(name === 'write_file' && args.append === true && target.exists) { after = before + after; action = 'append'; }
    if(name === 'patch_file') {
      const old = String(args.old_text || ''), first = before.indexOf(old);
      if(!target.exists || !old || first < 0 || before.indexOf(old,first+1)>=0) throw fail('patch_not_unique','修改片段必须在当前文件中唯一命中；请重新读取文件。',400);
      after = before.replace(old,()=>String(args.new_text || '')); action='patch';
    }
  } else after = String(args.markdown || args.html || args.source || args.prompt || '');
  const review = { version:1,userId:ctx.userId,taskId:ctx.taskId || '',workspaceId:policy.workspaceId,policyRevision:policy.revision,
    tool:name,argsHash:digest(canonical(args)),outputPath:out.rel,files };
  review.fingerprint=digest(review);
  review.preview={action,path:out.rel,workspaceId:policy.workspaceId,tool:name,before:before.slice(0,8000),after:after.slice(0,8000),
    beforeBytes:target.bytes,afterBytes:['write_file','patch_file'].includes(name)?Buffer.byteLength(after):null,truncated:before.length>8000||after.length>8000,
    inputs:inputs.slice(0,15),mode:policy.mode,fingerprint:review.fingerprint};
  return review;
}
export async function withFileMutation(name,args,ctx,run) {
  const policy = await fileToolPolicy(name,ctx);
  if(!FILE_MUTATIONS.has(name)) return run(ctx);
  if(policy.mode === 'ask' && (!ctx.approvalVerified || !ctx.fileReview)) throw fail('file_approval_required','文件写入需要用户确认，请通过任务审批后执行。');
  const fresh = await prepareFileMutation(name,args,ctx,ctx.fileReview);
  if(ctx.fileReview && fresh.fingerprint !== ctx.fileReview.fingerprint) throw fail('file_approval_content_changed','文件、项目权限或操作内容已改变，旧批准失效；请重新读取并发起修改。');
  const verifyInputs=async()=>{
    const policyNow=await fileToolPolicy(name,ctx);
    if(policyNow.revision!==fresh.policyRevision)throw fail('permissions_changed','生成期间项目权限已变化，未写入文件。');
    for(const expected of fresh.files.filter(file=>file.path!==fresh.outputPath)) {
      const target=resolveSafe(ctx.userId,expected.path);
      if(target.error)throw fail('file_approval_content_changed','输入文件不再可用，未写入。');
      const actual=await fileVersion(target.abs);
      if(expected.exists!==actual.exists||expected.sha256!==actual.sha256)throw fail('file_approval_content_changed','生成期间输入文件已变化，请重新检查后确认。');
    }
  };
  return withFileWriteContext({...fresh,verifyInputs},()=>run({...ctx,fileMutationPath:fresh.outputPath}));
}
