import test from 'node:test';
import assert from 'node:assert/strict';
import { executionPhase, executionPhaseSummary, executionStepHtml } from '../src/ui/execution-visuals.js';
import { disclosureSummary } from '../src/ui/disclosure.js';

test('execution phases reflect recorded operations and preserve failures and approvals', () => {
  assert.equal(executionPhase({name:'reason#3'}), 'reasoning');
  assert.equal(executionPhase({name:'tool:search_knowledge',detail:{tool:'search_knowledge'}}), 'retrieval');
  assert.equal(executionPhase({name:'tool:logic_run_assumptions',detail:{tool:'logic_run_assumptions'}}), 'reasoning');
  assert.equal(executionPhase({name:'inference_audit'}), 'review');
  for (const [statuses, state, index] of [
    [['ok','error'], 'error', 1], [['running','waiting'], 'paused', 1],
    [['ok','running','error'], 'running', 1], [['ended','returned'], 'ok', 0],
  ]) {
    const steps = statuses.map(status => ({ status }));
    assert.deepEqual(executionPhaseSummary(steps), { state, step: steps[index] });
  }
});

test('visuals show measured zero counts, partial paths and selected branches without inventing scores', () => {
  const html = executionStepHtml({name:'research_tot',detail:{searches:2,evaluated:1,selected:[1],stop:'search_unavailable',process:[
    {id:1,parent:null,depth:1,hits:0,score:0}, {id:2,parent:1,depth:2,status:'error'},
  ]}});
  assert.match(html, /命中 0 条/);
  assert.match(html, /相关性 0\.00/);
  assert.match(html, /检索未完成/);
  assert.match(html, /data-selected="true"/);
  assert.match(html, /追加检索未完成/);
  assert.match(html, /不表示结论正确的概率/);
  assert.doesNotMatch(executionStepHtml({name:'research_tot',detail:{}}), /相关性|命中 \d/);
});

test('step presentation omits private reasoning and escapes untrusted text', () => {
  const html = executionStepHtml({name:'retrieve',detail:{hits:0,summary:'<img src=x onerror=alert(1)>',
    reasoning:'PRIVATE_REASONING',channels:[{name:'<svg/onload=alert(2)>',hits:3}]}});
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;svg/);
  assert.doesNotMatch(html, /<img|<svg\/onload|PRIVATE_REASONING/);
  assert.match(disclosureSummary('<b>审核</b>', {meta:'<script>1</script>'}), /&lt;b&gt;/);
  assert.doesNotMatch(disclosureSummary('审核'), /\sopen(?:\s|=|>)/);
});
