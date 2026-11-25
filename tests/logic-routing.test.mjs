import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {detectLogicIntent,prepareLogicProposal} from '../src/server/logic-routing.mjs';
import {parseProgram,runProgram} from '../src/logic/hanlogic.mjs';
import {formatProgram} from '../src/logic/format.mjs';
test('deterministic intent routing distinguishes rule questions, ordinary work and explicit source',()=>{
  for(const question of ['若完成测试则可以交付，完成测试了，能否推出可以交付？','只有审批通过才允许执行，已经执行，是否获得审批？','如果出现例外就取消资格，能不能推出资格成立？'])assert.equal(detectLogicIntent(question).detected,true);
  for(const question of ['请打开网站','解释只有……才……的含义','事实 完成(甲)。\n查询 完成(甲)。','如果文件太长就分段写入'])assert.equal(detectLogicIntent(question).detected,false);
  assert.throws(()=>prepareLogicProposal({program:'事实 P(甲)。',mode:'assumptions'}),{code:'logic_query_required'});
  assert.throws(()=>prepareLogicProposal({program:'规则 错误：若 P(?甲) 则 Q(?乙)。查询 Q(甲)。',mode:'assumptions'}),{code:'unsafe_rule'});
});
test('200 seeded legal programs round-trip through canonical source with identical four-valued outcomes',async()=>{
  let seed=613;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  for(let n=0;n<200;n++){
    const flags=random(),a='对象'+n,b='对象'+(n+1);
    const source=[`事实 P(${a})。`,...(flags&1?[`事实 非 P(${a})。`]:[]),`事实 R(${b})。`,
      '规则 传递：若 P(?对象) 且 (R(?另一个) 或 P(?另一个)) 则 Q(?对象)。',
      ...(flags&2?['规则 必要：只有 P(?对象) 才 Q(?对象)。']:[]),
      `查询 P(${a})。`,`查询 Q(${a})。`,`查询 Q(未知对象)。`].join('\n');
    const canonical=formatProgram(parseProgram(source));
    assert.equal(formatProgram(parseProgram(canonical)),canonical);
    assert.deepEqual(runProgram(canonical).queries.map(q=>q.status),runProgram(source).queries.map(q=>q.status));
    assert.equal(prepareLogicProposal({program:canonical,mode:'assumptions'}).queries,3);
  }
  const grammar=await fs.readFile(new URL('../src/logic/hanlogic.gbnf',import.meta.url),'utf8');
  assert.match(grammar,/root ::= ws statement\+ ws/);assert.match(grammar,/ground-atom ::=/);
  // Native llama.cpp grammar validation is an integration check, not asserted by
  // this parser/formatter test. The checked-in grammar is a canonical subset.
});
