import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBlindBatch, ingestReviews, verifyReviewedDataset, classificationMetrics, digest } from '../evals/annotation-workflow.mjs';
import { retrievalMetrics, validateRetrievalCases } from '../evals/semantic-evaluate.mjs';
import { publicPilot } from '../evals/annotation-pilot.mjs';

// Synthetic fixtures test the workflow, never stand in for completed human review.
const pack = () => ({ version:'fixture-v1', cases:[{id:'private-case-key',question:'是否均已验证？',claim:'所有程序均已验证。',
  model:'hidden-model', expected:'supported',source:{ref:'ref1',uri:'https://example.org/paper',license:'fixture',public:true,text:'前言。仅验证程序甲。结束。'},span:{start:3,end:10}}] });
const reviewer = id => ({id,exportUserId:id,kind:'synthetic_fixture',attestedBy:'test-coordinator',attestedAt:'2026-11-07T00:00:00Z'});
function review(batch,id,label='insufficient') {
  return {reviewer:reviewer(id),tasks:batch.tasks.map(t=>({data:t.data,annotations:[{id:`${id}-${t.data.taskId}`,completed_by:id,was_cancelled:false,
    updated_at:'2026-11-07T00:00:00Z',result:[{from_name:'verdict',to_name:'claim',type:'choices',value:{choices:[label]}},
      {from_name:'rationale',to_name:'claim',type:'textarea',value:{text:['Synthetic fixture reasoning.']}},
      ...(label==='insufficient'?[]:[{from_name:'evidence',to_name:'evidence_text',type:'labels',value:{start:0,end:t.data.evidenceText.length,text:t.data.evidenceText,labels:['Evidence']}}])]}]}))};
}
test('blind export removes model/gold/case IDs; freezes public source and original offsets',()=>{
  const b=createBlindBatch(pack()); const printed=JSON.stringify(b.tasks);
  assert.ok(!printed.includes('hidden-model')); assert.ok(!printed.includes('private-case-key')); assert.ok(!printed.includes('expected'));
  assert.equal(b.tasks[0].data.evidenceText,'仅验证程序甲。'); assert.equal(b.manifest.tasks[0].source.sha256,digest('前言。仅验证程序甲。结束。'));
  const p=pack();p.cases[0].source.public=false;assert.throws(()=>createBlindBatch(p),/public/);
  p.cases[0].source.public=true;p.cases[0].source.uri='http://localhost/private';assert.throws(()=>createBlindBatch(p),/public/);
});
test('two complete fixture reviews build verifiable provenance but never human labels',()=>{
  const b=createBlindBatch(pack()),r=ingestReviews({manifest:b.manifest,reviews:[review(b,'a'),review(b,'b')]});
  assert.equal(r.status,'complete_fixture'); assert.equal(r.dataset.humanReviewed,false);
  assert.equal(r.dataset.cases[0].expected,'unsupported');assert.equal(r.agreement.observedAgreement,1);
  assert.equal(verifyReviewedDataset(r.dataset).humanReviewed,false);
  r.dataset.humanReviewed=true;assert.throws(()=>verifyReviewedDataset(r.dataset),/integrity|mismatch/);r.dataset.humanReviewed=false;
  r.dataset.cases[0].expected='supported';assert.throws(()=>verifyReviewedDataset(r.dataset),/integrity|mismatch/);
  assert.throws(()=>verifyReviewedDataset({humanReviewed:true,cases:[{id:'x'}]}),/provenance/);
});
test('cancelled and missing tasks stay visible and block dataset emission',()=>{
  const b=createBlindBatch(pack()),a=review(b,'a'),bb=review(b,'b');a.tasks[0].annotations[0].was_cancelled=true;bb.tasks=[];
  const r=ingestReviews({manifest:b.manifest,reviews:[a,bb]});
  assert.equal(r.status,'incomplete');assert.equal(r.dataset,undefined);assert.equal(r.completeness[0].cancelled,1);assert.equal(r.completeness[1].missing,1);
});

