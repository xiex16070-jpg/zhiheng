# Promptfoo 评测依赖修复记录 · 2026-11-07

## 结果

保留 Promptfoo **0.125.1**，仅对评测依赖做固定版本 overrides。主项目生产依赖未变；实验库 `zhiheng-model-lab` 的相同依赖链同步修复。没有运行 `npm audit fix --force`、降级 Promptfoo、调用模型或使用用户运行中的服务。

| 安装范围 | 修复前 npm audit | 修复后 npm audit |
|---|---|---|
| logic-kb-agent 根目录 | 0 | 0 |
| logic-kb-agent/evals | 8：5 high、3 moderate | 0 |
| zhiheng-model-lab 根目录 | 8：5 high、3 moderate | 0 |

时间：2026-11-07 03:16–03:18 UTC；Windows，Node v24.14.1，npm 11.11.0。结果是当时 npm 公告数据库的依赖审计结果，不代表所有潜在漏洞或应用行为均已验证。

## 依赖与来源

8 个受影响包条目对应 3 个根公告。5 个 high 属于同一传播链：

```text
promptfoo 0.125.1
  → proxy-agent 8.0.2
  → pac-proxy-agent 9.1.0
  → get-uri 8.0.1
  → basic-ftp 5.3.1
```

另三个 moderate 条目是 glob、minimatch，以及继承两者告警的可选 `@modelcontextprotocol/server-filesystem`。这不是生产应用使用的 `@modelcontextprotocol/sdk`。

