import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalAnswer } from '../src/server/local-answer-check.mjs';
const evidence = new Map([['fixture', { content: 'A fixture sentence supplies a literal quotation.' }]]);
const aliases = new Map([['S1', 'fixture']]);
const check = question => checkLocalAnswer({ answer: '这是简短转述。[[S1]]', question, evidence, aliases }).issues;

test('用户明确不要逐字引语时，交付修复不能强迫相反的格式', () => {
  for (const question of ['不要引用原文，只做转述。', '无需逐字引用，请简述。', '不必附一段原文。',
    '请不要给出一段原文。', '不需要大段引用原文。', '禁止直接引用原文。', '避免逐字引用，保留来源编号。',
    '引用原文是不需要的。', '不要作任何形式的逐字引用。', '不要展开解释，只需引用原文。']) {
    assert.deepEqual(check(question), [], question);
  }
});

test('合法的 Markdown 引语和前置来源编号不会触发无谓修复', () => {
  for (const answer of ['[[S1]] “A fixture sentence supplies a literal quotation.”',
    '> A fixture sentence supplies a literal quotation. [[S1]]',
    '> A fixture sentence supplies a literal quotation.\n\n[[S1]]',
    '[[S1]]\n> A fixture sentence supplies a literal quotation.',
    '> [[S1]] A fixture sentence supplies a literal quotation.']) {
    const result = checkLocalAnswer({ answer, question: '请引用原文。', evidence, aliases });
    assert.deepEqual(result.issues, [], answer); assert.equal(result.semanticSupportVerified, false);
  }
  const unrelated = checkLocalAnswer({ answer: '[[S1]]\n另一句话。\n> A fixture sentence supplies a literal quotation.', question: '请引用原文。', evidence, aliases });
  assert.deepEqual(unrelated.issues, ['requested_exact_quote_missing']);
});

test('其他对象的否定不取消正向引文要求；不同句的实际引文要求仍保留', () => {
  for (const question of ['不要长篇解释；请引用原文。', '请附一段原文。', '不要引用原文中的表格；请附一段原文解释。']) {
    assert.deepEqual(check(question), ['requested_exact_quote_missing'], question);
  }
});
