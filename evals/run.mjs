import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import AgentProvider from './provider.mjs';
import { deterministic, supportJudge } from './assertions.mjs';

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(evalDir);
const mode = process.argv[2] || 'retrieval';
if (!['retrieval', 'live'].includes(mode)) throw new Error('usage: node evals/run.mjs retrieval|live');
if (mode === 'live' && (!process.env.EVAL_LLM_BASE_URL || !process.env.EVAL_LLM_MODEL || !process.env.EVAL_JUDGE_BASE_URL || !process.env.EVAL_JUDGE_MODEL)) {
  throw new Error('Live evaluation needs EVAL_LLM_BASE_URL, EVAL_LLM_MODEL, EVAL_JUDGE_BASE_URL and EVAL_JUDGE_MODEL; keys optional only for keyless services. No live baseline has been measured.');
}
const major = Number(process.versions.node.split('.')[0]);
if (major < 22 || (major === 22 && Number(process.versions.node.split('.')[1]) < 22)) throw new Error('Promptfoo evaluation requires Node >=22.22.0.');

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lkba-eval-'));
process.env.PROMPTFOO_CONFIG_DIR = path.join(temp, 'promptfoo');
process.env.PROMPTFOO_DISABLE_TELEMETRY = '1';
process.env.PROMPTFOO_DISABLE_UPDATE = '1';
const fixture = (await fs.readFile(path.join(evalDir, 'fixtures/papers.jsonl'), 'utf8')).replace(/\r\n?/g, '\n');
await fs.writeFile(path.join(temp, 'papers.jsonl'), fixture);
const casesRaw = (await fs.readFile(path.join(evalDir, 'cases.json'), 'utf8')).replace(/\r\n?/g, '\n');
const cases = JSON.parse(casesRaw).filter((c) => mode === 'live' || (c.expectedRefs.length > 0 && !c.document));
const experimental = process.env.EVAL_RERANK_ENABLED === '1';
const child = spawn(process.execPath, ['server.mjs'], { cwd: root, windowsHide: true,
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: temp,
    STORE_FILE: path.join(temp, 'store.json'), KB_FILE: path.join(temp, 'kb.json'), VECTOR_FILE: path.join(temp, 'vectors.json'),
    CORPUS_JSONL: path.join(temp, 'papers.jsonl'), AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
    MYSQL_ENABLED: 'false', REDIS_ENABLED: 'false', QDRANT_URL: '', RAGFLOW_BASE_URL: '',
    EMBEDDING_PROVIDER: 'local', EMBEDDING_BASE_URL: '', EMBEDDING_DIM: '512',
    EXEC_ENABLED: '0', LEARNING_ENABLED: 'false', WEB_FETCH_ENABLED: 'false', WEB_SEARCH_PROVIDER: '', WEB_SEARCH_KEY: '',
    MINERU_ENABLED: 'false', MCP_SDK_ENABLED: 'false', LEGACY_LOOPBACK_IDENTITY: 'false',
    INFERENCE_AUDIT: 'false', AUX_LLM_MAX_CALLS: '0', RATE_LIMIT_PER_MIN: '1000',
    RERANK_ENABLED: experimental ? '1' : '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
let bootLog = '';
child.stdout.on('data', (d) => { bootLog = (bootLog + d).slice(-6000); });
child.stderr.on('data', (d) => { bootLog = (bootLog + d).slice(-6000); });
const childError = new Promise((resolve) => child.once('error', resolve));
try {
  let baseUrl;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`eval server exited: ${bootLog}`);
    try {
      const port = (await fs.readFile(path.join(temp, '.server-port'), 'utf8')).trim();
      baseUrl = `http://127.0.0.1:${port}`;
      const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.json());
      if (health.ready) break;
    } catch { baseUrl = null; }
    await Promise.race([new Promise((r) => setTimeout(r, 100)), childError.then((err) => { throw err; })]);
    if (attempt === 149) throw new Error(`eval server not ready: ${bootLog}`);
  }
  const { evaluate } = await import('promptfoo');
  const provider = new AgentProvider({ config: { baseUrl, mode, requireRerank: experimental, modelProvider: {
    baseUrl: process.env.EVAL_LLM_BASE_URL, model: process.env.EVAL_LLM_MODEL, apiKey: process.env.EVAL_LLM_API_KEY || '',
  } } });
  const record = await evaluate({
    description: `logic-kb controlled corpus ${mode}, rerank=${experimental}`,
    prompts: ['{{question}}'], providers: [provider], writeLatestResults: false,
    tests: cases.map((test) => ({ description: test.id, vars: { question: test.question, case: test },
      assert: [{ type: 'javascript', value: deterministic }, ...(mode === 'live' ? [{ type: 'javascript', value: supportJudge }] : [])],
    })),
  }, { cache: false, maxConcurrency: 1, progressBar: false });
  const summary = await record.toEvaluateSummary();
  const semanticEvaluatedCases = summary.results.filter((row) => (row.namedScores || row.gradingResult?.namedScores)?.semantic_judged === 1).length;
  const semanticSupportMeasured = mode === 'live' && semanticEvaluatedCases === cases.length;
  const report = {
    mode, measuredAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    corpusSha256: crypto.createHash('sha256').update(fixture).digest('hex'),
    casesSha256: crypto.createHash('sha256').update(casesRaw).digest('hex'),
    rerank: experimental, rerankModel: experimental ? process.env.RERANK_MODEL || 'BAAI/bge-reranker-v2-m3' : null,
    model: mode === 'live' ? process.env.EVAL_LLM_MODEL : null,
    judge: mode === 'live' ? process.env.EVAL_JUDGE_MODEL : null,
    semanticSupportAttempted: mode === 'live', semanticSupportMeasured, semanticEvaluatedCases,
    semanticUnmeasuredCases: mode === 'live' ? cases.length - semanticEvaluatedCases : cases.length,
    fixtureType: 'synthetic controlled corpus; natural-language research questions',
    summary,
  };
  const outDir = path.join(evalDir, 'results');
  await fs.mkdir(outDir, { recursive: true });
  const name = `${mode}-${experimental ? 'rerank' : 'baseline'}-${Date.now()}.json`;
  await fs.writeFile(path.join(outDir, name), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: path.join(outDir, name), stats: summary.stats, semanticSupportMeasured, semanticEvaluatedCases }));
  if ((summary.stats?.failures || 0) + (summary.stats?.errors || 0) > 0) process.exitCode = 1;
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 4000))]);
  }
  // Unique mkdtemp directory only; never remove operator data or the workspace.
  if (child.exitCode !== null || child.signalCode) await fs.rm(temp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
