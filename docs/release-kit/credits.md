# 项目署名与素材来源

## 可用于发布的署名

> 知衡 Logic KB Agent 由知衡项目维护者协作开发。工作台界面、HanLogic 中文规则与证明视图、证据阅读路径和项目审批流程由本项目实现。文献、协议、推理方法与第三方组件保留各自的来源和署名。

“知衡”标志、界面图标和工作台视觉用于识别项目。本项目第一方源代码、文档与原创发布素材采用 [Apache License 2.0](../../LICENSE) 授权（Copyright 2026 Zhiheng Contributors），完整第三方声明见 [NOTICE](../../NOTICE)。

## 文件归属

| 材料 | 来源及发布口径 |
| --- | --- |
| 知衡代码、界面与推演 | 工作台布局、主题变量、项目交互、引用与证明面板、HanLogic 中文条件表达和运行器见仓库实现。语义参考 Datalog、分层否定、半朴素求值和查询导向等已有方法。文献策略沿用 ReAct、IRCoT、ToT 的论文思路。保留方法名称与论文引用。[HanLogic 的语义参考](../hanlogic.md#语义参考与边界) · [推理策略来源](../../README.md#知衡推演工作台) |
| 知衡标识与界面 SVG | 由项目源码维护，标志在 `assets/brand/mark.svg`，图标在 `src/ui/icons.js`。Windows 图标由项目标识衍生。 |
| 首页图像 | Agent 首页的轨道 3D 图形和知识库研究的书本插画由图像工具为本项目生成。生成方式、日期、文件和规格保留在[视觉资源台账](../../assets/README.md)。 |
| 本图册与海报 | 以 `420b373` 的实际界面为源，使用本地 Playwright 截图与静态排版。演示回答来自测试脚本，教材引文从随包公开原文读取。版式加外框、题注和 Beta 版号。工作区路径与演示模型地址作遮挡。 |
| 内置教材 | Software Foundations 的《逻辑基础》《程序语言基础》精选章节及中文译本。教材作者、译者、固定版本和原文件许可由[语料清单](../../data/formal/README.md)保留。发布时应保留随源文件提供的 MIT 正文和致谢。 |
| 技能、模板和借鉴 | 部分流程参考 Hermes、Codex、Claude 及 Impeccable 的公开方法或项目内部复核。逐份确认技能正文、外部示例、模板及由第三方工具生成的命令文件，保留适用声明。带第三方来源的条目用具体出处标注。 |
| 标准与独立服务 | MCP 与 Agent Skills 属上游规范。Context7、各模型 API、学术源、Langfuse 与 Zotero 使用各自名称指代兼容或连接关系。服务、登录和配额由提供方管理。 |
| 运行时依赖 | Node、Motion、GSAP、Citation.js/citeproc、CSL 样式与字体分别保留上游许可和所需署名。桌面版随包提供运行时许可证、`licenses/npm-inventory.json` 与独立许可文本。[桌面版许可说明](../../scripts/windows/usage.txt) · [前端组件声明](../../assets/vendor/NOTICE.txt) |

图册在隔离环境生成，含公开教材与项目演示内容。引用某张图时请保留可见的版本与演示状态。有关第三方内容的权利，以各上游的许可文本与 [NOTICE](../../NOTICE) 为准。
