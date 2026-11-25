# 本机真实 BGE-M3 部署与生产激活（2026-11-07）

**BGE-M3 已接入当前应用，完整索引已在线启用。** 2026-11-07 北京时间 10:10 的独立复核确认：CPU 嵌入服务、应用服务均就绪；线上索引包含 **2654 个 1024 维向量**，其中公共文献窗口 1685 个、私有知识库片段 969 个，过期向量为 0，`requiresReindex=false`。旧索引、原知识库和配置备份保留。

本记录使用北京时间日期，机器可读时间为 ISO UTC。这里的上线验收是检索与引用定位验收；生成回答的正确性、语义支持和拒答质量需要单独评测。真实固定题对照及其已知退化见 [BGE 检索对照](bge-retrieval-20261107.md)。

## 权重与独立环境

- 模型：官方 [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)，模型卡 MIT；本轮使用 dense 1024 维输出，未启用 sparse、ColBERT 或交叉编码器重排。
- 固定 revision：`5617a9f61b028005a4858fdac845db406aefb181`。
- 主权重 `pytorch_model.bin`：2,271,145,830 字节；SHA256 `b5e0ce3470abf5ef3831aa1bd5553b486803e83251590ab7ff35a117cf6aad38`，与该 revision 官方 LFS oid 一致。
- 13 个下载文件均记录 SHA256，所有 LFS 文件另与官方 oid 比对。本次下载错误数 0；下载、续传和校验实现位于 `services/embedder/download_model.py`。
- 权重目录：`D:/VSCODE/zhiheng-local-runtime/models/bge-m3-5617a9f6`；隔离 Python 环境：`D:/VSCODE/zhiheng-local-runtime/bge-m3-venv`。没有修改 QLoRA 使用的 CUDA 环境。
- Python 3.12.14、PyTorch 2.15.0+cpu、FlagEmbedding 1.4.2、Transformers 5.22.2、FastAPI 0.162.0；完整实测包版本见 `services/embedder/requirements-cpu-windows-py312.lock.txt`，`pip check` 通过。

