/** Hash-bound supplementary evaluation. Existing frozen holdouts are read-only. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {classificationMetrics,verifyReviewedDataset,LABELS} from './annotation-workflow.mjs';
const hash=text=>createHash('sha256').update(text.replace(/\r\n?/g,'\n')).digest('hex');
export function retrievalMetrics(rows) {
  const positive=rows.filter(r=>r.expectedRefs?.length), count=positive.length;
  const negative=rows.filter(r=>r.expectInsufficient===true);
  return {cases:count,hitAt5:count?positive.filter(r=>r.results.some(x=>r.expectedRefs.includes(x.ref))).length/count:null,
    mrrAt5:count?positive.reduce((n,r)=>{const index=r.results.findIndex(x=>r.expectedRefs.includes(x.ref));return n+(index<0?0:1/(index+1));},0)/count:null,
    sourceIdPrecision:positive.reduce((n,r)=>n+r.results.filter(x=>r.expectedRefs.includes(x.ref)).length,0)/Math.max(1,positive.reduce((n,r)=>n+r.results.length,0)),
    negativeCases:negative.length,insufficientDetection:negative.length?negative.filter(r=>r.weak||!r.results.length).length/negative.length:null};
}
export function validateRetrievalCases(cases) {
  const ids=new Set();
  for(const c of cases){
    if(typeof c.id!=='string'||!c.id||ids.has(c.id)||typeof c.question!=='string'||!c.question.trim()||!Array.isArray(c.expectedRefs)||c.expectedRefs.some(r=>typeof r!=='string'||!r)||new Set(c.expectedRefs).size!==c.expectedRefs.length)throw new Error('Invalid retrieval case or duplicate ID/ref');
    ids.add(c.id);
    if(!c.expectedRefs.length&&c.expectInsufficient!==true)throw new Error('empty_reference_requires_explicit_expectInsufficient');
    if(c.expectedRefs.length&&c.expectInsufficient===true)throw new Error('negative_reference_must_be_empty');
  }
}
export function supportMetrics(results) {
  const negatives=results.filter(r=>r.expected!=='supported'),positives=results.filter(r=>r.expected==='supported');
  const negativeAssessed=negatives.filter(r=>r.independent).length,positiveAssessed=positives.filter(r=>r.independent).length;
  return {negativeCases:negatives.length,positiveCases:positives.length,assessed:results.filter(r=>r.independent).length,
    negativeAssessed,positiveAssessed,negativeCoverage:negativeAssessed/Math.max(1,negatives.length),positiveCoverage:positiveAssessed/Math.max(1,positives.length),
    uncertain:results.filter(r=>r.verdict==='uncertain').length,supportedPositives:positives.filter(r=>r.verdict==='supported').length,
    detection:negativeAssessed?negatives.filter(r=>['unsupported','contradicted'].includes(r.verdict)).length/Math.max(1,negatives.length):null,
    falsePositive:positiveAssessed?positives.filter(r=>['unsupported','contradicted'].includes(r.verdict)).length/positiveAssessed:null,
    falsePositiveUpperBound:positiveAssessed?(positives.filter(r=>['unsupported','contradicted'].includes(r.verdict)).length+positives.length-positiveAssessed)/Math.max(1,positives.length):null,
    threeClass:classificationMetrics(results)};
}
export async function evaluate({casesPath,expectedSha,userId='',answerModel='',mode='retrieval'}) {
  const raw=await fs.readFile(casesPath,'utf8'),sha=hash(raw);
  if(!expectedSha || sha!==expectedSha)throw new Error('A pre-recorded --sha matching the case file is required; freeze before tuning');
  const data=JSON.parse(raw);if(!Array.isArray(data.cases)||!data.cases.length)throw new Error('Empty case set');
  if(!['support','retrieval'].includes(mode))throw new Error('Unknown evaluation mode');
  const humanReview=data.annotationReview||data.humanReviewed===true?verifyReviewedDataset(data):{humanReviewed:false,status:'not_human_reviewed'};
  const base={version:1,caseSet:data.version,caseSetSha256:sha,humanReviewed:humanReview.humanReviewed,humanReview,promotable:false,generatedAt:new Date().toISOString()};
  if(mode==='support') {
    if(new Set(data.cases.map(c=>c.id)).size!==data.cases.length||data.cases.some(c=>!c.id||typeof c.source!=='string'||!c.source||typeof c.claim!=='string'||!c.claim||!LABELS.includes(c.expected)))throw new Error('Invalid support cases');
    const {checkSupportStatements}=await import('../src/server/support-check.mjs');const results=[];let llmCalls=0;
    for(let i=0;i<data.cases.length;i+=12){const batch=data.cases.slice(i,i+12),evidence=new Map(batch.map(c=>[c.id,{content:c.source}]));
      const checked=await checkSupportStatements(batch.map(c=>({sentence:c.claim,refs:[c.id]})),{evidence,userId,answerProvider:{model:answerModel}});
      llmCalls+=checked.summary.llmCalls||0;batch.forEach((c,n)=>results.push({id:c.id,expected:c.expected,...checked.support[n],audit:checked.summary}));}
    return {...base,mode,llmCalls,metrics:supportMetrics(results),
      limitations:[humanReview.humanReviewed?'Human provenance is coordinator-attested; it is not cryptographic identity verification.':'AI-authored or fixture labels are not human review.', 'Unassessed cases are not passes. No entailment proof or calibrated probability.'],results};
  }
  validateRetrievalCases(data.cases);
  const [{initRag,ragStatus},{initKb},{initVector,vectorStatus},{retrieveAll,retrievalStatus}]=await Promise.all([import('../src/server/rag.mjs'),import('../src/server/kb.mjs'),import('../src/server/vector.mjs'),import('../src/server/retrieve.mjs')]);
  await initRag({mysqlReady:false});await initKb({mysqlReady:false});await initVector();const channels={};
  for(const [name,names]of Object.entries({paper:['paper'],kb:['kb'],vector:['vector'],fused:['paper','kb','vector']})){
    const rows=[];for(const c of data.cases){const result=await retrieveAll(c.question,{userId,k:5,channels:names,rewrite:false,...(c.docIds?{scopedDocIds:c.docIds}:{})});rows.push({id:c.id,expectedRefs:c.expectedRefs,expectInsufficient:c.expectInsufficient===true,weak:result.weak,results:result.results.map(r=>({ref:r.ref,channels:r.channels})),diagnostics:result.channels});}
    channels[name]={metrics:retrievalMetrics(rows),rows};
  }
  return {...base,mode,configuration:{corpus:ragStatus(),vector:vectorStatus(),retrieval:retrievalStatus()},channels,limitations:['Draft or fewer than 100 human-reviewed cases cannot establish promotion. Corpus and model versions must match comparisons.']};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const arg=name=>{const i=process.argv.indexOf(name);return i<0?'':process.argv[i+1];};
  evaluate({casesPath:arg('--cases'),expectedSha:arg('--sha'),userId:arg('--user'),answerModel:arg('--answer-model'),mode:arg('--mode')||'retrieval'}).then(async report=>{
    const output=arg('--output');if(!output)throw new Error('--output is required');
    if(path.resolve(output)===path.resolve(arg('--cases'))||/(?:^|[\\/])(?:formal-cases|holdout)\.json$/i.test(output))throw new Error('Frozen/input cases are read-only');
    await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true});await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({output,metrics:report.metrics,llmCalls:report.llmCalls,promotable:report.promotable}));
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
