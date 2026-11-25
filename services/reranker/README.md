# 可选 BGE 语义重排服务

Node 仍负责词法/向量召回、RRF、用户隔离和引用定位；独立 Python 服务只为已经召回的 `(query, document)` 对评分。默认不开启，不改变现有检索。服务实现采用官方 [`FlagReranker.compute_score`](https://github.com/FlagOpen/FlagEmbedding/tree/master/examples/inference/reranker) 接口，依赖固定为 [FlagEmbedding 1.4.2](https://pypi.org/project/FlagEmbedding/1.4.2/)。Python 3.10+，PyTorch/CUDA 的安装需匹配部署机器。

安装和启动（PowerShell，项目根目录）：

```powershell
python -m venv .venv-reranker
.\.venv-reranker\Scripts\python.exe -m pip install -r services/reranker/requirements.txt
$env:RERANK_DEVICE = 'cpu'
$env:RERANK_MODEL = 'BAAI/bge-reranker-v2-m3'
.\.venv-reranker\Scripts\python.exe services/reranker/server.py
```

首次启动会下载模型，或设置 `RERANK_MODEL_PATH` 指向已准备的本地模型目录。只有手动启动这个服务才加载模型。CPU 默认不使用半精度；GPU 可设置 `RERANK_DEVICE=cuda:0`、`RERANK_FP16=1`。`RERANK_BATCH_SIZE` 默认 8，`RERANK_MAX_TOKENS` 默认 512。模型加载结束后 `/health` 才可访问；生产部署可预热再启动 Node 实验。

在启动 Node 的终端中设置：

```powershell
$env:RERANK_ENABLED = '1'
$env:RERANK_URL = 'http://127.0.0.1:8091/rerank'
$env:RERANK_MODEL = 'BAAI/bge-reranker-v2-m3'
$env:RERANK_CANDIDATE_K = '30'
$env:RERANK_TIMEOUT_MS = '5000'
$env:RERANK_MAX_CHARS = '6000'
npm start
```

`RERANK_API_KEY` 在两个进程中设为同一个值时启用 Bearer 鉴权。服务默认监听 `127.0.0.1:8091`；跨主机部署时用 `RERANK_HOST`/`RERANK_PORT` 配置地址，并为上传文档内容的传输配置 TLS 或受控网络。查询、原文以及 Key 不写入服务日志。服务只接受配置的模型，HTTP 请求不能指定本地模型路径。

接口 `POST /rerank` 接收 `{query, documents: string[], model, top_n}`，返回 `{model, results: [{index, relevance_score}]}`。Node 请求所有候选的分数，要求索引完整、唯一、在范围内且分数有限；超时、500、错误 JSON、缺项或重复索引时返回原 RRF 结果。服务过载立即返回 503，不累积后台推理队列。HTTP 取消不能中止已经进入 PyTorch 的一次计算；该计算结束前其他请求快速降级。

启用时先保留最多 `max(topK, RERANK_CANDIDATE_K)` 个融合候选（上限 100），按新分数排序后再选 topK，单文档仍最多三段。`results` 中增加 `rerankScore`，响应的 `rerank` 字段记录 `applied`、`reason`、耗时和候选数。重排不会改变 ref、原文、字符偏移，也不会把相关性分数当作结论被原文支持的证明。

用同一套问题分别在 `RERANK_ENABLED=0/1` 下运行评测，比较召回、引用支持、拒答率及延迟后再决定是否默认开启。更换 **reranker** 不需要重建向量索引；更换 **embedding** 模型仍需重建，项目已有每个向量点的模型指纹过滤。

本仓库测试只使用离线假服务验证接入契约，没有宣称真实 BGE 模型带来的质量提升；安装依赖和真实模型推理需在目标 CPU/GPU 环境验证。
