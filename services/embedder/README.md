# 可选 BGE-M3 语义嵌入

独立 FastAPI 进程提供 `POST /embed`。只加载受运营者配置的模型；没有请求内模型路径或 `trust_remote_code`。实现依据 [BGE 官方文档](https://bge-model.com/tutorial/1_Embedding/1.2.4.html) 与 [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/)。2026-11-07 已部署真实 BGE-M3；部署、权重校验与实际对照的边界见 [部署记录](../../docs/bge-deployment-20261107.md)。

### 固定版本部署

官方 [BAAI/bge-m3 模型卡](https://huggingface.co/BAAI/bge-m3) 标注 MIT。下载固定 snapshot，记录所有文件 SHA256，并核对官方 LFS SHA256：

```powershell
python services/embedder/download_model.py --revision 5617a9f61b028005a4858fdac845db406aefb181 --output D:\models\bge-m3-5617a9f6
```

`download_model.py` 不覆盖不匹配的既有文件；失败保留 `.partial` 和错误记录，重复执行可续传。完整成功写 `deployment-weights.json`。只下载 dense 模型所需文件及官方两种投影权重，不下载 ONNX 副本和展示图片。

Windows x64 / CPython 3.12 的 CPU 服务使用完整锁。进入新的虚拟环境后，在项目根目录执行下列命令。PyTorch 使用官方 CPU wheel，其他固定依赖从 PyPI 安装。

```powershell
$torchWheel = 'https://download-r2.pytorch.org/whl/cpu/torch-2.15.0%2Bcpu-cp312-cp312-win_amd64.whl#sha256=5af9fb357790db09e62484b12032304f046c22c4b1895ca88c4cf5987ea369ca'
python -m pip install --index-url https://pypi.org/simple -r services/embedder/requirements-cpu-windows-py312.lock.txt $torchWheel
python -m pip check
```

2026-11-15 的锁将 setuptools 从 78.1.0 升至 84.1.0，覆盖三份公告的修复版本。新建 Windows Python 3.12.14 环境实际安装 81 个锁定包，通过依赖检查、BGE 类导入和三项嵌入服务 HTTP 契约测试。更新已有服务需用新锁重建其虚拟环境。OSV 扫描结果 · [setuptools 84.1.0](https://pypi.org/project/setuptools/84.1.0/)

```powershell
./services/embedder/start-local.ps1 -PythonPath D:\runtime\bge-venv\Scripts\python.exe -ModelPath D:\models\bge-m3-5617a9f6 -Revision 5617a9f61b028005a4858fdac845db406aefb181 -RuntimeDirectory D:\runtime\bge-service
```

此启动器使用隐藏进程、回环地址、CPU 8 线程、batch 4、max tokens 1024、离线加载；启动前复核下载 manifest 中的文件及 SHA。健康响应提供 `verifiedWeights`、主权重 SHA、manifest SHA 和不含正文的计数。Windows venv 启动器 PID 与监听 PID 分别记录，停止服务应核对监听进程身份。

每次启动产生独立时间戳及随机 ID 的 stdout、stderr 和 JSON 记录，返回 JSON 包含这些路径；`embedder.latest.json` 只保存最新记录指针/摘要，旧日志不覆盖。启动健康失败时按进程创建时间核对并清理本次启动的进程树，保留失败记录；不会依据端口号杀掉其他服务。`test_launcher.py` 使用小型 HTTP 夹具验证重复启动留痕、失败子进程清理、无关进程存活及成功返回，不加载 BGE 权重。

使用 Python 3.11/3.12 的隔离环境安装 `requirements.txt`，然后：

```powershell
$env:EMBEDDER_MODEL_PATH = 'D:\models\bge-m3'
$env:EMBEDDER_DEVICE = 'cpu'
$env:EMBEDDER_REVISION = '已核对的模型快照版本'
python services/embedder/server.py
```

默认仅监听 `127.0.0.1:8092`；可设置 `EMBEDDER_API_KEY`、`EMBEDDER_HOST/PORT`、`EMBEDDER_BATCH`（4）、`EMBEDDER_MAX_TOKENS`（1024）、`EMBEDDER_CPU_THREADS`（8）。单次最多32段、每段12000字符、请求体2MiB。忙时503，不累积GPU任务；HTTP取消不提前释放仍在计算的模型锁。查询、文本与Key不记录访问日志。仅填写 `EMBEDDER_REVISION` 是运营者声明；提供 `EMBEDDER_WEIGHT_MANIFEST` 后才校验本地文件 SHA，未提供时健康响应明确 `verifiedWeights:false`。

Node 配置：

```powershell
$env:EMBEDDING_PROVIDER = 'service'
$env:EMBEDDING_BASE_URL = 'http://127.0.0.1:8092'
$env:EMBEDDING_MODEL = 'BAAI/bge-m3'
$env:EMBEDDING_REVISION = '已核对的模型快照版本'
$env:EMBEDDING_DIM = '1024'
$env:EMBEDDING_API_KEY = '与服务一致的密钥'
```

接口接受 `{model, input: string[], revision?}`，返回 `{model, revision, data:[{index,embedding}]}`。模型、版本、数量、维度或有限数值检查失败时不写入。服务失败退回其他检索通道，并在通道状态提示；绝不把哈希向量写进语义空间。

形式语料显式构建**新**向量文件：

```powershell
node scripts/index-formal-vectors.mjs --output data/formal-vectors-bge-v1.json
```

默认不会覆盖既有文件、Qdrant集合或现有语料。每个搜索窗口约600字符、重叠80字符，包含原有父ref及精确字符区间；引用仍回到原父ref。所有嵌入批次完成后仅持久化一次索引，随后写 `.manifest.json`，记录语料和索引 SHA256、嵌入指纹、窗口配置及起止时间。缺少完成 manifest 的文件不应激活。先验证新索引，再配置 `VECTOR_FILE` 切换。新文件名与模型版本应记录到评测产物。`--plan` 仅输出窗口统计，不写文件或运行嵌入；纯契约试验可加 `--allow-hash-contract`，不能称作语义质量评测。

运行 `python services/embedder/test_server.py` 验证真实 FastAPI HTTP 接口、鉴权、模型身份、大小与过载边界。它注入确定性向量夹具，不加载 BGE 权重。
