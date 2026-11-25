# Windows 桌面版

从[仓库发布页](https://github.com/xiex16070-jpg/zhiheng/releases/tag/v3.1.0-beta.1)下载 Windows x64 ZIP 和同名 `.sha256`。在 PowerShell 运行 `Get-FileHash -Algorithm SHA256 <ZIP路径>` 核对下载，完整解压到本机，双击 `Zhiheng.exe`。

## 使用与数据

启动器使用 Windows 自带的 .NET Framework 和包内的 Node.js，在环回地址启动服务器，再用默认浏览器打开工作台。关闭网页可继续运行，关闭管理窗口或点击“停止并退出”会正常停止服务。桌面管理程序未做 Authenticode 签名，可用发布页的摘要核对下载。全新配置可直接检索内置形式逻辑教材，生成回答时请先在设置中连接本机或 API 模型。PDF 排版和浏览器操作另需可用的 Edge、Chrome 或兼容的 Chromium。

默认数据目录是 `%LOCALAPPDATA%\Zhiheng\LogicKBAgent\data`，启动错误可查看其中的 `server.log`。升级时先退出，从另一个目录解压新版，继续使用同一 Windows 用户和浏览器配置。桌面版拥有独立的浏览器身份；首次启动显示空会话属于正常行为。开发版自定义路径的迁移说明见项目 README。卸载程序时可以只删除解压目录，数据目录可单独备份。

自动化可用 `Zhiheng.exe --start` 和 `Zhiheng.exe --stop`。两者均可加 `--data-dir "D:\测试 用户\资料"` 指定绝对路径。启动命令返回进程号、实例编号和地址。重复启动复用相同配置的实例，停止时核对所属数据目录与实例。发布包内 `使用说明.txt` 也可离线查看。

## 构建与复验

在 Windows x64 使用 Git、Python 3.11+ 和 .NET Framework 4.x C# 编译器。输出目录使用空目录。构建器从指定 Git 提交导出运行文件和公开教材，核对固定版本的 Node 官方 ZIP，并按提交中的锁文件安装生产依赖。个人工作区、导入文献、会话、笔记、模型权重、服务凭据与开发工具不在应用 ZIP 中。版本、源提交和运行时摘要在包内 `release.json`，第三方许可见 `使用说明.txt` 和 `licenses`。

```powershell
$commit = git rev-parse HEAD
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
python scripts/package-windows.py --ref $commit --output D:/releases/zhiheng
$zip = "D:/releases/zhiheng/Zhiheng-$version-windows-x64.zip"
$sha = ((Get-Content "$zip.sha256" -Raw) -split '\s+')[0]
python scripts/verify-windows-release.py $zip --sha256 $sha --version $version --commit $commit
```

已有官方 Node ZIP 和完整 npm 缓存时，构建命令可加 `--node-zip <文件> --offline`。成品验收使用全新的中文空格路径及用户目录，从 PATH 移除 Node，检查 manifest、环回地址、工作台页面、文献检索、重复启动、停止与重开后的身份和偏好。托管工作流也执行此检查。模型推理、外部搜索和外置 OCR 等需要额外资源，未计入桌面包启动验收。

交互式 Windows 会话还可以运行 `python scripts/windows-smoke-gui.py <已验证的解压目录>`。此开发端检查需安装 Python Playwright 和 Chromium，覆盖启动器窗口显示、最小化后二次启动、浏览器页面输入框及关闭窗口后退出。

## 本版审计修复

- 静态服务按公开文件和前端资源目录提供内容；API 单独处理损坏的身份 cookie、无效 JSON 和过大的请求。新增回归覆盖公开资源与服务端文件的访问边界。
- 默认主存储、知识库和本地向量文件均跟随 `DATA_DIR`。桌面 cookie 按数据目录区分，同一浏览器使用开发版和桌面版可以各自保留身份。
- 开发启动脚本从所在目录定位项目；桌面入口按实例核对就绪与退出。HTTP 回归在临时端口运行，等待服务完成清理后退出。
- 独立 Windows 构建发现通过 8.3 短路径打开首页会返回 403。静态服务现在先解析安装根的真实路径，再验证每份公开资源；成品回归主动使用可用的短路径重测。

本机 Windows x64 回归通过 697 项，UI 样式检查通过 23 张样式表。Promptfoo 检索基线通过 10/10；形式逻辑留出题 Hit@5 为 10/10，无证据负例为 2/2。这些数字衡量检索。Betterleaks 离线扫描 409 份源码及一份合成导出，正例自检生效，范围内无待处理命中；OSV 识别四份 Python 清单中 86 条固定版本记录，使用 2026-11-15 的数据库离线检查结果为零。主应用生产 npm 依赖审计报告零告警。
