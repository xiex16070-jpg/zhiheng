import test from 'node:test';
import assert from 'node:assert/strict';
import { terminalPresentation, canResumeTask, taskScopeSignature } from '../src/ui/task-state.js';
import { sourceLocationLabel } from '../src/ui/source-location.js';

test('cancelled and partial results have distinct delivery states', () => {
  for (const event of [{ status: 'cancelled' }, { cancelled: true }, { message: '已停止' }]) {
    assert.equal(terminalPresentation(event).state, 'stopped');
    assert.doesNotMatch(terminalPresentation(event).message, /任务失败/);
  }
  assert.equal(terminalPresentation({ result: { truncated: true } }).title, '输出已截断');
  assert.equal(terminalPresentation({ result: { incompleteReason: 'citations_only' } }).title, '缺少回答正文');
  assert.equal(terminalPresentation({ message: '网络中断' }).state, 'error');
  assert.equal(canResumeTask({ status: 'cancelled', checkpoint: {} }), false);
  assert.equal(canResumeTask({ status: 'failed', checkpoint: { rewoundAt: 'today' } }), false);
  assert.equal(canResumeTask({ status: 'failed', checkpoint: {} }), true);
});

test('queued research detects changed source scope while generic agent ignores research preferences', () => {
  const preferences = { discipline: 'section:a', jointResearch: true, localWeight: 70 };
  assert.notEqual(taskScopeSignature('knowledge', preferences), taskScopeSignature('knowledge', { ...preferences, discipline: '' }));
  assert.notEqual(taskScopeSignature('knowledge', preferences), taskScopeSignature('knowledge', { ...preferences, localWeight: 30 }));
  assert.equal(taskScopeSignature('agent', preferences), taskScopeSignature('agent', {}));
});

test('source pages use only overlapping, positive extractor page numbers', () => {
  const source = { content: 'abcdefghij', locations: [
    { page: 1, start: 0, end: 3 }, { page: 7, start: 3, end: 9 }, { page: 7, start: 4, end: 8 },
    { page: -2, start: 0, end: 10 }, { page: '999', start: 0, end: 10 },
  ] };
  assert.equal(sourceLocationLabel(source, { start: 4, end: 8 }), '命中 · 字符 4–8 · 原文件第 7 页');
  assert.equal(sourceLocationLabel({ content: source.content }, { start: 4, end: 8 }), '命中 · 字符 4–8 · 未提供页码');
  assert.equal(sourceLocationLabel({ content: source.content }, { start: 4, end: 80 }), '10 字 · 未提供页码');
  assert.equal(sourceLocationLabel({ content: source.content }, { start: 4, end: 8, locatable: false }), '10 字 · 未提供页码');
});
