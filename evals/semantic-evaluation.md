# 补充语义评测

现有 `formal-cases.json`、模型实验库 `holdout.json` 不修改。`semantic-evaluate.mjs` 要求调用者提供预先记录的规范化 LF SHA-256，匹配后才能运行；应先固定题目、人工标注，再改参数。不能用运行后的结果反选题目。

`support-adversarial-draft.json` 是本轮 AI 编写的 20 个不受支持/矛盾例和 10 个支持例，涵盖条件方向、否定、数量、范围、时间、因果、未知与未审稿状态。它不是100道人工作题，也不能用来宣布达到正式晋升门槛。初始冻结指纹：

`3240f4ca339b71272ebd6f303ff2a38f54ed66470ade3a0cad77cac4039be71b`

```powershell
node evals/semantic-evaluate.mjs --mode support --cases evals/support-adversarial-draft.json --sha 3240f4ca339b71272ebd6f303ff2a38f54ed66470ade3a0cad77cac4039be71b --user OWNER_ID --answer-model ANSWER_MODEL --output evals/results/support-run.json
```

先在本机设置中配置不同于回答模型的独立裁判，默认关闭。每批最多12句，一个请求、没有自动重试；报告逐条输出状态、模型名、调用次数及usage。默认输出预算4096 token（512–8192可调），超时45秒（1–60秒可调）。长推理模型可能把输出预算用于 reasoning token，`finish_reason=length` 明确记录为 `judge_output_limit`，不认证部分结果。不设裁判时调用数0、assessed0、检出率/误报率为null，不能把未审核当通过。

报告同时给出正例和反例的 assessment coverage。检出率以全部反例为分母；误报率以已评估正例为分母，并提供将未评估正例全当错误的上界。`uncertain` 单列，不能当作支持；必须连同覆盖率看误报率，不能把“4条正例已评估、6条未评估、0误报”说成10条正例全通过。

2026-11-07 对这份冻结草案使用 `deepseek-v4.1-flash-1017` 实跑两次，各3个请求。1800 token预算完成24/30（反例20/20、正例4/10）；最后6条因推理耗尽输出预算而未评估。仅修预算处理后，以4096 token复跑相同题集，完成30/30、反例20/20检出、正例10/10中0误报。单批耗时10.518–27.735秒，最长3906输出token，因此新默认超时设为45秒。两个原始报告分别是 `results/support-live-20261107.json` 与 `results/support-live-20261107-budget4096.json`。第一次原始报告的 `falsePositive:0` 缺少正例覆盖信息，必须按上述4/10解读；保留历史文件，没有改写失败证据。该结果只验证合成句子裁判和预算修复，**不是人工盲测、真实RAG端到端或模型晋升结果**。

检索扩展格式：`{version,humanReviewed,cases:[{id,question,expectedRefs:["固定原始ref"],docIds?:["私有文档ID"]}]}`。需要人核对同义改写、中英互查、符号公式及用户PDF资料的精确来源ID。私有题目与导出材料不要提交。至少100题且人工审阅后，再进行预先冻结的独立对照；本轮没有替用户伪造这些标注。

```powershell
node evals/semantic-evaluate.mjs --mode retrieval --cases PRIVATE_CASES.json --sha PRE_RECORDED_SHA --user OWNER_ID --output evals/results/retrieval-channels.json
```

报告分别列 paper/kb/vector/fused 的 Hit@5、MRR@5、来源ID精确率和通道降级信息。`expectedRefs` 是事先标注的相关来源集合，精确率以召回条目为分母。对照时使用相同题集、语料、分区和模型指纹，记录是否开启语义模型与重排。没有进行真实BGE推理和独立人工裁判前，不声称MRR提升或80%检出率。
