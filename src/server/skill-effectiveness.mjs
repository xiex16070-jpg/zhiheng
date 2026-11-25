import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { listSkills } from './skills.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';

function filename(userId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(userId)) || userId === '_global') throw new Error('invalid_user');
  return path.join(config.dataDir, 'skill-outcomes', userId + '.json');
}
async function readOutcomes(userId) {
  try { const text = await fs.readFile(filename(userId), 'utf8'); if (text.length > 2_000_000) throw new Error('skill_outcome_limit'); const rows = JSON.parse(text); if (!Array.isArray(rows)) throw new Error('invalid_skill_outcomes'); return rows; }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}
/** Only record actual injected/read skills and terminal task outcomes; no question, response, or document text. */
export async function recordSkillOutcome(userId, { taskId, skills = [], status, reason = '' }) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(taskId)) || !['done','error','cancelled'].includes(status)) throw new Error('invalid_skill_outcome');
  const names = [...new Set(skills.map(s => typeof s === 'string' ? s : s.name))].filter(s => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s)).slice(0, 30);
  await withFileLock(filename(userId), async () => {
    const rows = await readOutcomes(userId);
    if (rows.some(r => r.taskId === taskId)) return;
    rows.push({ taskId, skills: names, status, reason: /^[a-z0-9_-]{0,60}$/.test(reason) ? reason : '', at: new Date().toISOString() });
    await writeJsonAtomic(filename(userId), rows.slice(-1000), { mode: 0o600 });
  });
}
export function summarizeSkillEffectiveness(skills, outcomes) {
  return skills.map(skill => {
    const used = outcomes.filter(r => r.skills?.includes(skill.name));
    const finished = used.filter(r => ['done','error'].includes(r.status)), failed = finished.filter(r => r.status === 'error').length;
    const failureRate = finished.length ? failed / finished.length : null;
    return { name: skill.name, description: skill.description, scope: skill.scope, pinned: skill.pinned,
      use_count: used.length, completed_tasks: finished.length, failed_tasks: failed, cancelled_tasks: used.length - finished.length, failure_rate: failureRate,
      evidence: finished.length < 5 ? 'insufficient' : 'observational', recommendation: finished.length >= 5 && failureRate >= 0.6 && !skill.pinned ? 'review' : 'keep' };
  }).sort((a,b) => b.use_count - a.use_count || a.name.localeCompare(b.name));
}
export async function skillEffectivenessReport(userId) {
  const outcomes = await readOutcomes(userId);
  return { generatedAt: new Date().toISOString(), tasks: outcomes.length, window: 1000,
    note: '只统计启用本记录功能后当前用户的实际任务。失败率是相关性，不能证明技能导致失败；少于五个完成样本不建议归档。',
    skills: summarizeSkillEffectiveness(await listSkills({ userId }), outcomes) };
}
