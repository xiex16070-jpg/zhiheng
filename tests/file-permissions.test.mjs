import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const directory=await fs.mkdtemp(path.join(os.tmpdir(),'zh-file-permissions-'));
process.env.DATA_DIR=directory;
const {readFilePermission,saveFilePermission,prepareFileMutation,withFileMutation}=await import('../src/server/file-permissions.mjs');
const {writeFile,readFile,writeArtifact,resolveSafe}=await import('../src/server/workspace.mjs');
const {executeTool}=await import('../src/server/tools.mjs');
after(()=>fs.rm(directory,{recursive:true,force:true}));

test('default approval binds contents and operation; trusted and read-only are per-user explicit settings',async()=>{
  const ctx={userId:'alice',taskId:'task1',workspaceId:'default',evidence:new Map()};
  const args={path:'notes.md',content:'# Original'};
  assert.equal((await readFilePermission('alice')).mode,'ask');
  await assert.rejects(executeTool('write_file',args,ctx),/用户确认/);
  const fileReview=await prepareFileMutation('write_file',args,ctx);
  assert.equal(fileReview.preview.action,'create');
  await assert.rejects(executeTool('write_file',{...args,content:'# Replaced'},{...ctx,approvalVerified:true,fileReview}),/旧批准失效/);
  const result=await executeTool('write_file',args,{...ctx,approvalVerified:true,fileReview});
  assert.equal(result.artifact.path,args.path);
  await assert.rejects(executeTool('write_file',args,{...ctx,approvalVerified:true,fileReview}),/旧批准失效/);
  await saveFilePermission('alice',{...await readFilePermission('alice'),mode:'trusted'});
  await executeTool('write_file',{path:'trusted.md',content:'explicitly allowed'},ctx);
  await assert.rejects(executeTool('write_file',args,{...ctx,userId:'bob'}),/用户确认/);
  await saveFilePermission('alice',{...await readFilePermission('alice'),mode:'read_only'});
  for(const name of ['write_file','run_command','exec_start','call_extension','extension_resources','read_extension_resource']) {
    await assert.rejects(withFileMutation(name,args,ctx,()=>assert.fail('read-only must not execute')),/只读/);
  }
});

test('document approval binds nested, table and reference image bytes for inline and source Markdown',async()=>{
  const ctx={userId:'images',taskId:'image_task',workspaceId:'default',evidence:new Map()};
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=','base64');
  for(const name of ['inline','nested','table'])await writeArtifact(ctx.userId,name+'.png',png);
  const markdown='![ref][asset]\n\n[asset]: inline.png\n\n- **嵌套 ![图](nested.png)**\n\n| 图 |\n|---|\n| ![图](table.png) |';
  await writeFile(ctx.userId,'source.md',markdown);
  for(const args of [{path:'inline.docx',markdown},{path:'source.docx',source_path:'source.md'}]) {
    const fileReview=await prepareFileMutation('create_document',args,ctx);
    assert.deepEqual(fileReview.files.filter(file=>file.path.endsWith('.png')).map(file=>file.path),['inline.png','nested.png','table.png']);
    await fs.writeFile(resolveSafe(ctx.userId,'nested.png').abs,Buffer.concat([png,Buffer.from('changed')]));
    await assert.rejects(executeTool('create_document',args,{...ctx,approvalVerified:true,fileReview}),/旧批准失效/);
    await fs.writeFile(resolveSafe(ctx.userId,'nested.png').abs,png);
    const fresh=await prepareFileMutation('create_document',args,ctx);
    await assert.rejects(withFileMutation('create_document',args,{...ctx,approvalVerified:true,fileReview:fresh},async()=>{
      await fs.writeFile(resolveSafe(ctx.userId,'table.png').abs,Buffer.concat([png,Buffer.from('changed')]));
      return writeArtifact(ctx.userId,args.path,Buffer.from('fixture'));
    }),/输入文件已变化/);
    await fs.writeFile(resolveSafe(ctx.userId,'table.png').abs,png);
    assert.equal((await readFile(ctx.userId,args.path)).ok,false);
  }
});

