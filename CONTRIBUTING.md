# 参与知衡

知衡目前处于 **Beta**。请从[社区扩展指南](docs/release-kit/community.md)选择一项能力。指南列出了可以直接使用的接口、优先开放的改造和现有模块。

## 第一次贡献

1. 选一个可独立验证的切口。可以从[证据复查插件](examples/community/evidence-desk-pack/plugin.json)和[本地 MCP 术语表](examples/community/glossary-mcp.mjs)入手。
2. 写明版本、系统、工具链、可复现的输入、预期和实际现象。测试资料用自制、授权或公开可验证样本，提交前清除账号、真实路径和用户对话。
3. 运行改动对应的 Node 测试。修改界面时补浅色、深色、窄屏和键盘操作。修改文件或扩展权限时，补属主、拒绝及取消的回归。
4. 标明代码、文档、图像和样本的来源或许可。说明生成式工具参与的素材及核对方式。提交者对最终内容负责。提交模拟与真实验收的边界，方便维护者复查。

```powershell
npm ci --engine-strict
npm test
npm run check:ui
npm run corpus:check
```

完整评测工具及验收细节见[评测文档](evals/README.md)。界面改动复用现有组件和[工作台设计规范](docs/studio-workbench-2026-11.md#7-产品体验与设计规范2026-11-08)。提交代码、文档或评测样本即表示同意按根目录 [LICENSE](LICENSE)（Apache-2.0）授权，并保留 [NOTICE](NOTICE) 中的第三方署名。涉及私有数据、凭据或权限缺陷的报告，请遵循[安全策略](SECURITY.md)通过私密渠道提交。
