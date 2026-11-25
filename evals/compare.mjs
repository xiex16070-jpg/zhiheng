import fs from 'node:fs/promises';
const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw new Error('usage: node evals/compare.mjs baseline.json experiment.json');
const [before, after] = await Promise.all([beforeFile, afterFile].map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));
for (const key of ['mode', 'corpusSha256', 'casesSha256', 'model', 'judge']) {
  if (before[key] !== after[key]) throw new Error(`not comparable: ${key} differs`);
}
const summarize = (report) => {
  const rows = report.summary.results || [];
  const scores = {};
  for (const row of rows) for (const [key, score] of Object.entries(row.namedScores || row.gradingResult?.namedScores || {})) {
    if (!Number.isFinite(score)) continue;
    (scores[key] ||= []).push(score);
  }
  return { stats: report.summary.stats, total: rows.length, scores: Object.fromEntries(Object.entries(scores).map(([k, v]) =>
    [k, { mean: v.reduce((a, b) => a + b, 0) / v.length, measured: v.length, total: rows.length }])) };
};
const a = summarize(before), b = summarize(after);
const keys = new Set([...Object.keys(a.scores), ...Object.keys(b.scores)]);
const delta = {};
for (const key of keys) {
  const x = a.scores[key], y = b.scores[key];
  // Never turn a missing/failed measurement into an apparent quality gain.
  delta[key] = x && y && x.measured === y.measured && a.total === b.total ? y.mean - x.mean : null;
  if (key === 'claim_support' && (!before.semanticSupportMeasured || !after.semanticSupportMeasured)) delta[key] = null;
}
console.log(JSON.stringify({ before: a, after: b, delta }, null, 2));