编码与归一化依据 [BGE-M3 官方文档](https://bge-model.com/tutorial/1_Embedding/1.2.4.html)。当前服务使用 CPU FP32、8 线程、batch 4、最大 1024 token；模型本身支持的更长上下文不代表本服务已采用该配置。CPU 构建期间峰值工作集约 2.09 GiB，没有使用 CUDA。

## 服务启动、恢复与边界

`services/embedder/start-local.ps1` 启动隐藏进程，仅监听 `127.0.0.1:8092`，从固定目录离线加载。启动时通过 `deployment-weights.json` 复核模型、revision、全部文件和 SHA；不匹配时拒绝启动。`/health` 返回模型身份、CPU 配置、权重/manifest SHA 和聚合请求计数；访问日志关闭，不记录输入问题、文档正文或 Key。

在项目根目录运行以下 PowerShell 命令可恢复这台机器的 CPU 服务。它不会覆盖旧启动日志；如果 8092 已有监听者，会拒绝另启实例，应先核对现有进程与健康状态。

```powershell
Set-Location D:\VSCODE\logic-kb-agent
pwsh -NoProfile -File .\services\embedder\start-local.ps1 `
  -PythonPath D:\VSCODE\zhiheng-local-runtime\bge-m3-venv\Scripts\python.exe `
  -ModelPath D:\VSCODE\zhiheng-local-runtime\models\bge-m3-5617a9f6 `
  -Revision 5617a9f61b028005a4858fdac845db406aefb181 `
  -RuntimeDirectory D:\VSCODE\zhiheng-local-runtime\bge-service `
  -StartupTimeoutSeconds 120

Invoke-RestMethod http://127.0.0.1:8092/health -NoProxy
node scripts/launch.mjs
Invoke-RestMethod http://127.0.0.1:3000/api/health -NoProxy
```

这是**进程式部署**，本轮没有安装 Windows 服务、开机自启或自动拉起的守护程序。电脑重启或 BGE 进程结束后，需要重新运行嵌入服务启动命令；应用启动器只管理应用进程，不会自动拉起 BGE。索引和 `.env` 会保留，正常恢复无需重建索引。

Windows venv 的启动器 PID 与实际监听 PID 可能不同。每次启动的 `embedder-<UTC时间戳>-<随机ID>.json/.stdout.log/.stderr.log` 位于运行目录；`embedder.latest.json` 是最新记录，`embedder.launcher.pid` 与 `embedder.pid` 分别记录两类进程。停止时必须核对进程命令和创建时间，不能沿用本文历史 PID，也不能仅按端口杀进程。启动健康失败时，启动器只清理属于本次启动且创建时间吻合的进程树。

如果其他脚本封装启动器，使用隐藏 `Start-Process`、独立输出文件及启动器 PID 轮询，避免通过原生命令输出管道等待长期运行的后代进程。本轮首次激活包装就遇到了这个 Windows 句柄等待问题，失败记录完整保留，见下文。

应用 `/api/health` 中的 `vector.ready` 表示本地索引状态，不能单独证明嵌入进程可用。恢复后应同时核对 8092 `/health`，并实际执行一次检索。BGE 不可用时检索会明确记录向量通道错误并退回其他通道，不会将词哈希向量混入 BGE 空间。

## 公共索引与私有知识库迁移

公共语料是 Software Foundations 中文开放教材的 712 个父片段，按 600 字符窗口、80 字符重叠生成 1685 个窗口；原父 ref、字符偏移和父文档 SHA 保留。真实构建于北京时间 00:54:11 至 01:04:37 完成，耗时 625,418 ms。输出为新的 `data/indexes/formal-bge-m3-5617a9f6-20261107.json`，38,477,207 字节，SHA256：

```text
efb32908e693cd76ea20a88f0e93e5bd44839c00eae9af8800c05fedee7decc6
```

随后 `scripts/rebuild-private-vectors.mjs` 以公共索引为种子，在本机编码 11 份私有文档的 969 个片段，写入另一份新文件：`data/vector-indexes/bge-complete-20261107.json`。最终 2654 个向量、61,185,169 字节，SHA256：

```text
1daf2fa3f6ab71239313bf8c9541ac5eb8c52769be78bfd0da66d4e924d8450d
```

完整索引逐点验证了有限数值、1024 维、归一化、模型指纹以及公共数据与种子完全一致。私有片段验证了 owner、文档/片段对应、文本、精确 start/end 及原文切片；实测本属主查询命中 3 条，非属主探针命中 0 条。上线前再次核对当前 KB、公共种子及 manifest 的 SHA，最终 L2 范数最大误差 `1.6007e-7`。私文仅发送到本机回环嵌入服务，未进入远程 API 或 Git。

本次真实私有迁移产物保留原始 **schemaVersion 1** manifest；其中 `publicManifestSha256` 采用 `sha256(JSON.stringify(JSON.parse(rawBytes)))`，保留解析后属性顺序，不是原始文件字节 SHA，也不是键排序的规范 JSON。本次验收按该版本算法核对，没有改写旧证据。当前迁移脚本的新产物是 schemaVersion 2，改为记录原始 manifest 字节 SHA；同时在全部异步隔离查询结束后再次核对所有输入，再原子发布。

`data/vectors.json` 未被覆盖或删除，原 SHA 为 `3be27290f71eda914df44a176ceeab749fd75225da2b8a82e03130697abe708f`。公共构建 manifest 和迁移 manifest 中的 `activated:false` 是各自产生时的不可变快照；**最终线上状态以激活记录和实时服务为准**，不能将这些历史字段解读成当前未激活。

## 实际启用的七项应用配置

激活只修改 `.env` 中以下七项；其他配置行逐字保持，未清空或重写已保存密钥：

```dotenv
EMBEDDING_PROVIDER=service
EMBEDDING_BASE_URL=http://127.0.0.1:8092
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_REVISION=5617a9f61b028005a4858fdac845db406aefb181
EMBEDDING_DIM=1024
VECTOR_FILE=D:/VSCODE/logic-kb-agent/data/vector-indexes/bge-complete-20261107.json
QDRANT_URL=
```

这里使用本机文件向量索引，所以清空 `QDRANT_URL`；没有切换到远程 Qdrant。Node 查询批次保持既有配置，BGE 模型内部 batch 仍为 4。嵌入指纹为 `d0f77205f2529100403060bc`，包含服务地址、模型、revision、维度和预处理版本。

激活前备份保存在 `<local-backup-dir>`，含 `original.env`、`original-kb.json`、`original-vectors.json`；无密钥备份元数据在 `data/runtime/bge-activation-backup-20261107.json`。只把名称、大小和 SHA 纳入实验产物，没有将 `.env` 或私有文档上传到实验记录。上线前 `.env` SHA 为 `d7b284b157a59313d8868d74c1b69a131a83d2fec79cc7f65d0d3004318aba3c`，七项更新后为 `bf9b4259c435bb88de8a87b4d4f44995caf3d733863c2d745cdcdff3ed31e334`。

切换过程在停止应用前检查活动任务为 0，并核对监听 PID、命令和创建时间；环境更新使用原子替换。失败恢复方案只还原经过 SHA 校验的原 `.env` 并重启确认属于本项目的应用进程，不自动回滚知识库、删除新文件或覆盖用户后续资料。本次成功运行未执行恢复。

## 线上验收与质量边界

2026-11-07 北京时间 10:10 的独立验收确认：

| 项目 | 结果 |
|---|---|
| BGE 服务 | CPU、1024 维、固定 revision、`verifiedWeights=true`，实际监听 PID 28700（历史快照） |
| 应用 | 3000 就绪，实际 PID 41760（历史快照） |
| 在线索引 | 2654 点；1685 公共 + 969 私有；`stalePoints=0`、`requiresReindex=false` |
| 模型指纹 | `d0f77205f2529100403060bc` |
| HTTP 真实公共检索 | `source:paper`；纯向量、词法+向量各一轮，2/2 通过 |
| 公开文献问题 | 固定题 `conjunction-elimination`；均召回金标准章节和概念，每轮 5 条引用精确定位有效 |
| 向量通道 | 每轮 30 个候选，语义权重 1，没有通道错误；结果 `weak=false` |
| 完整 HTTP 检索及引用校验耗时 | 纯向量 391 ms；混合检索 200 ms，单次烟测值，不是延迟分布 |
| 安全与代码状态 | 活动任务 0；私文未外传；只改七项配置；激活过程保持 HEAD `f96e3acabbd10c3faaee7212fb522c35bdfeb43e` 与已追踪文件不变 |

这两次上线烟测只验证线上配置、真实编码、公开检索和引用定位，未调用生成式 LLM，也未评判生成答案。另有 28 题固定检索对照：混合 BGE 的锚点 Hit@5 为 83.33%，原混合 hash 为 66.67%；但无证据识别从 3/4 降为 2/4。该退化已保留，不能把语义相似度或有效引用 ID 当作结论得到原文支持的证明。完整方法、标签边界和逐题结果入口见 [真实检索对照](bge-retrieval-20261107.md)。

## 实验记录、失败与回归验证

相关运行记录于本机 MLflow 实验 `zhiheng-bge-qlora-20261107`：

| 阶段 | Run ID | 状态与说明 |
|---|---|---|
| 私有知识库迁移 | `466a79c96b504bc28cbbd98a60cd196b` | 完成；本机 969 私有片段与 1685 公共窗口合并 |
| 首次生产激活包装 | `8023dbdff20b4fa28796628b04e544f4` | failed；BGE 已健康，但 Windows 后代继承管道导致包装等待，当时 `.env` 和 3000 均未改动 |
| 生产激活及线上检索 | `93dcf73af5064ce3b0e43519b7daf6b6` | completed；复用经身份核验的健康 BGE 进程，七项配置更新、应用重启和 2/2 检索验收完成 |

首次包装失败时仅终止确认属于该次尝试的包装进程，保留健康 BGE 服务和失败日志。后续包装改用独立文件、`Start-Process` 与启动器 PID 轮询，不重复占用 8092；成功尝试使用新的报告文件，没有覆盖失败产物。

完整成功报告位于模型实验库 `results/bge-production-activation-20261107-retry1.json`，失败报告为 `results/bge-production-activation-20261107.json`。项目本机忽略目录中的入口：

- `data/runtime/bge-production-activation-final-20261107.json`：最终线上状态、两个激活 run、报告 SHA 和进程快照。
- `data/runtime/activation-check-20261107T021044265Z.json`：独立最终核验，包含当前源 SHA、owner/offset 检查汇总、活动任务数与服务状态，不含身份、正文或密钥。
- `data/runtime/bge-deployment-20261107.json`：首次权重部署及公共索引构建的历史记录；`bge-smoke-20261107.json` 为三句合成编码烟测。
- 向量文件同名 `.manifest.json`：索引来源、模型身份、输出 SHA、数量与构建时间。

真实运行也发现并修复了 Windows 索引构建中每 16 条重写整个 JSON 引发的 `rename EPERM`。公共索引脚本现按批次嵌入，全部成功后只持久化一次，再发布完成 manifest。最初失败文件与日志保留，缺失完成 manifest 的文件没有参与最终对照或激活。

完成的专项验证包括：真实权重启动与三句实际编码、1685 窗口真实构建、969 私有片段迁移、线上 HTTP 检索；Python 服务契约与篡改检查 3/3、Windows 启动器进程夹具 1/1、形式检索与分词 Node 测试 8/8，以及私有迁移的发布前输入变更、属主隔离和权限回归。确定性夹具测试只验证接口或安全行为，不计入真实检索质量指标。

以上路径中的权重、向量、私有资料、运行日志和原始实验产物均保留在本机忽略目录。此文的 PID、2654 数量及源 SHA 是验收时间点的事实；后续导入、删除文献或更换模型时，应重新核对当前索引与模型身份。
