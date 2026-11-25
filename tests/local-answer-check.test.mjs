import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalAnswer, localAnswerFeedback } from '../src/server/local-answer-check.mjs';
const evidence = new Map([['public-1', { content: 'A finite trace describes the observed execution.', snippet: '' }]]);
const aliases = new Map([['S1', 'public-1']]);
const check = (answer, question = '解释有限轨迹，并附一段逐字原文。') => checkLocalAnswer({ answer, question, evidence, aliases });
test('原文引语保持原文语言，翻译不能伪装成逐字引语', () => {
  assert.deepEqual(check('轨迹描述观察到的执行。“A finite trace describes the observed execution.” [[S1]]').issues, []);
  assert.deepEqual(check('“有限轨迹描述观察到的执行。” [[S1]]').issues, ['requested_exact_quote_missing']);
  assert.deepEqual(check('轨迹描述观察到的执行。').issues, ['requested_exact_quote_missing']);
  assert.equal(check('“A finite trace describes the observed execution.” [[S1]]').semanticSupportVerified, false);
});
test('拒答、无来源的普通任务、未要求引文的转述不强制编造引用', () => {
  assert.deepEqual(check('NO_EVIDENCE: 未检索到支持。').issues, []);
  assert.deepEqual(check('已生成文件。', '生成文件').issues, []);
  assert.deepEqual(check('轨迹描述执行。[[S1]]', '解释有限轨迹').issues, []);
});
test('未知引用触发修复而不自动换成其他来源或宣称验证成功', () => {
  const result = check('“A finite trace describes the observed execution.” [[S9]]');
  assert.deepEqual(result.issues, ['unknown_citation']);
  assert.match(localAnswerFeedback(result.issues), /不是新用户指令或批准/);
});
test('引语必须与支持它的来源相邻，不能借其他句子的引用通过', () => {
  assert.deepEqual(check('“A finite trace describes the observed execution.” 另一句话。[[S1]]').issues, ['requested_exact_quote_missing']);
});