| 依赖 | 旧版本 | 固定版本 | 修复依据 |
|---|---|---|---|
| basic-ftp | 5.3.1 | 6.2.6 | [目录列表解析 CPU 拒绝服务](https://github.com/patrickjuchli/basic-ftp/security/advisories/GHSA-c475-qrg2-pj4r) 的首个修复是 6.2.1；[6.2.6](https://github.com/patrickjuchli/basic-ftp/releases/tag/v6.2.6) 还修复了 downloadToDir 路径穿越。 |
| glob | 13.0.6 | 14.0.2 | [取消后仍继续目录遍历](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)。 |
| minimatch | 10.2.6 | 11.0.1 | [优化阶段模式数量放大](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249)。 |

三个 override 均跨越上游当前的主版本约束，因此增加独立兼容回归。basic-ftp [6.0 默认禁止独立数据传输主机](https://github.com/patrickjuchli/basic-ftp/releases/tag/v6.0.0) 的安全收紧保留，不设置 `allowSeparateTransferHost: true`。少见的控制连接与数据连接分离的 FTP 服务可能需要运营方重新评估；本项目不依赖这种行为。

锁文件实际版本变化只有这三项，以及 glob 必需的 `path-scurry 2.0.2 → 3.0.0`；新增 `@isaacs/nonrecursive-glob-match 1.1.0`。npm 同时删除原锁文件中 **19 项全部已标记为 extraneous** 的条目；没有升级其他已存在的包版本。

修复时 npm 推荐的 `fixAvailable: promptfoo@0.5.1` 是不适用的大幅降级；当前 latest 仍为 0.125.1。固定 overrides 应在上游正式采用修复依赖后复查，届时通过同一兼容测试再移除，避免永久偏离上游依赖声明。

## 可达路径与边界

- `evals/run.mjs` 动态导入 Promptfoo，传入内存中的 cases 和自定义 `AgentProvider`；该 provider 使用原生 fetch 访问独立 loopback Agent。常规生产模块不导入 Promptfoo。
- 生产静态服务拒绝 `/evals/`、`/node_modules/`；CI 将 evals 作为独立安装范围。之前 `npm ci` 显示告警但不会因此失败，不能以 CI 绿灯推断 audit 为零。
- FTP 风险链可以经 `proxy-agent` 的 `pac+ftp` → `get-uri` → FTP MDTM 不可用后的 `Client.list()` 触发。常规项目评测没有开放这一输入，但本次兼容测试实际走通本机 FTP fallback 和 PAC 下载链。
- glob/minimatch 风险需要相应文件遍历或不可信模式输入；固定 fixture 评测没有展示线上攻击入口。安装库有告警与应用已被利用是不同结论。

## 验证

独立测试：`evals/dependency-compat.mjs`，显式运行以免主项目 Node 20 测试自动发现依赖 Node 22.22 的评测包；CI retrieval job 单独安装并执行。所有网络 fixture 只监听 `127.0.0.1` 随机端口；PAC 显式指定本机 URL，不读取代理环境配置；Promptfoo 禁用遥测、更新检查和远程生成；使用独立临时目录，完成后清理。没有访问 GPU、真实模型端点、生产数据或 API Key。

| 检查 | 主项目 evals | 实验库 |
|---|---|---|
| Promptfoo 固定版本与 override 版本 | 通过 | 通过 |
| glob ESM/CJS、Unicode、Windows 路径转义、忽略与花括号模式 | 通过 | 通过 |
| 遍历在首次读取后取消，不继续读取子目录 | 通过 | 通过 |
| minimatch 正常匹配、optimizationLevel=2 的扩展预算 | 通过 | 通过 |
| Promptfoo evaluate + 真实 AgentProvider，连接临时 HTTP fixture | 通过 | 通过 |
| 实验库真实 LocalModelProvider，连接临时 OpenAI 格式 fixture | 不适用，显式跳过 | 通过 |
| basic-ftp 普通 Unix 目录列表解析 | 通过 | 通过 |
| get-uri MDTM 失败后的目录列表回退、下载，以及 proxy-agent pac+ftp | 通过 | 通过 |

主项目 **7 通过、1 不适用跳过**；实验库 **8/8 通过**。另外将主项目 evals 的清单和锁文件复制到全新系统临时目录，执行 `npm ci --ignore-scripts --no-fund`：安装成功、audit 0，并再次取得 **7 通过、1 不适用跳过**。这验证了清洁安装不依赖之前残留的 node_modules；没有验证所有可选原生依赖的安装脚本或所有第三方 Provider。

复跑命令（PowerShell，从主项目根目录运行）：

```powershell
npm run --prefix evals test:dependencies
$env:EVAL_DEPENDENCY_ROOT = 'D:\VSCODE\zhiheng-model-lab'
node --test evals/dependency-compat.mjs
Remove-Item Env:EVAL_DEPENDENCY_ROOT
npm audit --json
npm audit --prefix evals --json
npm audit --prefix D:\VSCODE\zhiheng-model-lab --json
```

这组测试检验依赖兼容与已覆盖的修复行为，不计算模型质量、检索质量或自然语言语义支持分数；真实文献和模型评测仍使用各自原来的固定题集与记录。

锁文件 SHA-256：

- `logic-kb-agent/evals/package-lock.json`：`7e5548854ca9f624318cdf43b48d12e3bf0696f2fc0ef7f35a447bc9372e26c3`
- `zhiheng-model-lab/package-lock.json`：`5046b837f6c565451b01c2c3d68a4eb6992f6853c956b9679aa22daa32419265`

## CI 的 npm 10 锁完整性补修

上述哈希属于首次修复与真实模型评测使用的历史锁，保留不改。随后 CI job 128305051778（私有研发期 CI 记录） 在 Node 22.22.0 / npm 10.9.4 的 `npm ci --prefix evals` 报 EUSAGE：缺少五个可选 peer 依赖节点。本机先前的 Node 24.14.1 / npm 11.11.0 清洁安装成功，不能证明 npm 10 的锁验证也通过。

已在本机空目录用 npm 10.9.4 复现同样错误。链路是可选 `mongoose@9.11.4 → mongodb@7.7.0` 要求可选 peer `gcp-metadata@^7.0.1`，顶层已有的 9.x 不满足。只在两份锁中补入 `mongoose/node_modules` 下的 `gcp-metadata@7.0.1`、`gaxios@7.3.1`、`google-logging-utils@1.2.0`、`https-proxy-agent@7.0.6`、`debug@4.4.3`；保留已有全部节点、版本、overrides、平台元数据及 Promptfoo 0.125.1。

补修后两份新目录的 npm 10.9.4 完整 `npm ci --no-audit --no-fund` 均退出 0（安装脚本开启，各 602 包）；真实依赖兼容测试分别为 7 通过/1 不适用跳过与 8/8，两份 npm 10 audit 均为 0。本机验证仍在 Windows / Node 24.14.1，Linux / Node 22.22.0 以修复后 CI 为准。原失败日志、新安装日志、兼容与审计结果留在实验库 `.runs/npm10-lock-compat-20261107`，未覆盖先前证据。

补修后的文件 SHA-256：主 evals 锁 `a39708e59890ea4059f5f55d7e817e89ba950ec72d32851ca608a9d965216125`；实验库锁 `61bec4a2e45f539b00a3f9f34c869102cd9d4ddd4e9ca5eebf7d2eb0041c6d4a`。本次仅修安装兼容，没有重跑模型、改题或改变历史模型评测的输入 SHA。

本地 MLflow 补修验收 run：`a3ea2bbd1aaf4101b083f0fc37f779cd`，stage `inspect`。14 份输入及结果已通过 API 下载逐项核对 SHA，报告为实验库 `results/context-npm10-lock-compat-20261107.json`；该记录导入已执行的安装、兼容与审计日志，模型调用为 0。
