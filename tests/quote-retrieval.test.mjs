import test from 'node:test';
import assert from 'node:assert/strict';

import { locateNormalizedQuote, auditAttributedQuotes } from '../src/server/quote.mjs';
import { charCoverage } from '../src/server/rag.mjs';
import { __test as vectorTest } from '../src/server/vector.mjs';

test('引文规范化命中仍返回原文中的真实偏移与真实字面', () => {
  const source = '前文\n他说：“知识  图谱”能够提升检索。\n后文';
  const r = locateNormalizedQuote(source, '"知识图谱"能够提升检索', { minLength: 6 });
  assert.equal(r.found, true);
  assert.equal(source.slice(r.start, r.end), r.quote);
  assert.equal(r.quote, '“知识  图谱”能够提升检索');
  assert.ok(r.start > 0, '规范化命中不能伪造为 0 偏移');
});

test('过短引文即使逐字存在也拒绝，避免无意义校验', () => {
  assert.deepEqual(
    locateNormalizedQuote('甲乙丙丁', '甲', { minLength: 4 }),
    { found: false, reason: 'quote_too_short' }
  );
});

test('文献推理的明确引语绑定到相邻来源，区分真实原话、转述与仅规范化匹配', () => {
  const real = '正规式和值实际上是同一个东西';
  const invented = '这两种定义确实是等价的';
  const evidence = new Map([
    ['1954685090086', { content: '两种表示可以相互转化。' }],
    ['164589955219155', { content: '本节说明了：' + real + '。' }],
    ['sample', { snippet: '📚𠀀 甲 乙 丙 丁 戊 己 庚。' }],
  ]);
  const answer = `因为[[1954685090086]]中‘${invented}’。因为[[164589955219155]]中‘${real}’。
原文写道“${real}”[[1954685090086]]、[[164589955219155]]。作者称：“𠀀甲乙丙丁戊己庚”[[sample]]。`;
  const audit = auditAttributedQuotes(answer, evidence);
  assert.deepEqual(audit.checks.map(c => c.status), ['unmatched', 'exact', 'exact', 'normalized']);
  assert.equal(audit.limited, false);
  for (const check of audit.checks) assert.equal(answer.slice(check.start, check.end), check.quote);
  const multiple = audit.checks[2];
  assert.deepEqual(multiple.refs, ['1954685090086', '164589955219155']);
  assert.equal(multiple.match.ref, '164589955219155');
  const { ref, field, start, end } = audit.checks[3].match;
  assert.equal(evidence.get(ref)[field].slice(start, end), '𠀀 甲 乙 丙 丁 戊 己 庚');
});

test('不推测引语归属，不扫描代码或术语；没有取到原文和用尽预算都不报作反证', () => {
  const line = '原文写道“这段是有明确归属的原话”[[a]]';
  const ignored = [
    '`' + line + '`', '```txt', line, '```', '~~~', line, '~~~',
    '    ' + line, '这可以理解成“这段是有明确归属的原话”[[a]]',
    '[[a]]中“非确定性有限自动机”', '[[a]] 中“这段是有明确归属的原话”[[b]]',
  ].join('\n');
  assert.deepEqual(auditAttributedQuotes(ignored, new Map()).checks, []);
  assert.equal(auditAttributedQuotes(line, new Map()).checks[0].status, 'unchecked');
  const capped = auditAttributedQuotes(Array(15).fill(line).join('\n'), new Map([['a', { snippet: '本段讨论的是其他内容' }]]));
  assert.equal(capped.checks.length, 12);
  assert.equal(capped.limited, true);
});

test('英文检索覆盖率按词计算，不再无条件视为 100%', () => {
  assert.equal(charCoverage('graph neural network', 'A graph model with a neural encoder.'), 2 / 3);
  assert.equal(charCoverage('graph neural network', 'unrelated text'), 0);
  assert.equal(charCoverage('---', 'anything'), 0);
});

test('不同维度的向量不做截断余弦，直接判为不可比', () => {
  assert.equal(vectorTest.cosine([1, 2], [1]), -1);
  assert.equal(vectorTest.cosine([1, 0], [1, 0]), 1);
});