test('approved LaTeX compilation uses private scratch and delivers only the bound PDF',async()=>{
  const {compileLatex}=await import('../src/server/docgen/latex.mjs');
  const {PDFDocument}=await import('pdf-lib');
  const ctx={userId:'latex',taskId:'latex_task',workspaceId:'default',evidence:new Map()};
  const source='\\documentclass{article}\n\\begin{document}Approved content\\end{document}';
  await writeFile(ctx.userId,'paper.tex',source);
  const args={source_path:'paper.tex',output_path:'paper.pdf'},fileReview=await prepareFileMutation('latex_compile',args,ctx);
  const pdf=await PDFDocument.create();pdf.addPage();const bytes=Buffer.from(await pdf.save());
  const dependencies={availability:async()=>({available:true,engine:'fixture-tectonic'}),run:async options=>{
    assert.ok(options.argv.includes('--untrusted'));assert.ok(options.argv.includes('--only-cached'));assert.ok(options.approved);
    assert.equal(await fs.readFile(resolveSafe(ctx.userId,options.cwd+'/source.tex').abs,'utf8'),source);
    await fs.writeFile(resolveSafe(ctx.userId,options.cwd+'/source.pdf').abs,bytes);return {ok:true};
  }};
  const result=await withFileMutation('latex_compile',args,{...ctx,approvalVerified:true,fileReview},effective=>compileLatex(args,effective,dependencies));
  assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual(await fs.readFile(resolveSafe(ctx.userId,'paper.pdf').abs),bytes);
  assert.deepEqual((await fs.readdir(resolveSafe(ctx.userId,'paper.pdf').root)).sort(),['paper.pdf','paper.tex']);
  const failedArgs={...args,output_path:'failed.pdf'},failedReview=await prepareFileMutation('latex_compile',failedArgs,ctx);
  const failed=await withFileMutation('latex_compile',failedArgs,{...ctx,approvalVerified:true,fileReview:failedReview},effective=>compileLatex(failedArgs,effective,{...dependencies,run:async()=>({ok:false,stderr:'fixture compile failed'})}));
  assert.equal(failed.code,'compile_failed');assert.deepEqual((await fs.readdir(resolveSafe(ctx.userId,'paper.pdf').root)).sort(),['paper.pdf','paper.tex']);
});

test('changes during generation invalidate source and target versions before artifact is written',async()=>{
  const ctx={userId:'author',taskId:'task2',workspaceId:'default',evidence:new Map()};
  await writeFile('author','source.md','# Reviewed source');
  const args={path:'report.docx',source_path:'source.md'};
  const fileReview=await prepareFileMutation('create_document',args,ctx);
  await assert.rejects(withFileMutation('create_document',args,{...ctx,approvalVerified:true,fileReview},async()=>{
    // External editor changes the input while a renderer works.
    await fs.writeFile(resolveSafe('author','source.md').abs,'changed externally');
    return writeArtifact('author','report.docx',Buffer.from('binary fixture'));
  }),/输入文件已变化/);
  assert.equal((await readFile('author','report.docx')).ok,false);
  const fresh=await prepareFileMutation('create_document',args,ctx);
  await assert.rejects(withFileMutation('create_document',args,{...ctx,approvalVerified:true,fileReview:fresh},async()=>{
    await saveFilePermission('author',{...await readFilePermission('author'),mode:'read_only'});
    return writeArtifact('author','report.docx',Buffer.from('binary fixture'));
  }),/只读/);
  await assert.rejects(fs.stat(resolveSafe('author','report.docx').abs),{code:'ENOENT'});
});

test('corrupt permission state is never replaced by an empty trusted store',async()=>{
  const filename=path.join(directory,'file-permissions','broken.json');
  await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,'{broken');
  await assert.rejects(readFilePermission('broken'),/无法读取/);
  await assert.rejects(saveFilePermission('broken',{workspaceId:'default',revision:0,mode:'trusted'}),/无法读取/);
  assert.equal(await fs.readFile(filename,'utf8'),'{broken');
});
