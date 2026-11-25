# 中文形式逻辑与程序验证全文库

本目录将默认内置知识库聚焦到计算机科学的形式逻辑、程序语义与程序验证。它是精选开放教材全文，**不是新的同行评审论文库**，也不以文献数量替代内容质量。

来源是 Benjamin C. Pierce 等作者的 *Software Foundations*，具体采用官方英文《逻辑基础》[序言的 Translations 一节](https://softwarefoundations.cis.upenn.edu/lf-current/Preface.html)所链接的 [Rocq-zh 中文译本](https://rocq-zh.github.io/SF-zh/)。纳入逻辑基础 13 章、程序语言基础 12 章，覆盖命题逻辑、量词、归纳证明、Curry–Howard 对应、关系、霍尔逻辑、操作语义、类型安全、子类型和正规化。

来源固定在 [3f680b5130fe5495de9a3b7a63ae2591f15f055a](https://github.com/Rocq-zh/SF-zh/tree/3f680b5130fe5495de9a3b7a63ae2591f15f055a)，上游提交时间为 2026-06-19；原卷标题页标注 LF 5.7 / PLF 5.8，发布日期为 **2022-03-14**。快照日期不是教材出版日期。中文译本的上游 README 明确标记为 **alpha**，可能存在译文错误，部分章节尚保留英文；每节按实际解释文字保守标记为 `zh-CN`、`en`、`mixed` 或只有代码的 `code`，本次没有生成翻译。不能因为教材采用证明助理，就声称本项目已重新验证全部代码。本次仅导入文本，未执行 Rocq/Coq 编译。

## 许可与署名

两个卷的许可均为 MIT，原始许可完整保存在 `sources/lf-current/LICENSE` 和 `sources/plf-current/LICENSE`；上游项目说明完整保存在 `sources/README.md`，卷标题页和译者署名保存在两个卷的 `index.html`。请连同这些署名、版权和许可声明一起再分发本目录。作者列表、书名、固定源文件链接与源行范围也随每条记录保留。

原文及已有公开证明来自上游作者与翻译贡献者。本项目没有生成或追加习题解答。部分上游教学练习含 `Admitted.` 等待填空的占位符，记录通过 `containsExercises` 和 `proofStatus` 标明；这些段落不应被当成已经独立完成的证明。

## 内容处理与可核对性

- `sources/` 保存 25 个未改写的原始 `.v` 章节文件、上游许可、README 和卷标题页。
- `papers.jsonl` 是兼容现有检索接口的节级全文：`abstract` 这个历史字段存放完整节文字和代码，并非摘要。`recordType` 为 `textbook-section`。
- 以 Coqdoc 标题划分章节，保留多行标题后的解释、逻辑符号、证明代码和打印输出。去掉排版分隔线、TODO 编辑备注和少量强调标记；只有导入/模块声明的空节不进入索引。长节只在完整原始块之间切分，不截断证明块。
- 关键词限定到本节实际出现的概念及人工定义的中英同义词，例如“保型性 / 类型保持 / preservation”；练习不会继承整章所有术语。关键词仅用于检索元数据，不拼进原文正文，不冒充上游原句。`contentRole` 区分解释正文与练习，以便检索优先返回可支撑结论的解释。
- 记录带固定 commit 的 `sourceUrl`、`sourceStartLine`/`sourceEndLine`、原文件 SHA-256、正文 SHA-256、作者、许可、原始语言和译本状态。清洗后的字符偏移与原始 `.v` 行号属于不同坐标：引用高亮使用返回的正文字符偏移，核对版本使用原始源行范围。
- `manifest.json` 记录来源、章节/分片数量、处理方式、已知限制以及整份 JSONL 的 SHA-256。稳定数字 ID 根据源路径、节名、同名节序号及分片号生成，并检查碰撞；ID 空间与旧 CSL 条目隔开。

## 重建与检查

在仓库根目录运行：

```powershell
# 离线：由已跟踪的原始章节重新生成 JSONL 与 manifest
node scripts/ingest-formal.mjs

# 离线：核对原始文件哈希、整份语料与清单可重现，不写文件
node scripts/ingest-formal.mjs --check

# 联网：按固定 commit 再获取原文；没有身份令牌时用 raw HTTPS
node scripts/ingest-formal.mjs --fetch

# 可选：使用已登录的 GitHub CLI 获取同一固定版本，并核对 Git blob SHA
node scripts/ingest-formal.mjs --fetch --via-gh
```

`--output <目录>` 可生成隔离副本。更新上游版本必须显式修改脚本中的固定 revision、重新下载并审阅差异；同一固定 revision 的文件发生哈希变化会报错。正常启动只读取本地语料，不抓取网络内容，不执行上游代码，也不清空 MySQL 或用户上传知识库。
