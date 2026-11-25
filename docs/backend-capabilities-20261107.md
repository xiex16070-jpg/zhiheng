# 后端能力识别与请求边界（2026-11-07）

### 离线模型比较（2026-11-15）

固定模型实验库提交 `6488fa195abb94975e0897bbba355add77aa4ef6` 后，可以重算公开的历史结果。命令只读取 manifest 和四个经过内容审查的 Git 对象，验证逐文件 SHA，再从 20 对 case 逐项重算工具及任务计数。输出路径须为新文件。

```sh
node evals/model-pair-archive.mjs ../zhiheng-model-lab evals/results/archive-comparison.json
```

本次重算的完整结果见归档报告。同框架下基座与 v5 分别严格通过 3/20、5/20，均完成 20/20。模型请求总数分别为 45、54，工具调用 20、34，实际执行事件 17、31。独立的固定 32 题为 15/32、10/32，其平均请求时延分别为 7.81 秒和 13.24 秒。每个模型都有带版本的 7 项历史协议探针，区分“声明支持”和“在该实例、参数与时间下接收/拒绝了请求”。模型、运行时／实例、权重／adapter、profile、后端地址或授权范围变化，以及 TTL 到期，都要重测后才能将旧结论用于新的连接。查询账单、语义引用评判及云端 API 的匹配轨迹尚无可用公开记录，这些数值为 null。

若有已脱敏且可用于基准的轨迹，可为 API 和本地模型各建一个 `zhiheng/model-pair/1` JSON。格式示例见 [model-pairs.test.mjs](../tests/model-pairs.test.mjs)。一包包含 `kind=public_benchmark`、冻结题集 SHA、版本化模型身份和 cases。每个 case 只选一次替换点：

- 将获准公开的基准导出中 `callSnapshots[i]` 的实际 messages、tools、response、error 放入 snapshot，原样附上轨迹的 `capture` 元数据。系统提示、工具定义、上一步工具结果和用户约束均须与运行时一致。若记录缺少完整性标记或标记了脱敏／截断，保留在 `incompleteCapture` 计数。可从最初就使用公开材料的基准生成完整快照。
- `fixtureSha256` 对固定检索数据、模拟工具状态、用户/项目和审批快照求 SHA。`conditionsSha256` 对框架版本、预算、解码设定和后续固定执行策略求 SHA。两侧使用同一冻结说明和分组留出集。caseId 必须在包中唯一。
- rubric 的 `expectedCalls` 指定顺序与完整 JSON 参数（空数组表示无需工具），`responseSchema` 指定可信基准提供的 JSON Schema。未设置的维度不计入分母。对于 citationCorrect 与 taskSuccess，observations 需要独立核对或冻结评分结果和配套工件 SHA，勿用模型自评分。比较端只使用已记录的评分。latencyMs 为同范围实测时延，costUSD 为同范围实付美元；缺失留空。本地硬件耗时不能据此换算成账单。
- 可选模型元数据 `declaredCapabilities.features` 取自本次合同声明，`contractMeasuredAt` 记观测时间。分别记录模型修订、运行时版本。实测工具/结构化结果来自实际 snapshot 以及固定预期。

```sh
node evals/model-pairs.mjs BASE.json CANDIDATE.json NEW_REPORT.json
```

