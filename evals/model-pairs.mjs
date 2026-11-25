/** Compare explicitly supplied, sanitized benchmark snapshots offline. One fork per task. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { digest } from './annotation-workflow.mjs';

const sha256 = /^[a-f0-9]{64}$/;
const metrics = ['toolCallCorrect', 'structuredOutputValid', 'citationCorrect', 'taskSuccess', 'latencyMs', 'costUSD'];
const requiredDigest = v => { if (typeof v !== 'string' || !sha256.test(v)) throw Error('missing_condition_digest'); return v; };
const validators = new Ajv({ strict: true });
const incompleteTurn = turn => !turn || !['user','assistant','system','tool','developer'].includes(turn.role)
  || Object.hasOwn(turn, 'truncatedChars') || turn.multimodalOmitted === true;
function validatePacket(packet) {
  if (packet?.schema !== 'zhiheng/model-pair/1' || !['public_benchmark','synthetic_fixture'].includes(packet.kind)
      || !packet.model?.id || !packet.model.version || !packet.model.runtimeVersion || !Array.isArray(packet.cases) || !packet.cases.length) throw Error('invalid_benchmark_packet');
  requiredDigest(packet.suiteSha256);
  const cases = new Map();
  for (const row of packet.cases) {
    if (typeof row.caseId !== 'string' || !row.caseId || cases.has(row.caseId)) throw Error('duplicate_or_invalid_case');
    const capture = row.capture;
    if (capture?.exactCalls !== true || capture.truncated !== false || capture.redacted !== false || row.snapshot?.messages?.some(incompleteTurn)) {
      cases.set(row.caseId, { row, prestate: null });
      continue;
    }
    if (!Array.isArray(row.snapshot?.messages) || !row.snapshot.messages.length || !Array.isArray(row.snapshot.tools)
        || !row.rubric || typeof row.rubric !== 'object' || Array.isArray(row.rubric)) throw Error('exact_snapshot_and_rubric_required');
    // Hash all messages and tool schemas, not just the system prompt. The fixture digest
    // binds external tool results, user/workspace, grants, corpus, and pending approvals.
    const prestate = digest({ messages: row.snapshot.messages, tools: row.snapshot.tools, fixture: requiredDigest(row.fixtureSha256),
      conditions: requiredDigest(row.conditionsSha256), rubric: row.rubric });
    cases.set(row.caseId, { row, prestate });
  }
  return cases;
}

function score(row) {
  const answers = row.snapshot.response, out = {};
  const observedAnswer = answers?.role === 'assistant' && (typeof answers.content === 'string' || Array.isArray(answers.tool_calls));
  const incompleteAnswer = answers && (Object.hasOwn(answers, 'truncatedChars') || answers.multimodalOmitted === true);
  if (Array.isArray(row.rubric.expectedCalls) && !incompleteAnswer && (observedAnswer || row.snapshot.error)) {
    try {
      const calls = (answers?.tool_calls ?? []).map(c => ({ name: c.function.name, arguments: JSON.parse(c.function.arguments) }));
      out.toolCallCorrect = !!answers && !row.snapshot.error && digest(calls) === digest(row.rubric.expectedCalls);
    } catch { out.toolCallCorrect = false; }
  }
  if (row.rubric.responseSchema && !incompleteAnswer && (observedAnswer || row.snapshot.error)) {
    const validate = validators.compile(row.rubric.responseSchema);
    try { out.structuredOutputValid = !row.snapshot.error && validate(JSON.parse(answers?.content)); }
    catch { out.structuredOutputValid = false; }
  }
  for (const field of ['citationCorrect','taskSuccess']) {
    const observation = row.observations?.[field];
    if (observation == null) continue;
    requiredDigest(observation.evidenceSha256);
    if (typeof observation.value !== 'boolean') throw Error('invalid_graded_outcome');
    out[field] = observation.value;
  }
  for (const field of ['latencyMs','costUSD']) {
    const n = row.observations?.[field];
    if (n == null) continue;
    if (!Number.isFinite(n) || n < 0) throw Error('invalid_measurement');
    out[field] = n;
  }
  return out;
}

export function compareModelPairs(baseline, candidate) {
  const left = validatePacket(baseline), right = validatePacket(candidate);
  if (baseline.suiteSha256 !== candidate.suiteSha256 || baseline.kind !== candidate.kind) throw Error('incompatible_benchmark_packets');
  const counts = Object.fromEntries(metrics.map(m => [m, { paired: 0, baselineSum: 0, candidateSum: 0 }]));
  const excluded = { missingLeft: 0, missingRight: 0, incompleteCapture: 0, differentState: 0 };
  let matched = 0;
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(key), b = right.get(key);
    if (!a) { excluded.missingLeft++; continue; }
    if (!b) { excluded.missingRight++; continue; }
    if (!a.prestate || !b.prestate) { excluded.incompleteCapture++; continue; }
    if (a.prestate !== b.prestate) { excluded.differentState++; continue; }
    matched++;
    const first = score(a.row), second = score(b.row);
    for (const metric of metrics) {
      if (first[metric] == null || second[metric] == null) continue;
      const totals = counts[metric]; totals.paired++; totals.baselineSum += Number(first[metric]); totals.candidateSum += Number(second[metric]);
    }
  }
  const means = Object.fromEntries(Object.entries(counts).map(([metric, c]) => [metric, { paired: c.paired,
    baselineMean: c.paired ? c.baselineSum / c.paired : null, candidateMean: c.paired ? c.candidateSum / c.paired : null }]));
  const modelMetadata = p => ({ id: p.model.id, version: p.model.version, runtimeVersion: p.model.runtimeVersion,
    declaredCapabilities: p.model.declaredCapabilities?.features ?? null, contractMeasuredAt: p.model.contractMeasuredAt ?? null });
  let status = 'no_matched_states';
  if (matched) status = Object.values(counts).some(c => c.paired) ? 'compared' : 'no_paired_observations';
  return { schema: 'zhiheng/model-pair-report/1', kind: baseline.kind, status,
    models: [baseline, candidate].map(modelMetadata), inputDigests: [digest(baseline), digest(candidate)],
    matched, excluded, metrics: means, newModelCalls: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [left, right, out] = process.argv.slice(2);
  if (!left || !right || !out) throw Error('usage: node evals/model-pairs.mjs BASE.json CANDIDATE.json NEW_REPORT.json');
  const read = async file => {
    const raw = await fs.readFile(file, 'utf8');
    try { return JSON.parse(raw); } catch { throw Error('invalid_benchmark_packet_json'); }
  };
  const report = compareModelPairs(await read(left), await read(right));
  await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, matched: report.matched, excluded: report.excluded }));
}
