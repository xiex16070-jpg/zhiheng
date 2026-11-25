# 问答效果评测

评测通过 Promptfoo 自定义 provider 调用真实 `/api/search`、`/api/chat` SSE 与 `/api/source`，不替代 `npm test`。每轮启动独立的临时文件存储与随机端口，每个用例使用新身份，关闭学习、联网和命令执行。不会连接现有 MySQL、Redis、Qdrant 或修改业务语料。应用最低版本为 Node 22.12.0，支持范围见根 `package.json`。Promptfoo 0.125.1 单独要求 Node ≥22.22.0。

## 运行检索基线

```powershell
npm ci --prefix evals
npm run eval:retrieval
```

内置 `fixtures/papers.jsonl` 是 **7 篇人工编写的受控摘要**，不是实际发表论文。`cases.json` 包含 12 个自然语言研究问题，覆盖中文和英文检索、多来源、结论过度泛化、无证据、无依据数值、直接注入和上传文档注入。检索模式运行其中有固定期望 ref 的 10 个问题，仅测 Recall@5、MRR 和延迟；不生成答案，不评判拒答或注入防护。小样本满分只说明基线流程可用。

首轮结果见 [已记录的基线](baselines/retrieval.json)。正式验收前，替换或扩充为有授权的真实论文、真实问题和人工标注的 expectedRefs；保留困难负例和留出集，避免只调整到训练问题上。

## 运行真实问答与独立裁判

在终端设置 OpenAI 兼容服务地址（包含 `/v1` 等前缀）：

```powershell
$env:EVAL_LLM_BASE_URL = 'https://your-answer-service.example/v1'
$env:EVAL_LLM_MODEL = 'your-answer-model'
$env:EVAL_LLM_API_KEY = '<key>'
$env:EVAL_JUDGE_BASE_URL = 'https://your-judge-service.example/v1'
$env:EVAL_JUDGE_MODEL = 'your-judge-model'
$env:EVAL_JUDGE_API_KEY = '<key>'
npm run eval:chat
```

两个服务仅在确实无需鉴权时可省略 Key；其余四项缺失会直接报错。建议裁判与作答模型独立，并人工抽查裁判分歧。此命令发送问题、回答和引用原文给配置的服务，会产生对应推理费用。`EVAL_TIMEOUT_MS` 默认每例 180000 毫秒。

判分分两层：确定性检查检索期望、关键概念、明确拒答、注入标记、意外写工具、引用有效性及字符位置；独立裁判把回答拆成事实结论，逐条评估标注引用是否支持，同时评价是否答题、拒答是否恰当、是否抵抗注入。裁判的 claim 必须逐字来自回答，引用必须实际出现在回答且有来源；错误 JSON、缺字段或伪造结论不能记为有效测量。LLM 裁判仍有误差，需要人工审阅，不能代替领域专家。

报告区分 `semanticSupportAttempted`、`semanticEvaluatedCases` 和 `semanticSupportMeasured`；只有所有用例均取得有效裁判结果时，最后一项才为 true。结构性 `grounded`、有效引用 ID 和 `citation_location` 均不等价于结论受支持。失败、超时和裁判不可用都会使命令非零退出。未运行真实模型时，不提供虚构的语义质量分数。

## 比较 BGE 实验

先按 [独立服务说明](../services/reranker/README.md) 预热模型，然后在同一套语料、问题、作答及裁判配置下运行：

```powershell
$env:EVAL_RERANK_ENABLED = '0'
npm run eval:retrieval
$env:EVAL_RERANK_ENABLED = '1'
npm run eval:retrieval
npm run eval:compare -- evals/results/<baseline>.json evals/results/<rerank>.json
```

真实问答比较时，两次都改用 `npm run eval:chat`。评测专用开关 `EVAL_RERANK_ENABLED` 覆盖应用的 `RERANK_ENABLED`；地址、模型、Key 等仍使用 `RERANK_*` 环境变量。实验启用但服务降级时，用例会失败，防止把原 RRF 结果标作成功 BGE 实验。

原始报告保存在已忽略的 `evals/results/`，记录代码提交、工作区是否有改动、语料和问题哈希、模型及逐例结果。比较命令拒绝语料、问题、模式或作答/裁判模型不同的报告。延迟受硬件与预热影响，模型输出也可能波动；建议固定配置、每组重复至少三次并检查逐例退化，再决定是否开默认开关。

## 扩展样本

在 `cases.json` 增加稳定 `id`、`category`、`question`、`expectedRefs`，按需要添加 `required`、`forbidden`、`expectRefusal`。`document` 字段会通过真实上传接口加入该用例私有知识库，可用于检验来源注入。原始语料和用例哈希随报告保存，修改后应重新建立基线。`required` 是词面约束，合理同义表达可能误判，需结合裁判与人工回看。

官方接口参考：[Promptfoo Node API](https://www.promptfoo.dev/docs/usage/node-package/)、[自定义 provider](https://www.promptfoo.dev/docs/providers/custom-api/)、[JavaScript assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/)。
