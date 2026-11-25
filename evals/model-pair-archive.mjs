/** Recompute a historical comparison from four fixed, content-reviewed Git blobs only. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';

const [lab, output] = process.argv.slice(2);
if (!lab || !output) throw Error('usage: node evals/model-pair-archive.mjs MODEL_LAB_CHECKOUT NEW_REPORT.json');
const revision = '6488fa195abb94975e0897bbba355add77aa4ef6', dir = 'reports/context-quality-20261107/';
const blob = file => execFileSync('git', ['-C', lab, 'show', revision + ':' + dir + file], { windowsHide: true });
const manifest = JSON.parse(blob('manifest.json'));
const files = [];
function read(name) {
  const file = name + '-20261107.json', entry = manifest.files.find(f => f.file === file);
  if (!entry || !['originalQuestionOrAnswerIncluded','documentBodyIncluded','credentialsFound'].every(k => entry.contentReview?.[k] === false)) throw Error('unreviewed_report');
  const bytes = blob(file), sha256 = createHash('sha256').update(bytes).digest('hex');
  if (entry.sha256 !== sha256) throw Error('archive_integrity_mismatch');
  files.push({ file, sha256 }); return JSON.parse(bytes);
}
const comparisons = read('context-base-v5-workflows20-comparison'), fixed = read('context-fixed32-comparison');
const contracts = ['base','v5'].map(variant => {
  const c = read('runtime-contract-' + variant);
  return { variant, model: c.model, profileSha: c.profileSha, adapterSha: c.adapterSha, observedAt: c.createdAt,
    runtime: c.runtime, declared: c.declaredCapabilities.features, measuredRequestContract: c.cases.map(({id, expectedStatus, status, passed}) =>
      ({ probe: id, expectedHTTP: expectedStatus, actualHTTP: status, matchesContract: passed })), generatedTokens: c.generatedTokens };
});
const { cases } = comparisons;
if (new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => c.before.id !== c.id || c.after.id !== c.id)) throw Error('unpaired_cases');
const workflows = ['before','after'].map(side => {
  const tally = field => cases.reduce((sum, c) => {
    const v = c[side][field]; if (typeof v !== 'boolean' && !Number.isFinite(v)) throw Error('missing_' + field);
    return sum + Number(v);
  }, 0);
  const totals = Object.fromEntries(['strictPassed','completed','modelCalls','toolCalls','executedToolEvents'].map(k => [k,tally(k)]));
  for (const key of Object.keys(totals)) if (totals[key] !== comparisons.metrics[key][side]) throw Error('archived_totals_disagree');
  return { ...comparisons.weights[side], ...totals, total: cases.length };
});
const {projectCommit, profileSha, datasetSha256, runtimeProfileSha256} = comparisons.matched;
const report = { schema: 'zhiheng/historical-model-comparison/1', sourceRevision: revision, files,
  mode: 'offline_reanalysis_of_prior_runs', newModelCalls: 0, conditions: { projectCommit, profileSha, datasetSha256, runtimeProfileSha256 },
  workflows, fixedSuite: { datasetSha256: fixed.evaluation_dataset_sha256, completed: fixed.metrics.completed_calls,
    score: fixed.metrics.contract_pass_rate, meanLatencyMs: fixed.metrics.mean_latency_ms }, contracts,
  exactDecisionPairs: null, semanticCitationAccuracy: null, billedCostUSD: null,
  limits: ['Public case summaries bind suite, framework and budgets. The archive has no matching step-input digests, paid API twin, or invoices.',
    'HTTP contract probes exercise parameter acceptance or rejection. They do not score generated JSON. Tool counts measure calls and events.',
    'RouteFM needs an independent router context/holdout split with comparable per-model score and cost. These reports do not provide it.'] };
await fs.writeFile(output, JSON.stringify(report,null,2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ workflows, fixed: report.fixedSuite, contractProbes: contracts.map(c => c.measuredRequestContract.length) }));
