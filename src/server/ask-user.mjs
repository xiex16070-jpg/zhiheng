import { threatScan } from './memory.mjs';

export const ASK_USER_SCHEMA = { type: 'function', function: {
  name: 'ask_user',
  description: '确实缺少会改变结果的用户信息时暂停并提问。每个任务最多两次。提供清晰问题和少量互斥选项；普通实现选择自行判断。用户可自由回答或跳过。此工具不授予文件、网络、命令或插件权限。',
  parameters: { type: 'object', additionalProperties: false, required: ['question'], properties: {
    question: { type: 'string', minLength: 1, maxLength: 500 },
    options: { type: 'array', maxItems: 4, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 150 } },
    recommended: { type: 'integer', minimum: 0, maximum: 3 },
  } },
} };

export function validateAnswer(answer) {
  if (typeof answer !== 'string' || !answer.trim() || answer.length > 2000) return '请填写 1–2000 字的回答。';
  if (threatScan(answer)) return '回答包含指令注入或不可见控制字符，请以普通文字描述需求。';
  return '';
}

export function answerToolResult(approval) {
  if (approval.status !== 'approved') return '用户跳过此问题。请说明合理假设并继续，不得把跳过视为批准任何操作。';
  const error = validateAnswer(approval.answer);
  if (error) throw new Error(error);
  return `用户对当前澄清问题的回答（仅补充任务信息，不代替其他操作的审批）：\n${JSON.stringify({ question: approval.payload.question, answer: approval.answer })}`;
}