结果列出缺失、前态不一致和真正配对数，各指标只使用双侧有观测的共同分母。单步比较须由外部基准固定后续执行，才能解释其对最终任务的影响。已有历史任务级汇总缺少逐步前态摘要；没有把这些 20 项当作已完成单步替换。设计参考 [TwinRouterBench](https://github.com/CommonstackAI/TwinRouterBench)。

RouteFM 暂缓。现有公开结果只有两种本地权重、任务级结果与部分时延，没有覆盖云 API 的同态观测、独立路由上下文和按文献／任务分组的留出分割、各候选的可比成本。在这些输入齐备后，离线对比固定模型和现有选择策略，用严格成功率、覆盖率、总时延、可核算成本分项验收。推理还需上游 checkpoint 与编码器，本轮未下载。[RouteFM](https://github.com/LAMDA-Model-Reuse/RouteFM)

## 修复的问题

原 `streamChat` 在任意 HTTP 400 后先删除 `stream_options`，再用 `tool|function|parameter` 匹配错误并删除全部工具重试。无效的工具 schema、普通参数错误可能因此被掩盖为“无工具回答成功”。现在只有明确的顶层 `stream_options` 不支持错误可以删除该可选字段重试；明确不支持工具时立即报 `backend_capability_unsupported`，不再无提示切换任务语义。

## 能力合同

`src/server/backend-capabilities.mjs` 的每项状态为 `supported`、`unsupported` 或 `unknown`，分别记录 `tools`、`auto`、`none`、`required`、`named`、`strictTools`、`jsonObject`、`jsonSchema`、`tokenize`、`parallelToolCalls`。`parallelToolCalls` 指请求参数控制能力，不声称模型不会偶然输出多个调用。

未知接口保留原有 `tools + tool_choice:auto` 兼容方式，返回 `toolMode: compatibility-auto` 和明确的 unknown 状态；这不是已通过工具正确性验证。required、指定函数、strict schema、JSON 约束以及 parallel 参数均须有已确认支持的能力。当前仅实现了自有本地 runtime 的白名单合同，没有根据模型名推断 vLLM、Qwen-Agent 或云服务能力，也没有安装新推理框架。

本机 `zhiheng-model-lab/scripts/model_server.py` 在 `/v1/models`、`/health`、`/v1/tokenize` 追加声明：

| 自有 runtime v1 | 状态 |
| --- | --- |
| 工具 JSON 解析、auto/none、tokenize | 支持 |
| required、指定函数、strict 工具 schema、JSON object/schema 约束、parallel 控制 | 不支持 |

不支持的 strict/parallel 参数会在 tokenization 前拒绝，避免字段被忽略却使调用方以为约束已生效。runtime 声明包含 API 合同版本、实例 ID 和实际安装的 Transformers/PEFT/Torch 包版本。版本号描述 API 实现，不能证明模型质量或调用参数符合业务 schema。

## 信任与缓存

- 只有现有 `verifyLocalModelProfile` 的 loopback 地址检查、精确 model 匹配和 profile 摘要握手通过后，才录入自有 runtime 声明。`localhost` 握手固定连接 `127.0.0.1`，禁止重定向。profile 提示词、schema 和摘要生成方式不变。
- runtime 名称和版本必须命中已审查合同；即使服务自称支持 required/strict，也不能越过本地实现上限。旧服务或陌生 runtime 保持 unknown。摘要是协议一致性校验，不是远端二进制的密码学身份认证。
- 浏览器提交的 `backendCapabilities` 和持久化 settings 不被用于升级能力；现有配置字段白名单依旧拒绝此字段。能力元数据不授予任何工具权限，不跳过 Ajv、审批、用户/工作区隔离或网络地址校验。
- 内存缓存 TTL 为五分钟、最多 256 条。连接键包含完整规范 endpoint（保留路径大小写）、model、密钥摘要及可用的用户 scope；runtime 版本/实例、profile/adapter 摘要变化使旧记录失效。更改/删除保存连接、握手失败、TTL 到期均失效，不把能力状态写入凭据文件。
- HTTP 400 仅能降低对应连接能力，不能升级其他能力；错误必须明确指向顶层字段不支持。`tools[0].function.parameters` 等 schema 错误保留原始失败，不能把整个 tools 判成不支持。
- 同一 runtime 的明确拒绝在原 TTL 内优先于重复 `/models` 声明，新的 profile 握手不能清除拒绝或持续延长它的失效时间；实例/版本更换或 TTL 过期后再依据新握手判断。

## 调用接口

`streamChat` 新增可选 `toolChoice`、`responseFormat`、`parallelToolCalls`，现有调用无需修改。默认 toolChoice 为 auto；显式 none 可以省略工具定义，若后端仍返回工具调用则报错。返回原字段并追加 `backendCapabilities`、`toolMode`；模型连接状态也追加能力信息，密钥仍不返回客户端。

内部 API：`backendCapabilities.get(provider)`、`invalidate(provider)`；`selectBackendRequest(provider, options)` 在发起请求前决定字段或抛出能力错误。仅 profile 握手调用 `attestLocal`。高级约束能力目前不作未经验证的正向声明，后续新增后端需要独立适配合同和离线/真实兼容评测。

## 验证与限制

离线测试覆盖：缓存 TTL/路径/模型/密钥/scope/运行时隔离及失效；自报能力不能升级；unknown auto；原生 auto/none；拒绝未支持的强制/严格/并行约束；不把 schema 错误吞掉；stream_options 精确回退；本地 `/models` 与 tokenize 声明一致、无模型加载即可验证拒绝边界。

本轮命令与结果：主项目 `node --test tests/backend-capabilities.test.mjs tests/model-profile.test.mjs tests/model-connections.test.mjs tests/llm-stream.test.mjs tests/conversation-profile.test.mjs`，24/24 通过；模型实验室 `.venv-model/Scripts/python.exe -m unittest discover -s tests -p backend_capabilities_test.py -v`，3/3 通过。两仓库所改文件 `git diff --check` 无空白错误。

随后已在本机真实基座和 v5 runtime 各执行 7 项 API/tokenizer 合同探测，均通过：auto/none 接受，不支持的 required/named/strict/JSON/parallel 请求明确拒绝。探测本身不调用生成接口；同条件真实生成评测另见 [最终记录](context-quality-repairs-20261107.md)。未据此宣称支持严格解码或提升模型质量。旧服务只有重启后才会报告新声明；没有声明仍为 unknown。
