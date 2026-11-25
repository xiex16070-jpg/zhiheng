# 人工语义评测：独立盲评、导入与可追溯性

2026-11-15 已实际生成本轮独立空白包 `evals/results/reliability-20261115/blind/`。协调清单 SHA-256 为 `e85b15e64332228022cd6e1e5f3aff11f7a508c200de846758a0203feb1d340c`，共 6 题、0 份真人票。把 A、B 两包分别交给两名审核人，按下方步骤导入。未安装 Label Studio 时也可按 `evals/labeling-templates/claim-support.xml` 的字段在各自 JSON 副本填写 `annotations`，填写人和独立性由协调人核实，选区须保留原文和 UTF-16 偏移。仲裁人在出现分歧时加入。新导入检查会拒绝仅将同一份导出重新排序、带父票引用的标注，以及只改大小写、全半角或首尾空格的重复审核人。结果与任务清单绑定；重新生成的随机任务 ID 属于另一批。

本次交付的是**可运行的离线标注流程**，没有安装 Label Studio，没有代替人填写答案，也没有产生人工评测通过率。新增 6 题试点使用仓库内固定版本的 Software Foundations 中文译本原文，问题和待审结论由 AI 编写，**没有预置 gold 标签**。它只帮助验证流程，不是独立研究论文测试集，也不满足现有晋升条件。

## 已有能力与本次修复

- `evals/bge-literature.mjs` 原来已经支持 4 道无证据负例，并导出空 `reference_context_ids`。实验库 `evals/ragas_eval.py` 也已将空检索正例记 0、留在正例分母，空参考来源另记不适用。本次没有重复改写这些算法。
- `evals/semantic-evaluate.mjs` 的 retrieval 入口现在允许 `expectedRefs: []`，但必须显式 `expectInsufficient: true`；反之负例不能带非空参考来源。正例 Hit@5、MRR、来源 ID precision 公式保留。新增独立的负例计数和 `insufficientDetection`，采用已有 BGE 的 `weak || empty` 约定；这仍是检索层代理指标，不是回答拒答质量。
- `D:/VSCODE/zhiheng-model-lab/evals/run.mjs` 的 formal→Ragas 桥保留负例，并标记 `controlled_context:false`，不伪造生成回答。32 题冻结集、28 题 BGE 集、原始评分定义与 SHA 均未更改。
- 已有支持评测的覆盖率、检出率和误报上界保留；新增支持／矛盾／证据不足三类混淆矩阵及各类 precision、recall、F1。recall 和整体 accuracy 的分母包含所有应评样本，未评定与不确定单列。
- `humanReviewed:true` 不再是有效证明。评测入口重放检查导出原件、协调清单、两份独立票、仲裁和原文跨度后，才接受“协调人声明的人工审核”。全部报告仍 `promotable:false`。

## 工具边界

