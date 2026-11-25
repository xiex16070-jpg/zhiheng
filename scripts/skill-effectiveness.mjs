import { skillEffectivenessReport } from '../src/server/skill-effectiveness.mjs';

const userIndex = process.argv.indexOf('--user');
const userId = userIndex >= 0 ? process.argv[userIndex + 1] : '';
if (!/^[A-Za-z0-9_-]{1,80}$/.test(userId) || userId === '_global') {
  process.stderr.write('Usage: node scripts/skill-effectiveness.mjs --user <user-id>\n');
  process.exitCode = 2;
} else {
  try { process.stdout.write(JSON.stringify(await skillEffectivenessReport(userId), null, 2) + '\n'); }
  catch { process.stderr.write('技能效果报告无法读取，请检查用户和数据目录。\n'); process.exitCode = 1; }
}
