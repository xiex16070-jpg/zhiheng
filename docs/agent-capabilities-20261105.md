# Agent 能力补全与搜索配置修复

本轮按现有 Node 服务、工作区、任务审批和原生前端补全能力。新增依赖主要用于服务端文件生成和隔离浏览器；前端沿用现有视觉、按钮、对话框与减少动态效果支持。

## 盘点与实际变化

| 能力 | 修改前 | 本轮完成 | 仍有的边界 |
|---|---|---|---|
| 搜索配置 | 当前服务单选；旧凭据依赖登录密钥 | Tavily/Serper 等独立保存并行检索；OpenAlex Key 与 Europe PMC 开关、测试 | Google Scholar、Scopus 等没有独立适配器；不绕过付费墙 |
| 凭据持久化 | 模型 Key 主要在浏览器；搜索 v1 随 AUTH_SECRET 改变而失效 | 模型、搜索、插件使用独立本机凭据密钥；空输入保留已有 Key；旧搜索自动迁移 | `.credential-key` 丢失无法恢复密文；只迁移当前浏览器正在使用的旧模型 Key |
| 单机服务 | 同一数据目录可被不同端口的两个实例同时使用 | 跨进程独占启动；本机两个旧实例统一为 3000 | Windows/Linux 支持进程被杀后自动释放；其他 Unix 使用文件 socket，异常退出可能需人工清理残留 socket |
| 文档读取 | 已能提取 PDF/DOCX/文本 | 保留原工具；禁止用文本 patch 破坏二进制 | 扫描件仍依赖原有可选 OCR；不能声称保真版面还原 |
| PDF / Word 产出 | `write_file` 只会写 UTF-8，无法生成有效 PDF/DOCX | `create_document` 真实生成 PDF 与可编辑 DOCX，返回工作区文件卡片 | 尚不支持复杂公式排版、原生 Office 图表、模板保真编辑 |
| 浏览器操作 | 无通用交互会话 | 打开、文字/元素快照、ref 点击/填写、PNG 截图、关闭 | 无个人浏览器登录态；不填密码；无任意 JavaScript 工具；不代表已支持原生桌面 |
| MCP | 已有对外 HTTP/stdio 服务 | 新增 MCP **客户端网关**，可连接 HTTP/stdio 服务，发现并逐项启用工具 | 文本结果为主；不处理 MCP 图像/音频输入输出、OAuth、资源订阅和旧版 SSE 专用传输 |
| 插件与权限 | 无统一外部插件设置 | 本机设置内连接、测试、启用、移除；按用户隔离；实际调用逐次审批 | 不自动安装市场插件；本地程序权限依赖其 OS 账号，工作区 cwd 不是系统沙箱 |
| 技能 | 已有技能读取、学习与播种 | 新增文档制作、插件操作两项流程技能，共 26 项随仓库分发技能 | 技能是提示流程；不会凭空安装渲染器或桌面驱动 |
| XLSX / PPTX / 原生桌面 | 无专用原生工具 | 可通过本轮 MCP 网关接入可信外部服务 | 本轮未内置电子表格/幻灯片引擎或 Windows 桌面驱动，界面如实显示待接入 |

## 搜索与密钥怎么用