[Label Studio 社区版许可证为 Apache-2.0](https://github.com/HumanSignal/label-studio/blob/develop/LICENSE)。[官方版本矩阵](https://labelstud.io/guide/label_studio_compare)说明社区版没有内置审阅分配、标注一致性指标和完整共识工作流；[快速入门](https://labelstud.io/quick-start/)还说明开源版用户都有管理员级访问。仅在同一实例建立两个项目，不构成权限隔离的盲评。

应由协调人提供两份独立副本，交给两名真实审核者；如采用社区版，应使用相互隔离的实例／存储，或者由协调人控制离线交接。不要把协调清单、另一人的导出、模型名、排名、AI 标签交给审核者。来源署名、许可证和公开原文仍保留。第三人只在两个独立判断都完成后仲裁分歧。

本代码不安装或启动标注服务，不进行网络下载，不接 Agent 工具链，不读取私有知识库，不自动训练或晋升模型。导出器只接受显式声明公开、带 HTTPS 来源与许可证的材料；这项声明不能自动证明版权与公开性，协调人须核对来源。可选服务的安装和浏览器实测仍是后续工作。

## 1. 生成未标注试点

从项目根目录运行，输出路径必须不存在；父目录需已存在。`evals/results/` 已在 gitignore 中。

```powershell
node evals/annotation-pilot.mjs --output evals/results/public-annotation-pilot.json
node evals/annotation-cli.mjs export --input evals/results/public-annotation-pilot.json --out-dir evals/results/public-annotation-blind
```

生成器核对公开正文的 `contentSha256`、原记录身份和 MIT 许可证，附带作者、译者、固定提交 URL 及完整许可证文本。数据包的 `provenance` 清楚标记 AI 编写任务、尚无人工答案。导出产生：

| 文件 | 交付对象 | 内容 |
| --- | --- | --- |
| `blind-a.json` / `blind-b.json` | 分别给审核者 A、B | 随机任务 ID、独立打乱次序、问题、待审结论、原文、署名与许可；无模型名、分数、预期标签 |
| `claim-support.xml` | 两位审核者 | Label Studio 的纯文本界面配置 |
| `coordinator-manifest.json` | 仅协调人 | case ID 映射、完整原文、SHA、原文范围、任务清单、清单指纹 |

自备公开题集输入格式：

```json
{
  "version": "public-support-v1",
  "cases": [{
    "id": "coordinator-only-id",
    "question": "问题的明确语境",
    "claim": "需要判断是否被原文支持的一条具体结论",
    "source": {
      "ref": "fixed-source-id",
      "uri": "https://official.example.org/paper",
      "license": "实际许可",
      "public": true,
      "attribution": "实际作者与来源",
      "licenseNotice": "需要随原文分发的许可声明",
      "text": "固定版本的完整来源文本"
    },
    "span": {"start": 0, "end": 13}
  }]
}
```

示例偏移仅演示格式，须按实际文本设置。`source.text.slice(start,end)` 就是审核者看到的片段；偏移采用 JavaScript **UTF-16 code units，右侧不含 end**，不做隐式换行归一化或 Unicode 转换。选区文本必须逐字吻合，不能截断代理对。对包含 emoji 的材料须核对导出器实际偏移单位；如不符，导入会拒绝，不能静默改偏移。

## 2. 两名审核者独立提交

把 `claim-support.xml` 放入 Labeling Setup，各自导入一份 blind JSON。不要导入 predictions，不启用自动标注。界面要求：

- `supported`：原文足以支持待审结论；必须选取证据跨度。
- `contradicted`：原文明确与结论冲突；必须选取冲突跨度。
- `insufficient`：给定证据不足以判支持或矛盾。缺少证据并不等于证明相反结论。
- 每条写判断理由。范围、否定、条件方向、数量、时间与因果关系均按原文处理。

原文支持判定必须包含 **claim**。只有“问题＋原文”的标注属于相关性或可回答性，不能自动变成答案语义支持结果。

完成后导出 **原始 JSON**，保留 `data/annotations/result/completed_by/updated_at` 等字段。根据[官方导出说明](https://labelstud.io/guide/export)，默认导出可能省略未标注任务，同时包含取消任务；本流程总以协调清单为分母，报告遗漏、未提交及取消，不以导出数量推算完成率。

协调人保存 roster，例如：

```json
{
  "a": {"id":"reviewer-A-real-identity","exportUserId":1,"kind":"human","attestedBy":"coordinator-real-identity","attestedAt":"2026-11-07T12:00:00+08:00"},
  "b": {"id":"reviewer-B-real-identity","exportUserId":1,"kind":"human","attestedBy":"coordinator-real-identity","attestedAt":"2026-11-07T12:00:00+08:00"}
}
```

两个独立实例的本地用户 ID 可以同为 1，但 `id` 必须是不同真实的人，并与 `completed_by` 所指用户对应。`kind:synthetic_fixture` 用于软件测试，永远不会被计为人工审核。保留个人身份信息的 roster 和导出不得提交公开仓库。

## 3. 导入与仲裁

```powershell
node evals/annotation-cli.mjs import --manifest evals/results/public-annotation-blind/coordinator-manifest.json --review-a A-export.json --review-b B-export.json --roster reviewers.json --out-dir evals/results/review-round-1
```

导入器检查源清单SHA、原文SHA、任务数据、任务与annotation重复、未知任务、人工账户映射、原始导出内容及SHA、非手工标注来源、证据选区和必填理由。缺失/取消或标签分歧未仲裁时，只输出 `import-report.json`，进程退出码2，**不产生可用题集**。格式错误／篡改退出码1。

分歧报告包含 `taskId` 和按 A/B 顺序的 `voteDigests`。第三名独立审核者可在单独 JSON 中给出：

```json
[{
  "taskId": "报告中的任务ID",
  "voteDigests": ["报告中的A票SHA", "报告中的B票SHA"],
  "reviewer": {"id":"third-reviewer","exportUserId":"coordinator-record","kind":"human","attestedBy":"coordinator-real-identity","attestedAt":"2026-11-07T14:00:00+08:00"},
  "reviewedAt": "2026-11-07T14:00:00+08:00",
  "verdict": "insufficient",
  "rationale": "实际仲裁理由，不是自动多数票",
  "evidenceSpans": []
}]
```

支持／矛盾裁决需要非空 `evidenceSpans`，格式为 `[{"start":0,"end":实际末位,"text":"逐字证据"}]`，偏移相对展示片段。仲裁人不能是原两人；不存在的任务、重复仲裁、非分歧任务的多余仲裁、过期票SHA均拒绝。重新导入时加 `--adjudications decisions.json`，使用另一个全新输出目录。

完整导入才产生 `reviewed-cases.json`、配套 `reviewed-cases.json.sha256.json` 及报告。证明链包含原始导出文本/哈希、完整协调清单、两份票和仲裁决定；离线评测会重新计算整个派生结果。**这能发现修改和遗漏，不能用密码学证明实际操作人是人类、或者两人没有串通**；身份与独立性仍需协调人核实，故状态叫 `coordinator_attested_human`。

## 4. 冻结后使用

先归档来源包、原导出、roster、仲裁及最终 SHA。使用实际产生 `reviewed-cases.json` 的完整导入目录：首轮没有分歧时是 `review-round-1`；经过仲裁再导入时是新目录。以下示例假设在 `review-round-1` 已完整导入，再配置独立裁判并运行：

```powershell
node evals/semantic-evaluate.mjs --mode support --cases evals/results/review-round-1/reviewed-cases.json --sha 配套文件中的SHA --user OWNER_ID --answer-model ANSWER_MODEL --output evals/results/human-support-eval.json
```

配置独立模型后才会产生裁判调用；不配置时仍是 `assessed:0`，不是通过。人工标签用于衡量裁判对结论支持关系的判断，不能用裁判分数替代实际用户的答案质量。

一致性统计使用**仲裁前**两份票：逐类矩阵、覆盖率、观测一致率、Cohen's kappa。缺标不进入已配对一致性分母，但清单总数和覆盖率始终报告；全为单一标签导致期望一致率1时，kappa为null。模型三类评测另外包含 uncertain/unassessed 列，按全部应评样本报告 accuracy、各类 recall，预测某类为零时 precision为null。

此第一版导入的是**结论支持关系金标**，不会把 `insufficient` 自动转成全库无证据负例，也不会把“能支持某句话”冒充问题检索相关性。检索扩展格式仍是 `question/expectedRefs/expectInsufficient`：空参考必须经过固定文献范围的独立审核，不能从单一片段推断整个知识库无答案。本次修复两处负例入口，不声称已经收集真人检索金标。真实题集应扩展至多个文献主题，按文献分组留出，禁止自动进入训练集；现有晋升门槛不改变。

## 验证与边界记录

- `node --test tests/annotation-workflow.test.mjs tests/semantic-support.test.mjs`：覆盖公开原文校验、盲导出、CLI往返、来源重放、取消遗漏、重复与篡改、第三人仲裁、非法人工声明、三类分母、空ref负例。
- 实验库 `node --test tests/retrieval-annotation-bridge.test.mjs`：覆盖负例不丢失、公开原文映射和 live provenance。
- `tests/semantic-support.test.mjs` 显式清空 mock 的 `EMBEDDING_REVISION`，防止本机部署BGE的 `.env` revision污染模拟服务。未改变生产向量身份校验。
- 测试导出的审核者均为 `synthetic_fixture`，实际人工标注数量仍为0。Label Studio实际安装、界面选区导出兼容性、两名真人审核与第三人仲裁尚待真实执行；未宣称完成这些人工工作。
