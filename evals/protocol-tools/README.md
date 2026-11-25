# MCP 协议与离线扫描

在项目根目录运行下列命令。Python 脚本只用标准库，实际验证环境为 Windows x64、Python 3.14.5。扫描器准备脚本也提供 Linux x64 的官方发布物及校验值。运行报告写入 `evals/results/protocol-tools/`。2026-11-15 的检查快照保存在 docs/evidence/protocol-checks-20261115。

## MCP

项目锁定 SDK 1.32.2，提供可选的 SDK stdio 与无状态 Streamable HTTP。官方 conformance 0.1.16 的 server 命令通过 URL 访问服务，本次抽取初始化、ping、工具列表三项。现有 SDK 客户端测试继续覆盖 stdio、身份绑定、并发租户隔离和业务工具，现有审批测试独立运行。[官方代码与 MIT 许可证](https://github.com/modelcontextprotocol/conformance/tree/21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0)

```powershell
npm ci --prefix evals/protocol-tools --ignore-scripts --no-audit --no-fund
python evals/protocol-tools/mcp_conformance.py
```

需先按项目锁安装根目录依赖。已验证 Node **24.22.1**。多版本环境可用 `--node <node可执行文件的路径>`。Windows 24.14.1 的官方 CLI 在写出成功检查后发生过 libuv 断言失败。运行器同时检查 CLI 退出码、官方检查 ID、状态和非空工具列表，任何一项失败均返回非零。

运行器复制应用代码到临时目录，通过目录链接复用项目依赖。新进程使用最小环境、空语料、新建数据目录、关闭外部后端，在回环地址上使用系统分配的端口。临时目录内没有项目的 `.env`。仅访问该实例的健康检查与现有 `/mcp` 路由。保留了现有本地回环鉴权行为。工具清单请求只读取声明。原始临时结果清理前，报告保存官方检查描述、规范引用和状态。三项均通过，协商版本为 `2025-11-25`，返回 9 个工具。在此子集之外的参考服务器专用工具调用、资源、提示、SSE、OAuth 和 stdio 不计入官方通过数。

## 扫描器准备

先将校验过的发布物和公开的 PyPI 公告库下载到独立目录。扫描步骤可在断网环境中运行。首次安装、更新或回放指定公告库时才需要准备步骤。

```powershell
$cache = Join-Path ([IO.Path]::GetTempPath()) 'logic-kb-scanner-cache'
python evals/protocol-tools/scanner_tools.py --cache $cache
```

OSV-Scanner 2.7.1 使用 Apache-2.0 许可证，Betterleaks 1.10.1 使用 MIT 许可证。下载地址、版本和 SHA-256 固定在 `scanner_tools.py`。Betterleaks 压缩包与解包后的二进制均校验，运行时再次检查二进制摘要。公告库按下载时的 generation、修改时间与内容摘要记录。本次回放可在准备命令末尾添加 `--db-generation 1794710886976880`，历史版本能否重新下载取决于上游保留策略。[OSV 发布记录](https://github.com/google/osv-scanner/releases/tag/v2.7.1) · [Betterleaks 发布记录](https://github.com/betterleaks/betterleaks/releases/tag/v1.10.1) · [OSV 离线数据库说明](https://google.github.io/osv-scanner/usage/offline-mode/)

## Python 依赖

```powershell
python evals/protocol-tools/dependency_scan.py --cache $cache
```

只把四个输入以原名原内容暂存到扫描目录，传入 `--offline --no-resolve --all-packages`。按文件逐一比对规范化包名和精确版本，也验证 `+cpu` 本地版本。新增语法、丢包、重复识别或数据库失败均令覆盖检查失败。此命令保留本地安装与锁文件，报告反映锁定版本命中的已知公告。[OSV 支持的格式](https://google.github.io/osv-scanner/supported-languages-and-lockfiles/)

| 输入 | 本次识别 |
| --- | ---: |
| `services/embedder/requirements-cpu-windows-py312.lock.txt` | 81 / 81 |
| `services/embedder/requirements.txt` | 3 / 3 |
| `services/reranker/requirements.txt` | 1 / 1 |
| `scripts/requirements-ui.txt` | 1 / 1 |

初次验收时，Windows CPU 锁中的 `setuptools==78.1.0` 命中 3 组公告（5 个 OSV 条目）。包和分组在快照中可复核。其余三个输入仅覆盖各自显式固定的版本。未选的包管理器文件、本地虚拟环境、动态安装项及运行时可达性均在本次检查范围之外。npm 锁沿用项目已有流程。更新到 setuptools 84.1.0 后使用同一公告库复扫，四份输入均为零告警。修复后 OSV 快照

## Betterleaks

```powershell
python evals/protocol-tools/secret_scan.py --cache $cache --approved-export evals/protocol-tools/approved-exports/public-example.jsonl
```

默认扫描 Git 跟踪的应用入口和 `src`、`services`、`scripts`、`tests`、`evals`、`examples`、`db`、`.github/workflows` 中列入白名单的源码类型。导出文件每个单独指定，默认数量为零。上例使用仓库的公开合成导出样例。如有明确许可，也可逐个指定 `--approved-export data/exports/<单一文件名>`（支持 JSON、JSONL、CSV、TXT）。暂存导出文件使用序号，报告保留序号。目录、通配符、越界路径、链接文件和不支持的扩展名会导致运行失败。

本轮未提交的新代码可通过 `--approved-source` 传入明确列表。以下命令先列出候选路径。将此次允许的源码路径作为参数传入，扫描器仅接受 Git 可见的 `src`、`scripts`、`tests` 或 `evals` 源代码文件。

```powershell
$newSource = @(git ls-files --others --exclude-standard -- src tests scripts evals |
  Where-Object { $_ -match '\.(mjs|js|py|css|html|gbnf|han|ps1|sh|bat|sql|ya?ml)$' })
$newSource
# 确认上面的文件名均属于本轮改动之后运行，有需要可先缩小 $newSource。
python evals/protocol-tools/secret_scan.py --cache $cache --approved-export evals/protocol-tools/approved-exports/public-example.jsonl --approved-source @newSource
```

显式列表为空时省略 `--approved-source`。所有选中输入都在单独目录中扫描，默认规则启用，`--validation=false` 禁用联网验证。扫描器使用仅含操作系统运行必需变量的环境。正控制由固定公开标签计算成未签发的测试字符串，要求内置 `github-pat` 规则命中。负控制要求零命中。结果模板仅保留规则 ID、文件和行号，错误分支也丢弃原始输出。初次验收报告有 1 条 `generic-password` 候选，位于 `tests/ui-diff.test.mjs` 的公开步骤递归脱敏单元测试内。该行使用了测试作者写入的占位值。修复后的测试逐项校验脱敏结果，扫描正负控制和完整扫描均已重跑。修复后 Betterleaks 快照

所列数量是送入扫描的源码文件数。Git 历史、依赖目录、归档、文档、真实语料、个人笔记、日志、运行时配置、轨迹和其余导出文件均跳过。两个扫描命令的退出码均为 0（检查完成且未发现条目）、1（发现条目）或 2（输入、工具或覆盖不完整）。新增条目或修复后的复核均可重跑对应命令。
