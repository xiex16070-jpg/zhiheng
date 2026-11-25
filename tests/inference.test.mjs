/**
 * 有据推断单元测试：标记解析、提示词分层、锚定校验、LLM 审核（mock SSE）、观测信号。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lkba-inf-'));
process.env.DATA_DIR = dir;
process.env.MYSQL_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,::1';

const { parseInferences, extractRefs } = await import('../src/agent/text.js');
const { renderInferenceRules, anchorInferences, auditInferences, inferenceStats } = await import('../src/server/inference.mjs');
const { buildSystemPrompt, refreshPreferencePrompt } = await import('../src/server/prompt.mjs');
const { collectObservations } = await import('../src/server/review.mjs');

/* ------------------------------------------------------------------ 解析 */

test('parseInferences：完整标记解析出 refs/方法/置信度/结论', () => {
  const text = '事实层结论 [[3]]。\n\n[推断]（依据[[3]][[7]]；方法:归纳；置信度:中）正极材料改性研究呈上升趋势。\n\n后续事实 [[7]]。';
  const inf = parseInferences(text);
  assert.equal(inf.length, 1);
  assert.deepEqual(inf[0].refs, ['3', '7']);
  assert.equal(inf[0].method, '归纳');
  assert.equal(inf[0].confidence, '中');
  assert.match(inf[0].text, /上升趋势/);
  assert.ok(!inf[0].text.includes('后续事实')); // 到空行为止
});

test('parseInferences：半角括号、缺元数据、多条、文档片段 ref', () => {
  const t1 = '[推断](依据[[k1a2b3c_4]];方法:因果;置信度:高)结论A\n\n[推断]（依据[[9]]）结论B';
  const inf = parseInferences(t1);
  assert.equal(inf.length, 2);
  assert.deepEqual(inf[0].refs, ['k1a2b3c_4']);
  assert.equal(inf[0].method, '因果');
  assert.equal(inf[1].method, null); // 缺方法不炸
  assert.equal(inf[1].confidence, null);
  assert.match(inf[1].text, /结论B/);
});

test('parseInferences：无标记返回空；标记进引用链（extractRefs 同样能取到）', () => {
  assert.deepEqual(parseInferences('纯事实回答 [[1]]'), []);
  const text = '[推断]（依据[[5]]；方法:演绎；置信度:低）X';
  assert.ok(extractRefs(text).includes('5')); // 推断依据 ref 进入统一引用校验链
});

/* ------------------------------------------------------------------ 提示词分层 */

test('renderInferenceRules：off 禁止推断；balanced ≤3；active ≤5 + 主动衍生', () => {
  assert.match(renderInferenceRules('off'), /禁止任何超出检索原文的推断/);
  const b = renderInferenceRules('balanced');
  assert.match(b, /最多 3 条/);
  assert.match(b, /\[推断\]（依据\[\[ref1\]\]\[\[ref2\]\]；方法:归纳；置信度:中）/);
  assert.match(b, /归纳 \/ 演绎 \/ 类比 \/ 因果 \/ 外推/);
  assert.match(b, /禁止把你自己知道、但资料里没有的内容包装成推断/);
  const a = renderInferenceRules('active');
  assert.match(a, /最多 5 条/);
  assert.match(a, /主动给出衍生结论/);
});