test('reordered copies, duplicated roster identities and inherited annotations cannot supply independent votes', () => {
  const source = pack();
  source.cases.push({ ...source.cases[0], id: 'second' });
  const batch = createBlindBatch(source);
  const first = review(batch, 'a');
  const second = structuredClone(first);
  second.reviewer.id = 'b';
  second.tasks.reverse();
  second.tasks.forEach(t => { t.project = 'copied-to-different-project'; });
  assert.throws(() => ingestReviews({ manifest: batch.manifest, reviews: [first, second] }), /independent_exports/);
  const distinct = review(batch, 'b');
  distinct.reviewer.id = ' Ａ ';
  assert.throws(() => ingestReviews({ manifest: batch.manifest, reviews: [first, distinct] }), /independent_reviewers/);
  distinct.reviewer.id = 'b';
  distinct.tasks[0].annotations[0].parent_annotation = 123;
  assert.throws(() => ingestReviews({ manifest: batch.manifest, reviews: [first, distinct] }), /nonmanual/);
});
test('duplicate, unknown, modified tasks and same reviewers fail closed',()=>{
  const b=createBlindBatch(pack()),a=review(b,'a'),bb=review(b,'b');
  assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,a]}),/independent/);
  a.tasks.push(a.tasks[0]);assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,bb]}),/duplicate/);a.tasks.pop();
  a.tasks[0].data={...a.tasks[0].data,claim:'tampered'};assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,bb]}),/task_data/);
  a.tasks[0].data={...a.tasks[0].data,taskId:'unknown'};assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,bb]}),/unknown_task/);
});
test('disagreement requires a third reviewer, original vote digests, rationale and valid evidence',()=>{
  const b=createBlindBatch(pack()),reviews=[review(b,'a','supported'),review(b,'b','contradicted')];
  const pending=ingestReviews({manifest:b.manifest,reviews});assert.equal(pending.status,'incomplete');
  const decision={taskId:b.tasks[0].data.taskId,reviewer:reviewer('c'),verdict:'contradicted',rationale:'Fixture adjudication, not human.',
    reviewedAt:'2026-11-07T00:00:00Z',voteDigests:pending.disagreements[0].voteDigests,evidenceSpans:[{start:0,end:7,text:'仅验证程序甲。'}]};
  const r=ingestReviews({manifest:b.manifest,reviews,adjudications:[decision]});assert.equal(r.status,'complete_fixture');assert.equal(r.dataset.cases[0].expected,'contradicted');
  const correctVotes=decision.voteDigests;decision.voteDigests=['stale','stale'];assert.throws(()=>ingestReviews({manifest:b.manifest,reviews,adjudications:[decision]}),/vote_integrity/);decision.voteDigests=correctVotes;
  decision.reviewer=reviewer('a');assert.throws(()=>ingestReviews({manifest:b.manifest,reviews,adjudications:[decision]}),/third_reviewer/);
  decision.reviewer=reviewer('c');decision.evidenceSpans[0].text='fabricated';assert.throws(()=>ingestReviews({manifest:b.manifest,reviews,adjudications:[decision]}),/span/);
});
test('three-class metrics keep missed/unassessed cases in gold recall denominator',()=>{
  const m=classificationMetrics([{expected:'supported',verdict:'supported',independent:true},{expected:'contradicted',verdict:'unsupported',independent:true},
    {expected:'unsupported',verdict:'uncertain',independent:true},{expected:'supported',verdict:'supported',independent:false}]);
  assert.equal(m.total,4);assert.equal(m.accuracy,.25);assert.equal(m.assessed,3);assert.equal(m.perClass.supported.recall,.5);
  assert.equal(m.confusion.supported.unassessed,1);assert.equal(m.confusion.contradicted.unsupported,1);
});
test('retrieval accepts explicit empty-reference negatives while preserving positive scoring',()=>{
  const cases=[{id:'a',question:'q',expectedRefs:['ref']},{id:'b',question:'none',expectedRefs:[],expectInsufficient:true}];
  assert.doesNotThrow(()=>validateRetrievalCases(cases));assert.throws(()=>validateRetrievalCases([{...cases[1],expectInsufficient:false}]),/empty_reference/);
  assert.throws(()=>validateRetrievalCases([{...cases[0],expectInsufficient:true}]),/negative_reference/);
  const m=retrievalMetrics([{...cases[0],results:[{ref:'ref'}]},{...cases[1],results:[],weak:true}]);
  assert.equal(m.hitAt5,1);assert.equal(m.negativeCases,1);assert.equal(m.insufficientDetection,1);
});
test('human attestation requires original exports, matching identities and no preannotations',()=>{
  const b=createBlindBatch(pack()),a=review(b,'a'),bb=review(b,'b');
  a.reviewer.kind='human';assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,bb]}),/original_export/);
  a.exportText=JSON.stringify(a.tasks);a.exportFileSha256=digest(a.exportText);
  a.tasks[0].annotations[0].completed_by='other';a.exportText=JSON.stringify(a.tasks);a.exportFileSha256=digest(a.exportText);
  assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,bb]}),/reviewer_mismatch/);
  a.tasks[0].annotations[0].completed_by='a';a.tasks[0].predictions=[{model_version:'fixture'}];a.exportText=JSON.stringify(a.tasks);a.exportFileSha256=digest(a.exportText);
  assert.throws(()=>ingestReviews({manifest:b.manifest,reviews:[a,bb]}),/preannotations/);
});
test('public pilot uses verified licensed corpus text and creates no answers/gold labels',async()=>{
  const p=await publicPilot(),b=createBlindBatch(p);assert.equal(p.cases.length,6);assert.equal(b.tasks.length,6);
  assert.ok(p.cases.every(c=>!('expected' in c)&&c.source.license==='MIT'&&c.source.licenseNotice));
});
test('CLI roundtrip writes review proof and SHA without overwriting inputs or making fixture labels human',async()=>{
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),dir=await fs.mkdtemp(path.join(os.tmpdir(),'annotation-workflow-'));
  try{
    const run=args=>spawnSync(process.execPath,['evals/annotation-cli.mjs',...args],{cwd:root,encoding:'utf8',windowsHide:true});
    const input=path.join(dir,'input.json'),batchDir=path.join(dir,'batch'),out=path.join(dir,'reviewed');await fs.writeFile(input,JSON.stringify(pack()));
    let result=run(['export','--input',input,'--out-dir',batchDir]);assert.equal(result.status,0,result.stderr);
    assert.equal(run(['export','--input',input,'--out-dir',batchDir]).status,1);
    const manifest=JSON.parse(await fs.readFile(path.join(batchDir,'coordinator-manifest.json'),'utf8'));
    const batch={tasks:JSON.parse(await fs.readFile(path.join(batchDir,'blind-a.json'),'utf8'))};
    const a=review(batch,'a'),b=review(batch,'b'),aPath=path.join(dir,'a.json'),bPath=path.join(dir,'b.json'),roster=path.join(dir,'roster.json');
    await fs.writeFile(aPath,JSON.stringify(a.tasks));await fs.writeFile(bPath,JSON.stringify(b.tasks));await fs.writeFile(roster,JSON.stringify({a:a.reviewer,b:b.reviewer}));
    result=run(['import','--manifest',path.join(batchDir,'coordinator-manifest.json'),'--review-a',aPath,'--review-b',bPath,'--roster',roster,'--out-dir',out]);
    assert.equal(result.status,0,result.stderr);const text=await fs.readFile(path.join(out,'reviewed-cases.json'),'utf8');
    const data=JSON.parse(text),sha=JSON.parse(await fs.readFile(path.join(out,'reviewed-cases.json.sha256.json'),'utf8'));
    assert.equal(sha.sha256,digest(text));assert.equal(verifyReviewedDataset(data).humanReviewed,false);assert.equal(data.annotationReview.manifest.sha256,manifest.sha256);
    assert.match(await fs.readFile(path.join(batchDir,'claim-support.xml'),'utf8'),/evidence_text/);
  }finally{assert.equal(path.dirname(dir),os.tmpdir());await fs.rm(dir,{recursive:true,force:true});}
});
