import test from 'node:test';
import assert from 'node:assert/strict';
import { statedPreferences } from '../src/server/conversation-profile.mjs';

test('提问、寒暄与多项明确自述可以共存，不推断未说明的身份或兴趣', () => {
  assert.deepEqual(statedPreferences('你好，我主要研究程序验证。我更喜欢先给一个例子。什么是循环不变式？'), {
    topic: { value: '程序验证', withdraw: false }, format: { value: '先举例', withdraw: false },
  });
  assert.deepEqual(statedPreferences('什么是SAT？我偏好用中文回答。'), { language: { value: '中文', withdraw: false } });
  assert.deepEqual(statedPreferences('我不再喜欢先给一个例子。'), { format: { value: '先举例', withdraw: true } });
});

test('引用、假设、否定、提问和本题格式不写入画像', () => {
  for (const text of ['我更喜欢先给一个例子吗？', '老师问：我喜欢先举例吗？', '示例：\n我主要研究形式逻辑。',
    '“我更喜欢先给结论。”', '请翻译以下文字。\n我主要研究算法。', '假如我研究算法，我喜欢先给结论。',
    '请分步说明。', '我不喜欢分步说明。', '这次，我喜欢先给结论。', '我偏好英文。请不要记录。',
    '我喜欢徒步。', '我主要研究敏感病历资料。', '什么是数理逻辑？']) {
    assert.deepEqual(statedPreferences(text), {}, text);
  }
});