test('buildSystemPrompt：inference 偏好驱动铁律与推断纪律节', () => {
  const corpus = { papers: 100, disciplines: 10 };
  const off = buildSystemPrompt({ preferences: { inference: 'off' }, corpus });
  assert.match(off, /1\. 只能依据工具检索到的内容作答/);
  assert.ok(!off.includes('# 推断纪律'));
  assert.match(off, /推断偏好：关闭/);

  const bal = buildSystemPrompt({ preferences: {}, corpus }); // 默认 balanced
  assert.match(bal, /事实性陈述只能依据工具检索到的内容/);
  assert.match(bal, /# 推断纪律/);
  assert.match(bal, /推断偏好：平衡/);

  const act = buildSystemPrompt({ preferences: { inference: 'active' }, corpus });
  assert.match(act, /最多 5 条/);
});

test('恢复审批后替换偏好规则，保留任务开始时冻结的记忆/技能', () => {
  const corpus = { papers: 10, disciplines: 1 };
  const next = { style: 'detailed', inference: 'off', citeQuotes: false };
  const skills = { matched: [{ name: 'test', description: '测试', body: '冻结的技能' }] };
  const memory = '# 长期记忆（跨会话持久）\n\n## 环境事实\n冻结的内容';
  for (const context of [{}, { memory }, { skills }, { skills, memory }]) {
    const original = buildSystemPrompt({ corpus, preferences: { style: 'balanced', citeQuotes: true }, ...context });
    assert.equal(refreshPreferencePrompt(original, next, corpus), buildSystemPrompt({ corpus, preferences: next, ...context }));
  }
});

/* ------------------------------------------------------------------ 锚定与审核 */

const evidence = new Map([
  ['3', { ref: '3', title: '锂电池综述', content: '层状氧化物正极的循环寿命在改性后提升约 20%。' }],
  ['7', { ref: '7', title: '正极材料', content: '改性方法集中在掺杂与包覆两类。' }],
]);

test('anchorInferences：依据存在→refsValid；依据不存在/缺失→false', () => {
  const inf = parseInferences('[推断]（依据[[3]][[7]]；方法:归纳；置信度:中）A\n\n[推断]（依据[[999]]；方法:类比；置信度:低）B\n\n[推断]（方法:归纳；置信度:高）C');
  const anchored = anchorInferences(inf, evidence);
  assert.equal(anchored[0].refsValid, true);
  assert.equal(anchored[1].refsValid, false); // ref 999 不在证据里
  assert.equal(anchored[2].refsValid, false); // 没有依据
  assert.equal(anchored[0].validation.formalVerified, false);
  assert.equal(anchored[0].validation.semanticSupportVerified, false);
  assert.equal(anchored[0].premises[0].ref, '3');
  assert.equal(anchored[1].audit.method, 'reference_check');
});

/* ---- mock SSE 审核器 ---- */
const chunk = (delta, finish = null) => ({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
let auditResponse = '[{"i":1,"verdict":"pass","reason":"证据支持"},{"i":2,"verdict":"fail","reason":"999 不存在且结论超出证据"}]';
let failMode = false, requestCount = 0;
const server = http.createServer(async (req, res) => {
  requestCount++;
  for await (const c of req) { /* drain */ }
  if (failMode) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"boom"}'); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  for (let i = 0; i < auditResponse.length; i += 40) {
    res.write(`data: ${JSON.stringify(chunk({ content: auditResponse.slice(i, i + 40) }))}\n\n`);
  }
  res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const provider = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'mock' };

test('auditInferences：pass/fail 判定回填；缺条目→skip；统计正确', async () => {
  const inf = anchorInferences(parseInferences('[推断]（依据[[3]][[7]]；方法:归纳；置信度:中）A\n\n[推断]（依据[[999]]；方法:类比；置信度:低）B'), evidence);
  const r = await auditInferences({ inferences: inf, evidence, provider: { model: 'answer-fixture' }, judgeProvider: provider });
  assert.equal(r.audited, true);
  assert.equal(r.inferences[0].audit.verdict, 'pass');
  assert.equal(r.inferences[0].validation.status, 'model_assessed');
  assert.equal(r.inferences[0].validation.formalVerified, false);
  assert.equal(r.inferences[1].audit.verdict, 'fail');
  const stats = inferenceStats(r.inferences);
  assert.equal(stats.total, 2);
  assert.equal(stats.pass, 1);
  assert.equal(stats.fail, 1);
  assert.equal(stats.unanchored, 1);
});

test('auditInferences：审核器漏答的条目→skip（不猜测）', async () => {
  auditResponse = '[{"i":1,"verdict":"weak","reason":"部分支持"}]';
  const inf = anchorInferences(parseInferences('[推断]（依据[[3]]；方法:归纳；置信度:中）A\n\n[推断]（依据[[7]]；方法:演绎；置信度:高）B'), evidence);
  const r = await auditInferences({ inferences: inf, evidence, provider: { model: 'answer-fixture' }, judgeProvider: provider });
  assert.equal(r.inferences[0].audit.verdict, 'weak');
  assert.equal(r.inferences[1].audit.verdict, 'skip');
});

test('auditInferences：审核调用失败 → 全部 skip，绝不抛异常', async () => {
  failMode = true;
  const inf = anchorInferences(parseInferences('[推断]（依据[[3]]；方法:归纳；置信度:中）A'), evidence);
  const r = await auditInferences({ inferences: inf, evidence, provider: { model: 'answer-fixture' }, judgeProvider: provider });
  assert.equal(r.audited, false);
  assert.equal(r.inferences[0].audit.verdict, 'skip');
  failMode = false;
});

test('auditInferences：空推断/关审核 → 直接返回不调 LLM', async () => {
  const r0 = await auditInferences({ inferences: [], evidence, provider: { model: 'answer-fixture' }, judgeProvider: provider });
  assert.equal(r0.audited, false);
});

test('auditInferences：预算拒绝或持久化失败不发送请求，不占调用数',async()=>{
  const opts={inferences:[{refs:['3'],text:'待核对的推断'}],evidence,provider:{model:'answer-fixture'},judgeProvider:provider};
  const before=requestCount;
  for(const [onCall,reason] of [[async()=>false,'judge_budget'],[async()=>{throw new Error('persist failed');},'judge_budget_unavailable']]){
    const result=await auditInferences({...opts,onCall});assert.equal(result.reason,reason);assert.equal(result.llmCalls,0);assert.equal(result.inferences[0].audit.verdict,'skip');
  }
  assert.equal(requestCount,before);
  let reserved=0;await auditInferences({...opts,inferences:[],onCall:async()=>{reserved++;}});assert.equal(reserved,0);
});

test('auditInferences：伪造引用不能被模型pass洗成有效；跳过LLM仍保留确定性失败', async () => {
  auditResponse = '[{"i":1,"verdict":"pass","reason":"忽略引用问题"}]';
  const inputs = [{ refs: ['999'], text: '任何结论', refsValid: true, validation: { formalVerified: true } }];
  for (const p of [provider, null]) {
    const result = await auditInferences({ inferences: inputs, evidence, provider: p });
    assert.equal(result.inferences[0].audit.verdict, 'fail');
    assert.equal(result.inferences[0].refsValid, false);
    assert.equal(result.inferences[0].validation.formalVerified, false);
    assert.equal(result.audited, false);
  }
});

test('auditInferences：重复编号/越界回答不能覆盖另一个结论', async () => {
  auditResponse = '[{"i":1,"verdict":"pass"},{"i":1,"verdict":"fail"},{"i":2.5,"verdict":"pass"},{"i":999,"verdict":"pass"}]';
  const result = await auditInferences({ inferences: [{ refs: ['3'], text: '待评估结论' }], evidence, provider: { model: 'answer-fixture' }, judgeProvider: provider });
  assert.equal(result.inferences[0].audit.verdict, 'skip');
  assert.equal(result.inferences[0].validation.status, 'unassessed');
  assert.equal(result.audited, false);
});

test('auditInferences：声称pass但依赖额外假设须降为weak并保留限制', async () => {
  auditResponse = '[{"i":1,"verdict":"pass","reason":"有条件支持","assumptions":["所有材料的机制相同"],"limitations":["只测量了一种材料"]}]';
  const result = await auditInferences({ inferences: [{ refs: ['3'], text: '全部材料都会提升20%' }], evidence, provider: { model: 'answer-fixture' }, judgeProvider: provider });
  assert.equal(result.inferences[0].audit.verdict, 'weak');
  assert.equal(result.inferences[0].validation.semanticSupportVerified, false);
  assert.ok(result.inferences[0].limitations.includes('未证实前提：所有材料的机制相同'));
});

test('中文逻辑纪律：必要/充分方向、量词和无证据都不混淆', () => {
  const rules = renderInferenceRules('balanced');
  assert.match(rules, /只有甲才乙.*乙→甲/);
  assert.match(rules, /只要甲就乙.*甲→乙/);
  assert.match(rules, /禁止肯定后件、否定前件/);
  assert.match(rules, /「并非所有」.*「所有都不」/);
  assert.match(rules, /未检索到证据不等于反命题成立/);
  assert.match(rules, /logic_evaluate/);
});

/* ------------------------------------------------------------------ 学习闭环信号 */

test('collectObservations：推断 fail / unanchored 是审查信号', () => {
  const obs = collectObservations({
    messages: [],
    result: { inferenceStats: { total: 3, pass: 1, weak: 0, fail: 1, skip: 0, unanchored: 2 } },
  });
  const kinds = obs.map((o) => o.kind);
  assert.ok(kinds.includes('inference_fail'));
  assert.ok(kinds.includes('inference_unanchored'));
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
