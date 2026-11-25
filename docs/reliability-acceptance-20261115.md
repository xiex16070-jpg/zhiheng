# 文献可靠性与离线评测验收 · 2026-11-15

工作基线为 `codex/audit-fixes@651442e1d6799b2c19c3dc614f4fcc6a8c0ba415`。工作区与上级目录未发现适用的 AGENTS.md。原有三份未跟踪笔记保留。本次变更在工作区供审阅，生产服务和模型权重均沿用原部署。

下表保留首次验收时的告警及运行结果。修复后的扫描与版本实测见文末[安全与运行时复验](#安全与运行时复验)。

| 批次 | 现有能力与变更入口 | 本轮实测及边界 |
|---|---|---|
| 1 出版状态 | 保留三源检索。新增 `src/server/publication-review.mjs`、`src/ui/publication-review.js`，接入 `server.mjs`、原文阅读器、导入与引用卡。按用户和 DOI 缓存，可取消到期复查授权。 | 20 项相关测试通过。公开 DOI 经匿名网络请求，三源均 HTTP 200，汇总为撤稿；Crossref 同时保留更正及撤稿公告，第二读命中缓存。实际导入/授权/撤销在隔离实例用合成记录验证。公开 DOI 查询快照 |
| 2 参考文献导出 | 保留既有编号、证据检查、Zotero 集成。新增 `src/server/reference-export.mjs`，补齐 `src/agent/text.js`、`store.mjs`、`rag.mjs`、`scholar.mjs`、`joint-research.mjs` 的保存/元数据路径，更新导出技能。 | CSL-JSON、BibTeX、RIS、APA 均使用已保存引用，支持历史消息、中文姓名、摘要标识、缺 DOI 和特殊字符。隔离 HTTP 覆盖项目与用户归属。Chromium 测试实际下载 JSON 并核对内容。命令和格式回读证据 |
| 3 MCP | 现有 SDK 1.32.2 与鉴权继续使用。新增独立锁定的测试工具 `evals/protocol-tools/`。 | 官方 conformance 0.1.16 在隔离的 Streamable HTTP 服务通过初始化、ping、列工具 3/3，返回 9 个工具。stdio、身份和审批由项目自身节点测试覆盖。官方子集结果 |
| 4 属性测试 | 新增 `tests/hanlogic-properties.test.mjs`、`background-properties.test.mjs`、`helpers/check-property.mjs` 并扩展 `exec-approval.test.mjs`。 | 种子 651442。独立 BFS 判定小图可达、否定和例外，与三种算法结果核对 100 例；取消 24 例，审批/恢复/隔离 12 例。最小反例写入临时目录，已复现收缩与回放。验收记录 |
| 5 安全扫描 | OSV-Scanner 2.7.1、Betterleaks 1.10.1 的校验、输入白名单和报告在 `evals/protocol-tools/`。 | Python 锁 81/81 个精确包识别，另三份清单 3/3、1/1、1/1。setuptools 78.1.0 命中三组公告，最高报告分值 8.8。Betterleaks 扫描 398 份源码（含 19 份本轮新增）和 1 份合成导出，正负控制符合预期，报告 1 条测试文件中的 generic-password 候选。两条扫描命令均按设计返回 1。禁止联网验证凭据，告警保留待人工判定。OSV · Betterleaks |
| 6 两页 PDF | 复用现有 MinerU Tasks 适配器。新增 `evals/pdf-pages.mjs`、`tests/pdf-pages.test.mjs`，对照逐页 Markdown、字符错误率和阅读顺序。 | 实际生成的二页合成 PDF 用于验证流程，模拟输出保留 `fixture_scored` 标识。缺授权材料、人工金标及隔离 MinerU 地址，真实 OCR 计分页数为 0。[运行说明](../services/mineru/README.md) |
| 7 人工评测 | 复用原盲评 CLI、六道公开教材题与第三人仲裁。修复 `evals/annotation-workflow.mjs` 对复制导出、继承票和审核人身份变体的检查。 | 合成票完成导出/导入与重放校验。已实际生成两份独立的待填包，真人票 0。[交接与清单 SHA](human-annotation-workflow-20261107.md) |
| 8 离线模型适配 | 复用 `callSnapshots` 和已有后端能力合同。新增 `evals/model-pairs.mjs`、`model-pair-archive.mjs`、`tests/model-pairs.test.mjs`。 | 只取模型实验库中经过内容审查的 Git 元数据，重算 20 个同条件工作流及固定 32 题汇总。逐步同前态、独立引用正确率、实付成本与云 API 对照缺可用证据。新工具能报告缺失、不同前态、截断及无共同观测。真实后端能力报告带时间和版本。重算结果 |
| 9 RouteFM | 按条件评估，尚未运行。 | 缺少分离的路由上下文和独立中文留出集、各模型同题成本及 API 对照。未下载权重、启用路由或产生新推理费用。[输入契约与失效条件](backend-capabilities-20261107.md) |

### 命令与结果

以下项目和浏览器测试在隔离源码副本运行。副本仅含公开追踪的源码、构建资产和公开语料，复用依赖目录。测试使用独立服务端口、合成身份与临时数据。没有读取生产凭据或用户知识库。带路径的扫描与手工命令详见[固定版本运行说明](../evals/protocol-tools/README.md)。

| 实际命令或操作 | 结果 |
|---|---|
| `npm test`、`npm run check:ui` | 最终 679/679，0 跳过；三个 UI 构建产物一致，23 份样式检查通过。首轮 677/678，一项后台学习测试在并行负载下过早断言，单项复跑通过。修正测试等待持久化状态并增加离线前态用例后重跑全量。|
| `python scripts/ui-experience-smoke.py` | 隔离 Chromium，三种宽度 × 两种主题均通过，0 次真实模型调用。首次导出的源码副本缺少 Git 元数据，在报告收尾处失败；补上基线元数据并用最终代码重跑。|
| `node --test tests/publication-review.test.mjs tests/publication-review-http.test.mjs tests/scholar.test.mjs` | 20/20。真实公共 DOI 另以无凭据的 `createPublicationReviews` 调用经 HTTPS 请求原文元数据，服务返回、公告 DOI、时间和缓存结果见表 1。 |
| `npm run test:properties` 及隔离 Node 版本测试 | 默认确定种子，审批恢复包含重复与并发情况。Node 20.19.5 指定组 12/12。完整应用在 Node 20.8.0 有基线模块加载失败，详见兼容记录。 |
| `python evals/protocol-tools/mcp_conformance.py --node <24.22.1的node.exe>` | 3/3。Windows Node 24.14.1 的官方 CLI 曾在写出检查后退出异常；此组合未计为通过。 |
| `python evals/protocol-tools/dependency_scan.py --cache <已校验缓存>`、`python evals/protocol-tools/secret_scan.py --cache <已校验缓存> --approved-export evals/protocol-tools/approved-exports/public-example.jsonl --approved-source <19份本轮新源码>` | 两项均为 findings。扫描默认跳过历史、未指定导出、用户文件、运行配置和环境目录。文件名单及公告别名保留在对应 JSON。 |
| `node evals/pdf-pages.mjs run` | 显式 skipped，0 页。正常、缺页和错序用例由隔离测试另测。 |
| `node evals/annotation-pilot.mjs --output evals/results/reliability-20261115/public-pilot.json`，随后用 `annotation-cli.mjs export --input` 指向该文件，`--out-dir` 为同目录的 `blind` | 六题均有公开原文和许可信息。盲包、协调清单已经生成，可直接分发。 |
| `node evals/model-pair-archive.mjs ../zhiheng-model-lab docs/evidence/model-pair-archive-20261115.json` | 核验四份已审查文件的 SHA，重算同条件归档结果，新增模型调用 0。 |
| `git diff --check` | 通过。 |

隔离 Node 和浏览器原始记录保存在本机 `evals/results/reliability-20261115/`。已有检索、MinerU、MCP、追踪、记忆、审批和 UI 功能通过现有测试做回归。Langfuse 实例、私人轨迹及生产 BGE 未用于本次实测。Promptfoo 和训练框架继续沿用既有集成。

### 人工验收与兼容性

1. 在隔离实例导入有明确 DOI 的资料，在原文面板允许复核。核对公告 DOI、查询时间、缓存描述与撤销按钮。分别用两个测试用户检查引用可见性。从带引文的回答打开「导出参考文献」，用参考文献管理器导入 RIS 或 BibTeX，核对中文姓名与编号。
2. 提供授权范围明确的两页 PDF 及隔离 MinerU 的地址。标注者先独立转写两份 Markdown 并标出各页唯一的顺序锚点，再向服务提交 PDF。二页基线通过后按双栏、表格和扫描件分别建集。
3. 将两份盲包分给不同审核人。协调人先汇总独立票，分歧交第三人仲裁，再以新目录导入。此步骤产生真人覆盖率和一致性。
4. 比较 API 与本地模型，需要获准用于公开基准的两份完整快照、固定工具状态及授权摘要、同一评分规则，以及可核对的时延和成本。附录命令可离线比较。对 OSV 公告，下一步在独立的 Windows/Python 3.12 环境验证更新版本与原 CPU 依赖锁和嵌入服务的兼容性。

Citation.js 0.7 系列与 fast-check 为 MIT；分发 CSL 样式和语言数据时保留包内的独立署名和授权。官方 conformance 和 Betterleaks 为 MIT，OSV-Scanner 为 Apache-2.0。PDF 样本须单独核对授权，本次没有分发 OmniDocBench 数据。部署 MinerU 时应按所用版本核对模型、商业服务及归属条款。应用声明的 Node 最低版本与基线依赖的实际要求有差异，20.8 的纯导出测试和完整服务结果分别留痕。引用与运行记录 · [MinerU 许可说明](../services/mineru/README.md)

### 安全与运行时复验

Windows CPU 锁中仅调整了 setuptools 的版本，从 78.1.0 升至 84.1.0。三个公告各自给出的首个修复版本为 78.1.1、83.0.0、84.1.0。使用同一份 PyPI 公告库（generation `1794710886976880`）前后对照，OSV-Scanner 2.7.1 的发现由三组降至零。四份清单中的精确版本均被识别。已改用可在干净虚拟环境重建整个 Windows CPU 锁的安装命令，PyTorch wheel 来自官方 CPU 源并校验 SHA-256。[三组公告之一](https://osv.dev/vulnerability/GHSA-5rjg-fvgr-3xxf) · [第二组](https://osv.dev/vulnerability/GHSA-h35f-9h28-mq5c) · [第三组](https://osv.dev/vulnerability/GHSA-xmj3-9gf7-h52w) · 复扫快照 · [安装步骤](../services/embedder/README.md)

Betterleaks 原命中位于测试构造的嵌套 password 字段，仅传给 `publicSteps` 检查对外步骤的脱敏结果。改用明确的公开测试标记，逐项断言敏感字段被遮盖、旁边的结果数字保留。继续使用默认规则，关闭在线验证。正控制触发预期规则，负控制和本轮源码、允许的合成导出均为零命中。前次命中 · 复扫快照

根应用的 Node 范围现为 `^22.12.0 || ^24 || >=26`。最低版本来自已锁定的 sanitize-html 2.18.1；docx 的必需依赖 nanoid 6.0.2 还限制了可用主版本，因此 23 和 25 不在范围内。在 235 项根锁依赖的 Node 声明上逐项验证了范围的包含关系。独立 Promptfoo 包另需 22.22.0 或以上版本。CI 在 Linux 运行精确 22.12.0 及 22、24、26 三条发布线，并在 Windows 添加精确 22.12.0，使用 `npm ci --engine-strict`。[依赖声明](../package.json) · [CI 配置](../.github/workflows/test.yml)

实际在 Windows 22.12.0 安装后，首轮全量测试暴露六处文件读取失败。路径查询与句柄查询在同一文件上返回了不同的设备编号。工作区二进制读取现在用两次独立打开的只读句柄比较卷号、完整文件编号、大小和纳秒修改时间，并复查类型、链接数和工作区路径。新回归用例验证读取期间同名、等长、修改时间相同的文件被替换时会拒绝交付旧结果。[读取实现](../src/server/file-tools.mjs) · [回归测试](../tests/file-capabilities.test.mjs)

| 实际复验 | 结果 |
| --- | --- |
| Windows Python 3.12.14 新环境，按锁安装后逐包核对、`python -I -m pip check`、导入 BGE 类、`python -m unittest discover -s services/embedder -p test_server.py` | 81/81 版本一致，依赖完整，嵌入服务契约测试 3/3。 |
| `python evals/protocol-tools/dependency_scan.py --cache <缓存>` | OSV 离线复扫退出 0，四份清单分别完整识别 81、3、1、1 个版本。 |
| `python evals/protocol-tools/secret_scan.py --cache <缓存> --approved-export evals/protocol-tools/approved-exports/public-example.jsonl` | 398 份源码及 1 份合成导出，零发现，退出 0。 |
| `python evals/protocol-tools/mcp_conformance.py --node <22.12.0的node.exe>` | 官方子集 3/3，协商后列出 9 个工具。机器报告 |
| `npm run check:ui`、`python scripts/ui-experience-smoke.py` | 样式检查 23 份、零违规；Chromium 三种视口 × 两种主题共 6/6，零真实模型调用。 |
| `npm run corpus:check`、`npm run eval:formal`、`npm run eval:retrieval` | 公开语料 25 章、712 段；形式语料 12/12；Promptfoo 隔离检索 10/10。初次临时副本缺评测依赖链接和可用的 Git 元数据，补齐副本后复跑通过。 |
| `npm run --prefix evals test:dependencies` | 根项目的评测依赖检查通过 7 项，1 项只用于独立模型实验库、按条件跳过。 |
| `npm ci --engine-strict`、`npm run check:ui`、`npm test` | Windows 在精确 Node 22.12.0、26.13.1 各用独立副本和各自附带的 npm 全新安装。两次串行终验均为 680/680、零跳过。Node 24.14.1 复用锁定依赖的隔离副本全量也为 680/680。Node 20.19.5 在严格安装时返回 EBADENGINE。版本记录 |

开发中并发运行多个完整套件曾触发测试端口竞争，换文件测试的早期夹具也遇到 Windows 重命名语义差异。最终测试使用修正后的夹具，各版本单独运行。所有服务和浏览器验证均在隔离副本中完成。已运行的 Python 服务要采用修复版本，需按新锁重建虚拟环境；本次交付没有部署。

首轮远端 CI 的五个系统/Node 矩阵作业和检索作业通过。UI 动效测试在截断回答上同时遇到输出预算提醒和引用出版状态提醒，原来的单元素定位有歧义。补齐隔离服务器的无 DOI 响应后，测试分别验证两条提醒，并按终态检查仅引用和取消场景。本机隔离 Chromium 重跑 `ui-motion-smoke.py`（10 组）、`ui-experience-smoke.py`（6 个视口/主题组合）及 `ui-effects-smoke.py`（4 个模式）全部通过。源码秘密扫描再次返回零命中。初次 CI 记录（私有研发期 CI 记录）

下一次 CI 的浏览器检查通过。Windows 最低版本的集成测试曾在删除来源返回 200 后仍读到已验证的结论：旧测试通过固定轮数的 GET 轮询后台持久化，GET 本身也会入队复查。修复后的测试通过子进程专用 IPC 等待已有的知识来源事件处理完成，再分别验证原文返回 404、原结论记录保留、状态为 invalidated 且原因为 source_removed。这个等待只存在于测试进程。在隔离夹具里把结论原子写入延迟 1.9 秒时，旧断言失败、新断言通过；另行注入写入失败时，新断言仍然报错。Windows Node 24.14.1 再跑全量 680/680，两项安全扫描维持零命中。Windows 首次出现该断言的运行记录（私有研发期 CI 记录）