1. 打开左下角 **设置 → 网站搜索**，点选 Tavily、Serper 或 OpenAlex 服务卡片，填写对应 Key，测试后保存。每个服务独立开关；开启多个网站引擎会并行检索并去重。
2. OpenAlex 免费 Key 从 [账户设置](https://openalex.org/settings/api) 获取；429 可能表示请求频率或账户额度限制。Europe PMC 无需 Key，可以直接测试或单独关闭。503 和超时不等于“没有文献”。详见 [联合研究配置](joint-research.md)。
3. 保存后输入框会清空并标注“已保存”，不需要重新输入；留空测试和留空保存都使用该服务已有密钥。删除只影响当前项。
4. **模型与接口**同样支持留空保留、多个 endpoint 和移除凭据。模型 Key 按完整接口地址绑定，改到其他接口不会借用旧密钥。当前模型配置按本机服务保存，可供新的本机会话恢复；插件和工作区仍按签名用户隔离。

本机凭据文件为 `data/.web-search.json`、`data/.model-connections.json`、`data/.extensions.json`，均被 Git 忽略。必须连同 `data/.credential-key` 备份；不要只迁移密文文件。配置接口不回传 Key，审计不记录请求体。旧模型 Key 迁移成功后才清除浏览器旧记录，迁移失败保留可用原配置。

## 生成真实文件

在主对话中要求“根据已取得的资料生成带参考来源的 PDF / Word 报告”。框架提供：

```json
{"path":"研究报告.pdf","title":"研究报告","source_path":"研究报告.md"}
```

短内容也可用 `markdown`，与 `source_path` 二选一。Word 将输出扩展名改为 `.docx`。支持中文、标题、强调、列表、表格、引文和当前工作区内的 PNG/JPEG；图片写成 `![说明](images/chart.png)`。本轮有效 `[[ref]]` 转成编号和参考来源，未知 ref 拒绝生成。生成器不会核实任意手写参考文献的自然语言支持关系。

PDF 使用关闭 JavaScript、阻断网络的 Chromium 页面排版；Windows 可回退到本机 Edge/Chrome。Linux 初次安装运行 `npm run setup:browser`，CI 使用 `npx playwright install --with-deps chromium`。DOCX 由 docx-js 直接生成，不要求安装 Word。

上限为 60,000 字符、8 张单张不超过 5 MiB 的图片、8 列/200 行表格、两个并行生成任务和 45 秒任务预算。图片限制尺寸和像素数；文件通过现有工作区路径、符号链接和属主检查。默认不覆盖已有产物，失败不会落下伪装的 PDF。只读 `read_document` 可回读生成的 DOCX；PDF 已通过独立提取检查。

## 浏览器和 MCP 接入

**设置 → 能力与插件 → 启用浏览器工具**添加当前用户的隔离浏览器插件。Agent 先 `list_extensions`，再 `extension_tools` 获取目录及 revision，最后 `call_extension`。每次调用进入现有审批，参数、用户、工具和配置版本都必须一致。

浏览器每个任务独立会话，最多两项，五分钟空闲回收；结束、失败和取消任务时关闭。快照返回有限页面文字、元素 ref 和 snapshot；点击、填写使用刚取得的 ref，旧快照不能继续操作。页面请求固定到已校验的公共 IP，禁止私网、凭据 URL、WebSocket、Service Worker、下载和弹出新页；每次操作限制请求数、字节数及超时。截图保存为工作区 PNG。页面与插件返回的内容均视为外部资料。

连接外部 MCP：

- HTTP：填精确的 HTTPS Streamable HTTP 端点和可选 Bearer Token；本机回环允许 HTTP。固定端点、禁重定向；POST 结果受时间与响应大小限制，不维持独立长连接 GET/SSE。
- stdio：填可执行文件的绝对路径、JSON 参数数组和可选环境变量。Windows 仅接受 `.exe`，例如 `node.exe` 配合服务器脚本路径。参数不经 shell；继承 SDK 的受限默认环境，凭据用加密保存的环境变量字段，不放命令行。
- 点击连接会真实读取工具目录，可能启动该程序；之后逐项启用工具再保存权限。Agent 只能发现已经配置并启用的工具，不能自行注册新程序。修改连接凭据时可移除后重新添加。

外部目录最多 120 项、三页；参数 Schema 限 20 KiB、12 层，并拒绝 `$ref`、动态引用、正则和格式匹配等复杂构造。含这类 Schema 的服务需要精简适配。工具调用前重新核对定义，防止审批后工具含义变化。网关不回显上游异常、凭据或含凭据的工具目录。外部 MCP 每次调用创建并关闭连接；需要跨调用进程会话的服务尚需专门适配。

私人知识分区与联合研究模式禁用通用插件调用，避免绕过既有来源策略。原生 Windows 桌面控制需另接可信桌面 MCP；本轮没有启用任意桌面控制或安装未知插件。

## 实现位置与验证

凭据：`credential-codec.mjs`、`web-search-settings.mjs`、`model-connections.mjs`；文件：`documents.mjs`、`workspace.mjs`；网关：`extensions.mjs`、`extension-network.mjs`；浏览器：`browser-agent.mjs`、`browser-runtime.mjs`；独占启动：`runtime-lock.mjs`。均位于 `src/server/`。设置卡片位于 `src/ui/` 与 `src/styles/web-search-settings.css`。

- Node 回归覆盖真实 PDF/DOCX 生成、下载与归属隔离，模型凭据换会话/重启及 30 项接近上限的配置容量、搜索多引擎、v1 迁移与登录密钥轮换、缓存/限流、真实 stdio/HTTP MCP、审批恢复、目录变化与异常脱敏、实际 Chromium 操作、多进程启动争用。最终本机回归为 369 项通过，零跳过。
- `python scripts/ui-agent-capabilities-smoke.py` 验证真实配置接口、多服务独立保存、MCP 发现/权限、新浏览器模型恢复、320/390/1480 宽度、浅深色与减少动态效果；另保留 `ui-web-search-settings-smoke.py`。模型输出与搜索上游使用明确的合成夹具，不是实际回答质量基准。
- 真实 API：OpenAlex 带 Key 返回 1 条，Tavily 已保存 Key 返回 1 条；服务重启后两者的测试及正式页面测试仍成功，密码框为空。Europe PMC 曾成功返回文献和摘要，后续又超时或连接失败，按间歇性故障记录。固定公开测试问题不包含用户资料。项目文件和服务日志扫描未发现已保存的两项搜索 Key。
- 已生成独立中文 PDF 并渲染查看，表格、引用、页脚正常；DOCX 经过 OOXML 和正文/表格结构读取。本轮尚未做 Word/LibreOffice 的逐页视觉回归，也未证明 Qwen 微调模型对新工具的调用成功率。

文档生成与浏览器依赖按需加载，不加入前端动效 bundle。参考实现与接口：[docx-js](https://docx.js.org/)、[Playwright](https://playwright.dev/docs/api/class-page)、[Node IPC](https://nodejs.org/api/net.html#ipc-support)。
