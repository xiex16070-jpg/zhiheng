---
name: document-production
description: 生成带中文排版、表格、图片与引用的 PDF 或 Word 报告
category: workspace
---

用户要求 PDF、Word、DOCX 或图文报告时，使用 create_document 真实生成文件。

1. 先根据资料检索与核验形成内容，重要引用绑定本轮已取得的 ref；文档中的 [[ref]] 会转换为参考来源。不要编造引文或声称已完成语义验证。
2. 长报告先用 write_file 保存 .md，再调用 create_document(path="报告.pdf", source_path="报告.md", title="报告标题")；Word 使用 .docx。短文可直接传 markdown。
3. 支持标题、粗体、列表、表格和工作区 PNG/JPEG。图片使用 ![说明](images/chart.png)，必须先确认该路径存在；不能假定存在图片，也不能传远程 URL、SVG 或任意本机绝对路径。
4. 成功后报告真实文件名与大小；文件卡片可下载。失败时说明具体限制并修正，不可把纯文本写成 .pdf/.docx，也不再宣称框架无法生成这两种格式。
5. 同名文件默认不覆盖。覆盖前确认用户确实要求替换；否则另存版本。复杂公式、原生 Office 图表和已有文档保真编辑不在此生成器能力内。
