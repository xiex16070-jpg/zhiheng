/** Offline annotation integrity. No network, model calls, or automatic model promotion. */
import { createHash, randomUUID, randomInt } from 'node:crypto';
import { isIP } from 'node:net';

export const LABELS = ['supported', 'contradicted', 'unsupported'];
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const required = (value, name, max = 10000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`invalid_${name}`);
  return value;
};
const date = value => { required(value, 'review_date', 80); if (!Number.isFinite(Date.parse(value))) throw new Error('invalid_review_date'); return value; };
const label = value => { const v = value === 'insufficient' ? 'unsupported' : value; if (!LABELS.includes(v)) throw new Error('invalid_verdict'); return v; };
const reviewerKey = id => id.normalize('NFKC').trim().toLowerCase();
const shuffled = values => { const result = [...values]; for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; } return result; };
const span = (text, value) => {
  if (!value || !Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start < 0 || value.end <= value.start || value.end > text.length)
    throw new Error('invalid_evidence_span');
  const quote = text.slice(value.start, value.end);
  if (value.text !== undefined && value.text !== quote) throw new Error('evidence_span_text_mismatch');
  // UTF-16 offsets, matching JavaScript source indexing. Never split a surrogate pair.
  if (/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(quote)) throw new Error('invalid_evidence_span_unicode');
  return { start: value.start, end: value.end, text: quote };
};
function publicSource(source) {
  if (source?.public !== true) throw new Error('public_source_declaration_required');
  const uri = new URL(required(source.uri, 'public_source_uri'));
  if (uri.protocol !== 'https:' || uri.username || uri.password || isIP(uri.hostname.replace(/^\[|\]$/g, '')) ||
      !uri.hostname.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(uri.hostname)) throw new Error('public_source_uri_required');
  const text = required(source.text, 'source_text', 1000000);
  return { ref: required(source.ref, 'source_ref'), uri: uri.href, license: required(source.license, 'source_license'), public: true, text, sha256: digest(text),
    attribution: source.attribution ? required(source.attribution, 'source_attribution') : uri.href,
    licenseNotice: source.licenseNotice ? required(source.licenseNotice, 'license_notice', 20000) : '' };
}
const blindData = (taskId, question, claim, text, source) => ({ taskId, question, claim, evidenceText: text,
  sourceAttribution: `${source.attribution}\n${source.uri}\nLicense: ${source.license}`, sourceLicenseNotice: source.licenseNotice });
