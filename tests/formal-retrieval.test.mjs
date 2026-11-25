import test from 'node:test';
import assert from 'node:assert/strict';
import { supportsExpectedConcepts, citationIntegrity, runFormalEvaluation } from '../evals/formal.mjs';
import { initRag, searchPapers } from '../src/server/rag.mjs';

test('Coq operators retrieve passages containing the actual notation', async () => {
  await initRag({ mysqlReady: false });
  for (const [query, operator] of [['P -> Q', '->'], ['<->', '<->'], ['P /\\ Q', '/\\'], ['|-', '|-']]) {
    const response = await searchPapers(query, { k: 5 });
    assert.ok(response.results.some(paper => paper.abstract.includes(operator)), query);
    assert.equal(response.weak, false);
  }
});

test('专业库评分：标签与标题命中不能冒充正文支持，练习不能冒充解释', () => {
  const specification = { sourcePaths: ['lf-current/Logic.v'], concepts: [['合取', 'conjunction'], ['destruct', '拆分']] };
  const record = { sourcePath: 'lf-current/Logic.v', abstract: '这里讨论集合的大小。', title: '合取 destruct', keywords: '合取 拆分', contentRole: 'exposition' };
  assert.equal(supportsExpectedConcepts(record, specification), false);
  const actual = { ...record, abstract: '合取证据可通过 destruct 拆分。' };
  assert.equal(supportsExpectedConcepts(actual, specification), true);
  assert.equal(supportsExpectedConcepts({ ...actual, contentRole: 'exercise' }, specification), false);
  assert.equal(supportsExpectedConcepts({ ...actual, sourcePath: 'elsewhere.v' }, specification), false);
});

test('专业库评分：偏移错误和缺失来源元数据都会失败', () => {
  const result = citationIntegrity({ ref: '1', snippet: '原文', start: 0, end: 2, content: '伪造文本' }, { content: '真正原文' }, { abstract: '真正原文' });
  assert.equal(result.valid, false);
  assert.equal(result.offsetValid, false);
  assert.equal(result.metadataValid, false);
  assert.ok(result.errors.includes('metadata:sourceUrl'));
  assert.equal(citationIntegrity({}, null, null).valid, false);
});

test('默认专业全文库：固定中文题集真实paper通道召回、引用定位与不足证据检查', async () => {
  const report = await runFormalEvaluation();
  assert.equal(report.cases.length, 12);
  assert.equal(report.configuration.modelCalls, 0);
  assert.equal(report.semanticSupportMeasured, false);
  assert.ok(report.cases.filter((item) => !item.expectInsufficient).every((item) => item.goldCount > 0), '每个正例必须存在正文支持候选');
  assert.equal(report.metrics.hitAt5, 1, JSON.stringify(report.cases.filter((item) => !item.passed)));
  assert.equal(report.metrics.insufficientDetection, 1);
  assert.equal(report.metrics.citationOffsetAccuracy, 1);
  assert.equal(report.metrics.sourceMetadataCompleteness, 1);
  assert.equal(report.passed, true);
});
