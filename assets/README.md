# 知衡 Agent 工作台视觉资源

2026-11-06 工作台视觉以“研究、创作与执行围绕同一清晰核心”为主题：冷瓷白承载阅读，深墨蓝组织结构，青绿用于交互；轨道式品牌标识与透明 3D 图形用于首页和短开屏。按钮、任务状态与操作图标仍使用可缩放的原生 SVG，静态位图不承载可点击文字和权限信息。

此前“书页与证据”版本的插画及设计板保留用于历史对照，不代表当前首页仍是文献专用界面。当前主题覆盖位于 `src/styles/studio.css`，文件预览样式位于 `src/styles/artifact-preview.css`。

## 文件与来源

| 文件 | 来源与规格 | 使用位置 |
| --- | --- | --- |
| `../src/ui/icons.js` | 当前 54 个项目原创 SVG 图标（实际名称以 `ICON_NAMES` 为准）；24 × 24 网格，基础线宽 1.6，圆头、圆角，`currentColor` | 项目、工具栏、消息操作、权限、来源类型、任务步骤与阅读面板 |
| `brand/mark.svg` | 本轮原创 32 × 32 SVG 品牌标识，三条轨道围绕菱形核心 | 浏览器图标；同形状的 `brandMark()` 用于产品标识和 Agent 头像 |
| `brand/studio-sculpture.png` | 2026-11-06 使用 OpenAI `image_gen` 为项目生成的原创 3D 视觉；实际 1254 × 1254，RGBA 透明 PNG，1,011,733 B | 新工作台首页与可跳过的开屏序列 |
| `illustrations/conjunction-plate.svg` | 原创 SVG，328 × 176，展开书页上绘有 P ∧ Q 的两个投影 | 历史文献版图形，保留文件 |
| `illustrations/research-library.png` | 2026-11-03 为本项目 AI 生成的原创插画；1536 × 1024，RGBA，透明背景；无外部素材 | 设计板的书本、文献卡片、银杏叶与证据连线 |
| `brand/design-board.html` | 独立设计板，直接加载产品共用的图标模块与上述资源 | 图标检索、品牌尺寸检查、配色与浅深主题预览 |

SVG 均为仓库原生源码，没有新增图标库、字体图标、动画播放器或外部资源请求。PNG 是静态插画，不承载按钮、状态或引用信息，不在每条消息中重复加载。

### 3D 图形生成记录

- 文件：`brand/studio-sculpture.png`。
- 方式：OpenAI 内置 `image_gen` 工具生成；未调用 CLI/API fallback。最终文件已复制到项目资产目录，产品不依赖生成工具缓存路径。
- 生成方向摘要（不是完整原始 prompt 逐字转录）：*premium standalone 3D emblem; three interlocking orbital ribbons/prism around a luminous core; frosted glass with petrol teal edges, pearl ceramic and champagne highlights; transparent background; no text, neon or watermark*。
- 文件身份：SHA-256 `d2566488be82afbaad5130efe77ef93a848bbef644b8feab9bd9038b81c0a95c`。尺寸与字节数从最终 PNG 文件读取，不以请求的目标尺寸冒充实际输出。
- 用法：首页只加载一个静态图形；短序列由项目控制器动画化其位置、透明度与组合，不把位图当作按钮。明暗主题不依赖反色滤镜。

## 图标 API

```js
import { icon, brandMark, ICON_NAMES } from './icons.js';

// 装饰图标：相邻文字为操作提供可访问名称。
button.innerHTML = `${icon('book', { size: 18 })}<span>阅读原文</span>`;

// 纯图标按钮：可访问名称应放在按钮上。
closeButton.setAttribute('aria-label', '关闭原文阅读');
closeButton.innerHTML = icon('close', { size: 16 });

// 仅在图形自身需要名称时提供 title。
container.innerHTML = icon('warning', { size: 20, title: '需要关注' });

// 品牌本身为装饰图形，由邻近的产品名称或容器标签说明。
avatar.innerHTML = brandMark({ size: 28 });
```

