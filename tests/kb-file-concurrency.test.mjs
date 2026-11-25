import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test('concurrent file KB imports, section saves and deletion retain all committed owner data',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'kb-parallel-'));t.after(async()=>{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});});
  Object.assign(process.env,{DATA_DIR:dir,KB_FILE:path.join(dir,'kb.json'),EMBEDDING_PROVIDER:'off',MYSQL_ENABLED:'0'});
  const {initKb,importDocument,listDocuments,saveSection,listSections,deleteDocument,searchChunks}=await import('../src/server/kb.mjs');
  await initKb({mysqlReady:false});
  const imported=await Promise.all(Array.from({length:8},(_,i)=>importDocument({userId:i%2?'other':'owner',name:`${i}.txt`,buffer:Buffer.from(`独立证据第${i}条。合取消去规则需要前提成立才可以应用。`)})));
  const mine=imported.filter((_,i)=>i%2===0).map(r=>r.doc.id),others=imported.filter((_,i)=>i%2===1).map(r=>r.doc.id);
  await Promise.all([saveSection('owner',null,{name:'甲',docIds:mine}),saveSection('other',null,{name:'乙',docIds:others})]);
  await Promise.all([deleteDocument(mine[0],'owner'),importDocument({userId:'owner',name:'新文档.txt',buffer:Buffer.from('新文档记录合取推理，保存原文以供后续核对引用。')})]);
  await initKb({mysqlReady:false});assert.equal((await listDocuments('owner')).length,4);assert.equal((await listDocuments('other')).length,4);
  assert.ok(!(await listSections('owner'))[0].docIds.includes(mine[0]));
  assert.ok((await searchChunks('合取',{userId:'owner'})).every(hit=>!others.includes(hit.docId)));
});
