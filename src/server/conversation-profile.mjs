import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_RE } from './auth.mjs';
import { config } from './config.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';

// Only these presentation preferences and study topics may enter a later prompt.
// The matcher never copies arbitrary text from a question, document or model answer.
export const profileFields = {
  language: { label: '回答语言', choices: ['中文', '英文', '中英双语'] },
  format: { label: '讲解方式', choices: ['先举例', '先给结论', '分步说明', '分点列出', '用表格对比'] },
  depth: { label: '讲解深度', choices: ['简明概括', '详细解释', '从基础讲起'] },
  topic: { label: '关注方向', choices: ['形式逻辑', '命题逻辑', '数理逻辑', '程序验证', '形式化方法', '算法', '机器学习', '人工智能', '计算机科学'] },
};

const presentation = [
  ['language', '中文', /^(?:用)?(?:中文|汉语)(?:作答|回答|讲解|解释)?$/u],
  ['language', '英文', /^(?:用)?(?:英文|英语)(?:作答|回答|讲解|解释)?$/u],
  ['language', '中英双语', /^(?:用)?(?:中英双语|中英文对照)(?:作答|回答|讲解|解释)?$/u],
  ['format', '先举例', /^先(?:给(?:出)?|举)(?:一?个)?(?:具体)?(?:例子|示例|实例|例)(?:再(?:解释|讲解|讲原理))?$/u],
  ['format', '先给结论', /^先(?:给(?:出)?|说)(?:结论|答案)$/u],
  ['format', '分步说明', /^(?:分步|逐步|一步一步|按步骤)(?:说明|回答|解释|讲解|分析)$/u],
  ['format', '分点列出', /^(?:分点|按要点)(?:列出|说明|回答|讲解)?$/u],
  ['format', '用表格对比', /^(?:用)?表格(?:对比|比较|展示|对照)$/u],
  ['depth', '简明概括', /^(?:简洁|简短|简明)(?:的)?(?:回答|解释|概括)?$/u],
  ['depth', '详细解释', /^(?:详细|细致)(?:的)?(?:回答|解释|讲解|说明)?$/u],
  ['depth', '从基础讲起', /^(?:从基础|从头|从零)(?:开始讲解|开始|讲起)$/u],
];

export function statedPreferences(question) {
  const text = String(question ?? '').trim();
  // Treat examples, quoted dialogue and hypothetical/negated preference statements conservatively.
  if (/(?:不是我(?:的)?(?:偏好|观点)|(?:请勿|不要|别|不用)(?:记住|记录|保存)|(?:开玩笑|只是举例))/u.test(text)) return {};
  const found = {};
  for (const [, part, delimiter] of text.matchAll(/([^。；;！!？?，,\n]+)([。；;！!？?，,\n]|$)/gu)) {
    let statement = part.trim();
    if (!statement) continue;
    // Everything after an attribution, pasted material, hypothetical, or a
    // one-off qualifier can belong to that passage (including later lines).
    if (/[:：“”「」『』"'<>》《`]|^(?:>|如果|假[如设装]|例如|比如|示例|本次|本题|这次|临时|仅这次)|(?:引用|举例来说|转述|原文如下|请翻译|请润色|请改写|[他她]说|老师[说问])/u.test(statement)) break;
    if (/[？?]/u.test(delimiter)) continue;
    const withdraw = /^我不再(?:研究|学习|关注|偏好|喜欢|习惯)/u.test(statement);
    if (withdraw) statement = statement.replace(/^我不再/u, '我');
    const subject = /^(?:我的(?:主要)?研究方向是|我(?:主要|目前主要|长期|正在)?(?:研究|关注|学习))(.+)$/u.exec(statement);
    if (subject && profileFields.topic.choices.includes(subject[1])) {
      found.topic = { value: subject[1], withdraw };
      continue;
    }
    const preference = /^(?:我(?:通常|一直|一般|更)?(?:偏好|喜欢|习惯)|(?:今后|以后|往后)(?:请)?(?:都)?|我希望(?:今后|以后)(?:都)?)(.+)$/u.exec(statement);
    const match = preference && presentation.find(([, , pattern]) => pattern.test(preference[1]));
    if (match) found[match[0]] = { value: match[1], withdraw };
  }
  return found;
}

function profileFile(userId) {
  if (!ID_RE.test(String(userId || ''))) throw new Error('invalid_user');
  return path.join(config.dataDir, 'memory', userId, 'profile.json');
}

async function load(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (err) {
    if (err.code === 'ENOENT') return { enabled: true, revision: 0, manualAt: 0, entries: {} };
    throw err;
  }
  const state = JSON.parse(raw);
  if (!Number.isSafeInteger(state.revision) || typeof state.enabled !== 'boolean' || !state.entries ||
      !Object.entries(state.entries).every(([key, row]) => Object.hasOwn(profileFields, key) && profileFields[key].choices.includes(row?.value))) {
    throw new Error('invalid_profile');
  }
  return state;
}

export const readProfile = userId => load(profileFile(userId));

export async function editProfile(userId, change) {
  const file = profileFile(userId);
  return withFileLock(file, async () => {
    const state = await load(file);
    if (change?.revision !== state.revision) return { ok: false, code: 'conflict' };
    const now = Date.now();
    if (typeof change.enabled === 'boolean' && change.field === undefined) state.enabled = change.enabled;
    else if (Object.hasOwn(profileFields, change.field) &&
             (change.value === null || profileFields[change.field].choices.includes(change.value))) {
      if (change.value === null) delete state.entries[change.field];
      else state.entries[change.field] = { value: change.value, at: now, source: 'manual' };
    } else return { ok: false, code: 'invalid_profile_change' };
    state.revision++;
    state.manualAt = now;
    await writeJsonAtomic(file, state);
    return { ok: true };
  });
}

export async function profileForTurn(userId, question, receivedAt) {
  const file = profileFile(userId);
  const facts = receivedAt ? statedPreferences(question) : {};
  const state = await withFileLock(file, async () => {
    const state = await load(file);
    if (!state.enabled || !(receivedAt > state.manualAt)) return state;
    let changed = false;
    for (const [key, { value, withdraw }] of Object.entries(facts)) {
      const previous = state.entries[key];
      if (previous && previous.at >= receivedAt) continue;
      if (withdraw) {
        if (previous?.value !== value) continue;
        delete state.entries[key];
        state.manualAt = Math.max(state.manualAt, receivedAt);
      } else {
        state.entries[key] = { value, source: previous?.value === value ? previous.source : 'chat', at: receivedAt };
      }
      changed = true;
    }
    if (changed) { state.revision++; await writeJsonAtomic(file, state); }
    return state;
  });
  if (!state.enabled) return '';
  const notes = Object.entries(state.entries).map(([key, row]) => `${profileFields[key].label}为${row.value}`);
  return notes.length ? `跨会话画像（仅供组织表达，本次显式设置与要求优先）：${notes.join('，')}。` : '';
}