function validateManifest(manifest) {
  if (manifest?.schema !== 'zhiheng-annotation-manifest/1' || !Array.isArray(manifest.tasks) || !manifest.tasks.length || manifest.tasks.length > 500)
    throw new Error('invalid_manifest');
  const { sha256, ...payload } = manifest;
  if (digest(payload) !== sha256) throw new Error('manifest_integrity_mismatch');
  const ids = new Set(), cases = new Set();
  for (const task of manifest.tasks) {
    if (ids.has(task.taskId) || cases.has(task.caseId)) throw new Error('duplicate_manifest_task');
    ids.add(required(task.taskId, 'task_id')); cases.add(required(task.caseId, 'case_id'));
    if (stable(publicSource(task.source)) !== stable(task.source)) throw new Error('source_integrity_mismatch');
    const passage = span(task.source.text, task.span);
    const data = blindData(task.taskId, required(task.question, 'question'), required(task.claim, 'claim'), passage.text, task.source);
    if (stable(data) !== stable(task.data)) throw new Error('task_data_integrity_mismatch');
  }
  return manifest;
}
export function createBlindBatch(pack) {
  if (!Array.isArray(pack?.cases) || !pack.cases.length || pack.cases.length > 500) throw new Error('invalid_public_case_pack');
  const tasks = pack.cases.map(item => {
    const source = publicSource(item.source), passage = span(source.text, item.span), taskId = randomUUID();
    const question = required(item.question, 'question'), claim = required(item.claim, 'claim');
    return { taskId, caseId: required(item.id, 'case_id'), question, claim, source, span: passage,
      data: blindData(taskId, question, claim, passage.text, source) };
  });
  const payload = { schema: 'zhiheng-annotation-manifest/1', version: required(pack.version, 'version'), createdAt: new Date().toISOString(),
    sourcePackSha256: digest(pack), offsetUnit: 'UTF-16-code-units', publicOnly: true, tasks };
  const manifest = validateManifest({ ...payload, sha256: digest(payload) });
  return { manifest, tasks: shuffled(tasks).map(t => ({ data: t.data })), secondTasks: shuffled(tasks).map(t => ({ data: t.data })) };
}
function identity(value) {
  if (!value || !['human', 'synthetic_fixture'].includes(value.kind)) throw new Error('reviewer_kind_required');
  required(value.id, 'reviewer_identity', 200); required(value.attestedBy, 'coordinator_attestation', 200); date(value.attestedAt);
  if (value.exportUserId == null || !String(value.exportUserId).trim()) throw new Error('export_user_identity_required');
  return value;
}
function evidenceSpans(text, values, verdict) {
  if (!Array.isArray(values)) throw new Error('evidence_spans_required');
  if (verdict !== 'unsupported' && !values.length) throw new Error('supported_or_contradicted_requires_span');
  if (values.length > 50) throw new Error('too_many_spans');
  const result = values.map(v => span(text, v));
  if (new Set(result.map(v => `${v.start}:${v.end}`)).size !== result.length) throw new Error('duplicate_evidence_span');
  return result;
}
function parseReview(manifest, review) {
  const reviewer = identity(review.reviewer);
  if (!Array.isArray(review.tasks)) throw new Error('label_studio_json_array_required');
  if (reviewer.kind === 'human' && !review.exportText) throw new Error('original_export_required_for_human_attestation');
  if (review.exportText !== undefined && (stable(JSON.parse(review.exportText)) !== stable(review.tasks) || digest(review.exportText) !== review.exportFileSha256))
    throw new Error('original_export_integrity_mismatch');
  const expected = new Map(manifest.tasks.map(t => [t.taskId, t])), seen = new Set(), annotationIds = new Set(), votes = new Map();
  const counts = { reviewer: reviewer.id, expected: expected.size, submitted: 0, missing: 0, cancelled: 0, incomplete: 0, cancelledAnnotations: 0 };
  for (const task of review.tasks) {
    const id = task.data?.taskId, original = expected.get(id);
    if (!original) throw new Error('unknown_task');
    if (seen.has(id)) throw new Error('duplicate_export_task'); seen.add(id);
    if (stable(task.data) !== stable(original.data)) throw new Error('task_data_mismatch');
    if (task.predictions?.length) throw new Error('preannotations_not_allowed_in_blind_review');
    if (!Array.isArray(task.annotations)) throw new Error('annotations_array_required');
    const annotations = task.annotations.filter(a => a.was_cancelled !== true);
    counts.cancelledAnnotations += task.annotations.length - annotations.length;
    if (annotations.length > 1) throw new Error('duplicate_active_annotation');
    if (!annotations.length) { counts[task.annotations.length ? 'cancelled' : 'incomplete']++; continue; }
    const a = annotations[0], author = typeof a.completed_by === 'object' ? a.completed_by?.id : a.completed_by;
    if (author == null || String(author) !== String(reviewer.exportUserId)) throw new Error('annotation_reviewer_mismatch');
    if (a.id == null || !Array.isArray(a.result)) throw new Error('invalid_annotation');
    if (annotationIds.has(String(a.id))) throw new Error('duplicate_annotation_id'); annotationIds.add(String(a.id));
    if (a.parent_prediction != null || a.parent_annotation != null || a.result.some(r => r.origin && r.origin !== 'manual')) throw new Error('nonmanual_annotation_not_allowed');
    const choices = a.result.filter(r => r.from_name === 'verdict' && r.type === 'choices' && r.to_name === 'claim');
    const rationale = a.result.filter(r => r.from_name === 'rationale' && r.type === 'textarea' && r.to_name === 'claim');
    if (choices.length !== 1 || choices[0].value?.choices?.length !== 1 || rationale.length !== 1) throw new Error('incomplete_annotation_fields');
    const verdict = label(choices[0].value.choices[0]);
    const spans = a.result.filter(r => r.from_name === 'evidence' && r.type === 'labels' && r.to_name === 'evidence_text');
    if (spans.some(r => stable(r.value?.labels) !== stable(['Evidence']))) throw new Error('invalid_evidence_label');
    if (reviewer.kind === 'human' && spans.some(r => typeof r.value?.text !== 'string')) throw new Error('human_selection_text_required');
    const vote = { taskId: id, reviewerId: reviewer.id, reviewerKind: reviewer.kind, annotationId: String(a.id),
      reviewedAt: date(a.updated_at || a.created_at), verdict, rationale: required(rationale[0].value?.text?.join('\n'), 'rationale'),
      evidenceSpans: evidenceSpans(original.data.evidenceText, spans.map(s => s.value), verdict) };
    votes.set(id, { ...vote, sha256: digest(vote) }); counts.submitted++;
  }
  counts.missing = expected.size - seen.size;
  return { reviewer, votes, counts };
}
export function agreementMetrics(pairs, total) {
  pairs = pairs.map(([a, b]) => [label(a), label(b)]);
  const confusion = Object.fromEntries(LABELS.map(a => [a, Object.fromEntries(LABELS.map(b => [b, 0]))]));
  for (const [a, b] of pairs) confusion[label(a)][label(b)]++;
  const n = pairs.length, observed = n ? pairs.filter(([a, b]) => a === b).length / n : null;
  const expected = n ? LABELS.reduce((sum, v) => sum + pairs.filter(p => p[0] === v).length * pairs.filter(p => p[1] === v).length / n ** 2, 0) : null;
  return { expectedPairs: total, paired: n, coverage: total ? n / total : null, observedAgreement: observed,
    cohenKappa: n && expected < 1 ? (observed - expected) / (1 - expected) : null, confusion,
    note: 'Agreement uses independent pre-adjudication votes; constant-label marginals make kappa undefined.' };
}
export function classificationMetrics(rows) {
  const columns = [...LABELS, 'uncertain', 'unassessed'];
  const confusion = Object.fromEntries(LABELS.map(v => [v, Object.fromEntries(columns.map(p => [p, 0]))]));
  for (const row of rows) { const predicted = row.independent === true && columns.includes(row.verdict) ? row.verdict : 'unassessed'; confusion[label(row.expected)][predicted]++; }
  const perClass = {};
  for (const v of LABELS) {
    const gold = Object.values(confusion[v]).reduce((a, b) => a + b, 0), predicted = LABELS.reduce((n, key) => n + confusion[key][v], 0), tp = confusion[v][v];
    perClass[v] = { gold, predicted, correct: tp, precision: predicted ? tp / predicted : null, recall: gold ? tp / gold : null,
      f1: gold + predicted ? 2 * tp / (gold + predicted) : null };
  }
  const assessed = rows.length - LABELS.reduce((n, v) => n + confusion[v].unassessed, 0);
  return { total: rows.length, assessed, coverage: rows.length ? assessed / rows.length : null,
    accuracy: rows.length ? LABELS.reduce((n, v) => n + confusion[v][v], 0) / rows.length : null, confusion, perClass };
}
export function ingestReviews({ manifest, reviews, adjudications = [] }) {
  validateManifest(manifest);
  if (!Array.isArray(reviews) || reviews.length !== 2) throw new Error('two_independent_reviews_required');
  const parsed = reviews.map(r => parseReview(manifest, r));
  if (reviewerKey(parsed[0].reviewer.id) === reviewerKey(parsed[1].reviewer.id)) throw new Error('two_independent_reviewers_required');
  // Import tools can reorder tasks. Changing export order alone does not create a second review.
  const exportDigest = tasks => digest(tasks.map(task => ({
    id: task.data.taskId,
    votes: task.annotations.filter(a => a.was_cancelled !== true).map(a => ({
      id: String(a.id), author: String(typeof a.completed_by === 'object' ? a.completed_by.id : a.completed_by),
      time: a.updated_at || a.created_at, result: a.result,
    })),
  })).sort((a, b) => a.id.localeCompare(b.id)));
  if (parsed[0].votes.size && exportDigest(reviews[0].tasks) === exportDigest(reviews[1].tasks)) throw new Error('independent_exports_required');
  // Different local account IDs in isolated instances are not identity proof: roster names must be distinct.
  const decisions = new Map();
  if (!Array.isArray(adjudications)) throw new Error('adjudications_array_required');
  for (const a of adjudications) { if (decisions.has(a.taskId)) throw new Error('duplicate_adjudication'); decisions.set(a.taskId, a); }
  const pairs = [], disagreements = [], pending = [], cases = []; let allHuman = parsed.every(r => r.reviewer.kind === 'human');
  for (const task of manifest.tasks) {
    const votes = parsed.map(r => r.votes.get(task.taskId));
    if (votes.some(v => !v)) { pending.push(task.taskId); continue; }
    pairs.push(votes.map(v => v.verdict));
    let final = votes[0], adjudication = null;
    if (votes[0].verdict !== votes[1].verdict) {
      const voteDigests = votes.map(v => v.sha256), a = decisions.get(task.taskId);
      disagreements.push({ taskId: task.taskId, votes: votes.map(v => v.verdict), voteDigests, resolved: Boolean(a) });
      if (!a) { pending.push(task.taskId); continue; }
      const reviewer = identity(a.reviewer);
      if (parsed.some(r => reviewerKey(r.reviewer.id) === reviewerKey(reviewer.id))) throw new Error('independent_third_reviewer_required');
      if (stable(a.voteDigests) !== stable(voteDigests)) throw new Error('adjudication_vote_integrity_mismatch');
      const verdict = label(a.verdict);
      adjudication = { ...a, verdict, reviewedAt: date(a.reviewedAt), rationale: required(a.rationale, 'adjudication_rationale'),
        evidenceSpans: evidenceSpans(task.data.evidenceText, a.evidenceSpans, verdict) };
      final = adjudication; allHuman &&= reviewer.kind === 'human'; decisions.delete(task.taskId);
    }
    const evidence = final.evidenceSpans.map(s => ({ ref: task.source.ref, sourceSha256: task.source.sha256,
      start: task.span.start + s.start, end: task.span.start + s.end, quote: s.text }));
    cases.push({ id: task.caseId, question: task.question, claim: task.claim, source: task.data.evidenceText, expected: final.verdict,
      sourceRef: task.source.ref, sourceSha256: task.source.sha256, sourceUri: task.source.uri, passageStart: task.span.start,
      passageEnd: task.span.end, evidence, review: { taskId: task.taskId, votes, adjudication } });
  }
  if (decisions.size) throw new Error('unexpected_adjudication');
  const agreement = agreementMetrics(pairs, manifest.tasks.length);
  const result = { schema: 'zhiheng-annotation-import/1', status: pending.length ? 'incomplete' : allHuman ? 'complete_attested' : 'complete_fixture',
    expectedCases: manifest.tasks.length, resolvedCases: cases.length, pending, completeness: parsed.map(p => p.counts), disagreements, agreement };
  if (!pending.length) {
    const proof = { schema: 'zhiheng-annotation-review/1', manifest, reviews, adjudications,
      manifestSha256: manifest.sha256, reviewExportSha256: reviews.map(digest), adjudicationSha256: digest(adjudications) };
    result.dataset = { version: `${manifest.version}-reviewed`, humanReviewed: allHuman, promotable: false,
      reviewStatus: allHuman ? 'coordinator_attested_human' : 'synthetic_fixture', cases, agreement,
      annotationReview: { ...proof, sha256: digest(proof) }, limitations: [
        'Offline provenance binds original exports, source text, spans and decisions; it cannot authenticate whether a person truly performed the work.',
        'Coordinator must verify reviewer identities and independence. No automatic promotion. Claim support labels do not establish corpus-wide answerability.',
      ] };
  }
  return result;
}
export function verifyReviewedDataset(dataset) {
  const proof = dataset?.annotationReview;
  if (!proof || proof.schema !== 'zhiheng-annotation-review/1') throw new Error('human_review_provenance_required');
  const { sha256, ...payload } = proof;
  if (digest(payload) !== sha256 || proof.manifestSha256 !== proof.manifest?.sha256 || stable(proof.reviewExportSha256) !== stable(proof.reviews?.map(digest)) ||
      proof.adjudicationSha256 !== digest(proof.adjudications)) throw new Error('review_provenance_integrity_mismatch');
  const rebuilt = ingestReviews(proof);
  if (!rebuilt.dataset || stable(rebuilt.dataset) !== stable(dataset)) throw new Error('reviewed_dataset_integrity_mismatch');
  return { humanReviewed: rebuilt.dataset.humanReviewed, status: rebuilt.dataset.reviewStatus, cases: rebuilt.dataset.cases.length,
    provenanceSha256: proof.sha256, authentication: 'coordinator_attestation_not_cryptographic_identity' };
}