- `icon(name, { size = 18, className = '', title = '' } = {})` 返回 SVG HTML 字符串。`ICON_NAMES` 为冻结的名称列表，新增图标应加入同一模块。
- 图标默认 `aria-hidden="true"`、`focusable="false"`；传入 `title` 后，使用 `role="img"`、`aria-label` 与 `<title>`。
- 未知名称回退为 `document`。尺寸限制在 8–256；非有限数值使用默认尺寸。标题和类名经过 HTML 转义；路径来自静态名称白名单。
- `brandMark({ size = 28, className = '' } = {})` 返回与 `mark.svg` 同形状的品牌 SVG。使用深墨底色、浅青与香槟色轨道，不随 `currentColor` 改色。
- 推荐界面尺寸 14、16、18、20、24 px。用 CSS 的 `display: inline-block; flex: none; vertical-align: middle` 保持对齐，不通过拉伸改变比例。

## 名称与语义

| 用途 | 图标名称 |
| --- | --- |
| 新建、导入、管理与记忆 | `plus`、`upload`、`folder`、`learning`、`archive`、`pin`、`undo`、`trash` |
| 任务状态与执行 | `activity`、`clock`、`loader`、`pause`、`check`、`warning`、`info`、`terminal` |
| 消息与常用操作 | `send`、`stop`、`copy`、`retry`、`download`、`eye`、`close`、`refresh`、`edit`、`user` |
| 检索、来源与阅读 | `search`、`quote`、`book`、`document`、`file-code`、`external` |
| 配置、主题与结构 | `settings`、`sun`、`moon`、`database`、`layers`、`inference`、`chevron-right`、`chevron-down` |
| 工作台与权限 | `spark`、`shield`、`branch`、`panels`、`compass` |
| 学科入口 | `flask`（材料与实验）、`chip`（计算机与工程）、`heart`（医学与健康）、`leaf`（生命与环境）、`building`（土木与建筑）、`chart`（经济与数据） |

`book` 用于论文、原文阅读，`learning` 用于长期记忆与学习；`check` 仅表示对应操作完成，不单独表达答案已经获得事实验证。`quote` 表示引用，不能替代“引用是否支持结论”的审计结果。`inference` 标识推断内容。状态同时提供文字，不只依靠颜色或图形。

## 配色与主题

| 色彩 | 值 | 用法 |
| --- | --- | --- |
| 冷瓷白 | `#F8F9FC` | 浅色工作台背景 |
| 深墨蓝 | `#182B3B` | 浅色主题正文与结构 |
| 轨道墨底 | `#152E3C` | 品牌标识背景 |
| 青绿 | `#1D6E77` | 浅色交互强调 |
| 浅青 | `#8AD1D0` | 深色交互强调 |
| 香槟 | `#F0D2AD` | 品牌轨道与少量装饰 |

基础主题变量仍由 `src/styles/app.css` 提供，`studio.css` 为本轮覆盖；交互图标通过 `currentColor` 跟随文字。品牌标识在浅深背景中保持固定配色；透明 PNG 直接叠在页面背景上，不增加白色底板。装饰浅色不直接用于浅背景的小字号正文，状态信息同时提供文字。

## 动效与无障碍

- SVG 源文件保持静态。仅在真实运行状态下由 CSS 旋转 `loader`；结束、停止或失败后切换相应的静态图标和文字。
- Motion 处理组件状态，GSAP 处理开屏序列；按钮另有浏览器原生按压反馈。开屏每浏览器会话自动播放一次，可跳过、关闭或重播；开始交互可结束，非必要动画遵循减少动态效果。
- 遵循 `prefers-reduced-motion: reduce`：停止旋转和非必要入场动效，继续展示完整状态文字。
- 消息和来源卡片只在首次新增时入场，任务步骤只在状态变化时反馈，避免流式文本更新反复触发动画。
- 使用 `button` 与可读标签承载操作，纯图标按钮提供 `aria-label` 并保留键盘焦点。首页图版的替代文本描述合取消去的逻辑关系。
- 设计板主题选择独立于产品设置：初始跟随系统浅深主题，手动切换只影响当前设计板页面，不读写产品的主题偏好。

## 查看设计板

启动应用后访问 **`/assets/brand/design-board.html`**，例如应用使用 3002 端口时：`http://localhost:3002/assets/brand/design-board.html`。

页面通过 HTTP 导入 `/src/ui/icons.js`，因此需要应用静态服务，不应直接用 `file://` 打开。它不依赖后端模型或数据库，可按名称或用途检索全部图标，并预览浅深主题、16–64 px 品牌标识、插画与减少动态效果。布局适配手机，图标网格在窄屏下使用三列。
