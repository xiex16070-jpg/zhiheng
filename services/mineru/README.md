# 可选 MinerU 解析服务

本项目在启用 MinerU 后使用 **MinerU 4.1 Tasks API** 提取 PDF（包括扫描件的 OCR、双栏和表格）。默认继续使用纯 JavaScript 轻量解析。这里直接调用官方服务，不额外维护 Python 网关。

```sh
# 使用独立 Python 3.11–3.14 虚拟环境；会安装模型运行时，首次解析可能下载模型。
python -m pip install 'mineru==4.1.5'
mineru-kit api-server --host 127.0.0.1 --port 8000 --tier auto
```

Node 服务配置：

```dotenv
MINERU_ENABLED=1
MINERU_BASE_URL=http://127.0.0.1:8000
MINERU_API_KEY=
MINERU_TIER=standard
MINERU_OCR_MODE=auto
MINERU_TIMEOUT_MS=120000
MINERU_POLL_MS=1000
MINERU_MAX_RESPONSE_BYTES=67108864
MINERU_FALLBACK=1
```

按部署机器能力配置服务端可用 tier。显式请求 `standard` 而服务不支持时，适配器记录失败并按回退配置处理；不会隐式改变质量等级。`MINERU_FALLBACK=0` 可以让增强解析失败直接暴露为导入失败。MinerU 未返回可识别文字、返回部分文档或结构非法时，也视为失败；扫描件回退到轻量方案后仍可能无文字，不能保证 OCR 成功。

协议流程是 `POST /v1/tasks` JSON 清单、按返回 URL `PUT` 原始文件字节、`GET /v1/tasks/{id}` 轮询、下载 `default` ZIP。读取其中的 `structured_content.json`，按页面/块顺序重建文本，保留一基页码、零基页索引、块 ID、bbox 与 UTF-16 字符偏移。后续分块必须使用同一文本，不能再次 trim 或归一化。表格的 Markdown、标题、图注与脚注会进入正文；不会把图像或模型内部中间结果当作文字。

本实现面向自托管服务：允许配置带反代路径前缀的 HTTP(S) 地址，所有上传、轮询和结果 URL 必须与该地址同源，并拒绝重定向。它不支持向第三方对象存储签名 URL 上传或下载的 SaaS 部署。超时或错误后尽力取消任务；取消请求自身最多等待两秒。ZIP 在内存中限量解压，文件路径不会落地。

只有启用后才会把上传的 PDF 发送给配置的服务；原始 PDF 不写入本应用磁盘。服务端自己的文件/任务保留策略需按部署要求配置。

公开归属说明：启用此功能时，本项目使用 [MinerU](https://github.com/opendatalab/MinerU) 提供文档解析能力。上游 [LICENSE.md](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md) 在 Apache 2.0 之外包含商业许可门槛和在线服务归属标识条件；部署时需检查所安装版本的许可证及模型依赖许可。上游当前文本要求向第三方提供在线服务时，在产品界面或公开文档显著标注使用 MinerU。本页提供了该标识；对外部署时应保证用户能访问。

官方协议与格式依据：

- [Tasks API 4.1](https://opendatalab.github.io/MinerU/usage/tasks/)
- [输出与结构化内容](https://opendatalab.github.io/MinerU/reference/output_files/)
- [4.1 迁移说明](https://opendatalab.github.io/MinerU/reference/migration_4_1/)

本项目测试使用模拟 Tasks 服务和结构化 ZIP，不下载模型、不调用付费服务。真实 OCR 质量需用代表性 PDF 单独评测。

### 两页 PDF 的逐页验收

先选一份有权提交给本机隔离 MinerU 的两页 PDF。运行以下命令，在新目录生成一个绑定原文件 SHA-256 的清单和两份空白 Markdown。

```sh
node evals/pdf-pages.mjs prepare --pdf authorized.pdf --out gold
```

标注者在查看解析结果之前，按视觉阅读顺序独立填写 `gold/page-1.md` 和 `page-2.md`。在清单逐页填写至少两个只出现一次的连续原文短语作为顺序锚点，填写授权范围、审核人或代号及 ISO 时间，然后将 `kind` 改成 `human`。保留清单与 Markdown 的原始版本。使用本机测试服务的地址运行：

```sh
node evals/pdf-pages.mjs run --pdf authorized.pdf --gold gold --endpoint http://127.0.0.1:8000 --out measured
```

`measured/page-1.md`、`page-2.md` 是现有适配器按真实页块映射重建的输出。与 gold 并排阅读，检查表格、双栏和扫描文字。报告按页记录 Unicode NFC 和空白归一化后的字符编辑距离／金标字符数，以及按预期顺序找到的锚点对／全部锚点对。漏识和重复锚点均降低顺序得分。两项指标没有覆盖表格单元格拓扑或公式等价性。单页上限为 12,000 个码点，两页分别计分。可按版面类型分别准备二页样本。

没有材料时可运行 `node evals/pdf-pages.mjs run` 查看跳过原因。服务连接失败、解析协议错误和得到有效分数三种结果分别记录。评测借鉴按页 Markdown 和阅读顺序对照，未使用上游数据或官方综合分。项目代码许可、样本文档版权及 MinerU 的部署许可分别适用。[OmniDocBench 方法](https://github.com/opendatalab/OmniDocBench)
