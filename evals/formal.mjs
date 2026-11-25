/** Deterministic retrieval evaluation against the bundled, licensed specialist corpus. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CASES = path.join(ROOT, 'evals', 'formal-cases.json');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function supportsExpectedConcepts(record, specification) {
  if (!record || specification.expectInsufficient || record.contentRole === 'exercise') return false;
  if (!specification.sourcePaths.includes(record.sourcePath)) return false;
  // Only retained source prose/code participates: never use generated titles, tags or keywords.
  const source = String(record.abstract || '');
  return specification.concepts.every((alternatives) => alternatives.some((pattern) => new RegExp(pattern, 'iu').test(source)));
}

export function citationIntegrity(item, paper, record) {
  const errors = [];
  if (!paper || !record) return { valid: false, offsetValid: false, metadataValid: false, errors: ['unresolvable_ref'] };
  const offsetValid = item.locatable !== false && Number.isInteger(item.start) && Number.isInteger(item.end) &&
    item.start >= 0 && item.end > item.start && item.end <= paper.content.length &&
    paper.content.slice(item.start, item.end) === item.snippet && item.content === paper.content;
  if (!offsetValid) errors.push('source_offset_mismatch');
  const fields = ['sourceUrl', 'sourceTitle', 'sourceRevision', 'authors', 'license', 'licenseUrl', 'language', 'chapter',
    'section', 'contentSha256', 'sourceSha256', 'sourcePath', 'sourceStartLine', 'sourceEndLine', 'translationStatus', 'proofStatus'];
  for (const field of fields) {
    if (item[field] == null || item[field] === '' || JSON.stringify(item[field]) !== JSON.stringify(record[field])) errors.push(`metadata:${field}`);
  }
  if (!/^[a-f\d]{40}$/i.test(item.sourceRevision || '') || !String(item.sourceUrl).includes(`/${item.sourceRevision}/`)) errors.push('unpinned_source');
  if (!Number.isInteger(item.sourceStartLine) || item.sourceStartLine < 1 || item.sourceEndLine < item.sourceStartLine) errors.push('source_line_range');
  if (hash(record.abstract) !== item.contentSha256) errors.push('source_content_hash');
  const metadataValid = !errors.some((error) => error !== 'source_offset_mismatch');
  return { valid: offsetValid && metadataValid, offsetValid, metadataValid, errors };
}

export async function runFormalEvaluation({ casesPath = CASES } = {}) {
  // Independent of personal .env, database content, model keys, vector caches and rerank services.
  Object.assign(process.env, { CORPUS_PROFILE: 'formal', CORPUS_JSONL: '', CORPUS_MANIFEST: '', FILE_INDEX_LIMIT: '10000',
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', RERANK_ENABLED: 'false', RAGFLOW_BASE_URL: '', QDRANT_URL: '',
    EMBEDDING_PROVIDER: 'local', EMBEDDING_BASE_URL: '' });
  const [{ initRag, getPaper, ragStatus }, { retrieveAll }] = await Promise.all([
    import('../src/server/rag.mjs'), import('../src/server/retrieve.mjs'),
  ]);
  const caseSource = await fs.readFile(casesPath, 'utf8');
  const specification = JSON.parse(caseSource);
  const raw = await fs.readFile(path.join(ROOT, 'data', 'formal', 'papers.jsonl'), 'utf8');
  const records = raw.trim().split(/\r?\n/).map(JSON.parse);
  const byId = new Map(records.map((record) => [String(record.id), record]));
  await initRag({ mysqlReady: false });
  const corpus = ragStatus();
  if (corpus.profile !== 'formal' || corpus.papers !== records.length) throw new Error('formal_evaluation_requires_complete_default_corpus');
  const cases = [];
  for (const spec of specification.cases) {
    const goldCount = spec.expectInsufficient ? null : records.filter((record) => supportsExpectedConcepts(record, spec)).length;
    const result = await retrieveAll(spec.question, { k: 5, channels: ['paper'], sourceKind: 'paper', rewrite: false });
    const ranked = [];
    for (const [index, item] of result.results.entries()) {
      const record = byId.get(item.ref);
      const paper = await getPaper(item.ref);
      ranked.push({ rank: index + 1, ref: item.ref, title: item.title, sourcePath: item.sourcePath, section: item.section,
        relevant: supportsExpectedConcepts(record, spec), contentRole: record?.contentRole,
        integrity: citationIntegrity(item, paper, record), sourceUrl: item.sourceUrl });
    }
    const rank = ranked.find((item) => item.relevant)?.rank || null;
    const insufficient = result.results.length === 0 || result.weak;
    cases.push({ id: spec.id, question: spec.question, expectInsufficient: Boolean(spec.expectInsufficient), goldCount,
      hitAt5: spec.expectInsufficient ? null : Boolean(rank), reciprocalRank: rank ? 1 / rank : 0,
      weak: result.weak, coverage: result.coverage, missingConcepts: result.missingConcepts || [],
      passed: spec.expectInsufficient ? insufficient : Boolean(rank) && !insufficient, results: ranked });
  }
  const positives = cases.filter((item) => !item.expectInsufficient);
  const negatives = cases.filter((item) => item.expectInsufficient);
  const results = cases.flatMap((item) => item.results);
  const ratio = (items, predicate) => items.length ? items.filter(predicate).length / items.length : 1;
  const metrics = {
    positiveCases: positives.length, insufficientCases: negatives.length,
    hitAt5: ratio(positives, (item) => item.hitAt5),
    mrrAt5: positives.reduce((sum, item) => sum + item.reciprocalRank, 0) / positives.length,
    usableHitAt5: ratio(positives, (item) => item.hitAt5 && !item.weak),
    insufficientDetection: ratio(negatives, (item) => item.passed),
    citationOffsetAccuracy: ratio(results, (item) => item.integrity.offsetValid),
    sourceMetadataCompleteness: ratio(results, (item) => item.integrity.metadataValid),
    retrievedResults: results.length,
  };
  return { schemaVersion: 1, caseSet: specification.version, createdAt: new Date().toISOString(),
    caseSetSha256: hash(caseSource.replace(/\r\n?/g, '\n')), matcherClarifications: specification.matcherClarifications || [],
    corpus: { ...corpus, loadedAt: undefined, sha256: hash(raw.replace(/\r\n?/g, '\n')) },
    configuration: { channels: ['paper'], topK: 5, rewrite: false, rerank: false, modelCalls: 0 },
    methodology: `正例按预先指定sourcePath及原始正文概念组合判定；不使用标题、关键词或纯练习作为支持。负例检查空召回或weak。偏移对照getPaper原文，来源字段对照固定语料记录。MRR仅统计${positives.length}个正例且排名截断为5。`,
    semanticSupportMeasured: false,
    limitations: [`这是${cases.length}题的检索与来源完整性回归，不是模型回答质量、自然语言蕴涵或医学结论评测。`,
      '概念组合匹配是可复现代理指标；真实回答仍需逐句核对原文，不保证所有命中都能支持任何表述。',
      '未比较其他向量模型、远端重排器或旧CSL库，不宣称全领域优于旧库。'],
    metrics, passed: cases.every((item) => item.passed) && results.every((item) => item.integrity.valid), cases };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputIndex = process.argv.indexOf('--output');
  const destination = outputIndex >= 0 ? process.argv[outputIndex + 1] : path.join(ROOT, 'evals', 'results', 'formal-retrieval.json');
  if (!destination) throw new Error('--output requires a path');
  const casesIndex = process.argv.indexOf('--cases');
  const casesPath = casesIndex >= 0 ? process.argv[casesIndex + 1] : CASES;
  if (!casesPath || casesPath.startsWith('--')) throw new Error('Missing --cases JSON path');
  const report = await runFormalEvaluation({ casesPath });
  await fs.mkdir(path.dirname(path.resolve(destination)), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ report: path.resolve(destination), passed: report.passed, metrics: report.metrics,
    cases: report.cases.map((item) => ({ id: item.id, passed: item.passed, weak: item.weak, rank: item.results.find((result) => result.relevant)?.rank || null, goldCount: item.goldCount })) }, null, 2));
  if (!report.passed) process.exitCode = 1;
}
