"""Frame verified release captures and build the offline publicity gallery."""
import argparse
from base64 import b64encode
from datetime import date
import hashlib
from html import escape
import json
from pathlib import Path
import struct
import tempfile

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
REAL = "本机界面"
FLOW = "本机链路 · 脚本模型"
DEMO = "设置预览 · 外部服务待验证"
GALLERY = (
    ("开始", (
        ("01-agent", "Agent 工作台", REAL, "选项目、写任务。常用入口在左栏，工具和执行状态在对话中查看。"),
        ("02-research", "知识库研究首页", REAL, "在知识库范围内提出问题，也可以从按范围刷新的问题索引开始。"),
        ("33-onboarding", "首次连接模型", REAL, "新用户可从输入区打开模型配置。首次连接与推理质量取决于所选后端。"),
        ("28-model", "模型接口与能力", DEMO, "自定义兼容地址、模型及能力选项。图中的回环演示地址已遮挡。"),
        ("32-command", "搜索与命令", REAL, "从命令面板切换页面、查找会话与打开常用设置。"),
        ("29-dark", "深色主题", REAL, "相同的工作台支持深色界面。"),
        ("34-appearance", "外观与动效", REAL, "设置主题、启动动画和减少动效偏好。"),
        ("30-mobile", "窄屏工作台", REAL, "Chromium 390 px 视口。移动系统和软键盘的长时间使用仍待验。"),
    )),
    ("研究", (
        ("03-library", "知识库 · 原始资料", REAL, "导入的案例和随包教材都可查看。导入样本为本次编写的 Markdown。"),
        ("39-sections", "整理学科分区", REAL, "选中导入资料组成分区，便于在对应范围内研究。"),
        ("04-conclusions", "验证结论", REAL, "候选结论可回到原文复查并申请确认。这张图展示新资料库的空状态。"),
        ("05-citations", "带引用的答案", FLOW, "答案由演示脚本提供。引用卡来自对公开教材的实际检索，默认折叠。"),
        ("06-source", "阅读并定位原文", FLOW, "阅读器高亮实际教材片段，并显示教材出处及许可。"),
        ("37-references", "导出参考文献", FLOW, "同一回答可导出 CSL-JSON、BibTeX、RIS 或 APA。本轮实际下载了 CSL-JSON。"),
        ("13-strategies", "文献推理策略", REAL, "可以选择 ReAct、IRCoT 或 ToT。策略优劣需在相同问题与模型上继续评估。"),
        ("14-hanlogic", "HanLogic 规则验算", REAL, "运行内置示例，查看成立与未知。证明只对示例给定的事实和规则成立。"),
        ("23-audit", "独立证据审核", DEMO, "审核接口、模型与预算可单独配置。真人评测与独立裁判服务仍需另行验收。"),
        ("24-search", "网站与学术搜索", DEMO, "搜索配置分别保存和测试。外部配额、资格和可用性随服务变化。"),
        ("25-joint", "联合研究与回答偏好", DEMO, "控制本地和外部证据候选的分配，外部来源需要有效配置。"),
    )),
    ("执行与交付", (
        ("07-approval", "逐次核对文件改动", FLOW, "审批卡展示真实差异，批准前临时项目内的原文件保持原样。"),
        ("08-execution", "查看 Agent 执行步骤", FLOW, "计划与工具事件来自本地编排器。图中耗时对应脚本模型的演示。"),
        ("09-preview", "对话与文件并排阅读", FLOW, "获批写入后的 Markdown 显示标题、表格和清单，左栏保留会话。"),
        ("10-preview-window", "独立文件阅读窗口", FLOW, "同一份项目产物可在单独窗口阅读、查看源码与下载。"),
        ("11-files", "项目文件", REAL, "按项目列出文件，支持预览与下载。图中的临时目录路径已遮挡。"),
        ("12-activity", "任务中心", REAL, "后台任务、等待处理和已结束记录集中在这里。此图使用独立演示资料。"),
        ("31-permissions", "项目文件权限", REAL, "逐次确认、信任当前项目和只读浏览均可在设置中查看。"),
    )),
    ("技能与设置", (
        ("15-capabilities", "能力导航", REAL, "查看内置能力及其配置入口。出现配置入口即表示可以设置，连通性单独测试。"),
        ("16-memory", "长期记忆", REAL, "环境事实与用户画像分栏管理。图示空状态，长周期画像质量待验证。"),
        ("17-skills", "技能库", REAL, "按任务选择技能。用户可以管理个人技能并核查技能来源。"),
        ("18-skill-detail", "技能详情与导出", REAL, "查看具体技能步骤，导出 Agent Skills ZIP。附件交换仍有兼容限制。"),
        ("19-settings", "设置导航", REAL, "使用顶部分类直接跳到功能设置。"),
        ("20-runtime", "执行环境", REAL, "在同一页查看命令、进程会话、本机浏览器和数学排版的配置。"),
        ("21-context", "上下文洞察", REAL, "查看会话预算及实际记录。脚本模型的统计用于演示，线上计费以服务端为准。"),
        ("38-monitor", "运行监控", REAL, "本地任务与存储指标来自隔离演示，耗时不能用作正式性能数据。"),
        ("22-team", "智能体团队配置", DEMO, "可填写成员职责与预算。本机第三方代理和模型组合的真实协作覆盖仍待验证。"),
        ("26-pack", "技能包只读预检", REAL, "预检仓库提供的示例目录，核对技能说明与当前兼容性，保持安装列表为空。"),
        ("27-mcp", "连接社区 MCP", REAL, "项目提供的本机 stdio 示例已通过发现、选择工具、逐次审批与实际调用。"),
        ("35-zotero", "连接 Zotero 文献库", DEMO, "使用本机 Zotero API 读取资料，需要单独检测自己的桌面服务。"),
        ("36-image", "独立图像接口", DEMO, "生成服务与对话模型分开配置，真实图像服务本轮未调用。"),
    )),
)
POSTERS = (
    ("00-cover", "从原文检索，<br>到项目交付",
     "在同一工作台读证据、核对文件变化，并保留可回看的交付物。",
     "09-preview", "项目文件预览", "本机链路 · 脚本模型"),
    ("00-evidence", "在答案旁<br>读回原文",
     "展开引用，定位教材片段。把依据、推断和还需核查的条件一起留下。",
     "06-source", "原文与引用", "公开教材 · 脚本对话"),
    ("00-community", "让研究流程<br>可以复用",
     "把核查步骤写成技能，先预检，再安装。通过独立连接选择可用的 MCP 工具。",
     "26-pack", "社区技能与插件", "本机预检 · 示例插件"),
)

BASE_CSS = """*{box-sizing:border-box}body{margin:0}
:root{--paper:#f8f9fc;--surface:#fff;--ink:#182b3b;--sub:#3c5061;--accent:#1d6e77;
--line:#dfe5ed;--sand:#f0d2ad;--mono:"Cascadia Mono",Consolas,monospace;
--sans:"Aptos","Segoe UI","Microsoft YaHei UI",sans-serif;
--serif:"Noto Serif SC","Songti SC",SimSun,serif}
body{font-family:var(--sans);color:var(--ink);background:var(--paper)}img{display:block;max-width:100%}
a{color:var(--accent);text-underline-offset:.23em}a:focus-visible{outline:3px solid var(--accent);outline-offset:5px}"""

FRAME_CSS = """body{background:#edf1f5}
main{padding:28px 34px 24px}
header, footer{display:flex;align-items:center;justify-content:space-between;gap:22px}
header{margin:0 2px 18px}h1{font-size:29px;margin:0;font-weight:650;line-height:1.3}
.version{font:600 16px var(--mono);letter-spacing:.04em;color:#2d5e66;white-space:nowrap}
img{border-radius:14px;outline:1px solid #c8d2df}
footer{margin:18px 2px 0;align-items:start;font-size:17px;line-height:1.55;color:var(--sub)}
footer p{margin:0;max-width:1080px}footer strong{white-space:nowrap;color:#1c5e68;font-weight:600}
body.compact header,body.compact footer{display:block}
body.compact .version{display:block;margin-top:9px;text-align:left}
body.compact footer strong{display:block;margin-bottom:4px}"""

POSTER_CSS = """body{width:1600px;height:1030px;background:#142d3c;color:#f8f9fc}
main{height:100%;padding:55px 61px;display:grid;grid-template-rows:60px 1fr 48px;gap:27px;
background:radial-gradient(ellipse at 82% 28%,#2d5963 0%,transparent 58%),
repeating-linear-gradient(0deg,transparent 0px 95px,#7fb6bd15 95px 96px),
repeating-linear-gradient(90deg,transparent 0px 95px,#7fb6bd15 95px 96px)}
header,footer{display:flex;align-items:center;justify-content:space-between;gap:28px}
.brand{display:flex;align-items:center;gap:15px;font-size:26px;letter-spacing:.04em;font-weight:650}
.brand img{width:48px;height:48px;outline:1px solid #70989d;border-radius:12px}
.brand small,.version,footer{font:500 17px/1.4 var(--mono);letter-spacing:.06em;color:#c5dadd}
.version{border:1px solid #9dbfc17a;border-radius:6px;padding:9px 13px}
.content{display:grid;grid-template-columns:388px minmax(0,1fr);align-items:center;gap:47px}
.description{padding-bottom:25px}.label{color:var(--sand);font-size:18px;letter-spacing:.12em}
h1{font:700 66px/1.16 var(--serif);margin:27px 0 25px;letter-spacing:-.04em}
.description p{font-size:22px;line-height:1.7;max-width:340px;margin:0;color:#d9e5e7}
.screenshot{margin:0;border:1px solid #a6c4c77a;border-radius:15px;overflow:hidden;padding:11px;
background:#e5eff4;box-shadow:0 28px 60px #071b26b0}
.screenshot img{width:100%;border-radius:8px;outline:1px solid #8faeb77f}
footer{border-top:1px solid #6c969e71;padding-top:10px}footer span:last-child{color:#f0d2ad}"""

GALLERY_CSS = """body{background:#edf2f7}.container{max-width:1312px;margin:auto;padding:0 36px}
.mast{background:#152e3c;color:#f8f9fc;padding:32px 0 25px}.mast h1{font:700 clamp(31px,5vw,54px)/1.2 var(--serif);margin:13px 0 9px}
.mast p{max-width:800px;line-height:1.65;margin:0;color:#cddfdf}.brand{display:flex;align-items:center;gap:12px}
.brand img{width:34px}.brand strong{letter-spacing:.04em}.version{font:600 14px var(--mono);color:#f0d2ad}
.toc{display:flex;flex-wrap:wrap;gap:15px 24px;padding:19px 0}.toc a{font-weight:600}
section{padding:14px 0 40px}.heading{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin:9px 0 18px}
h2{font:700 34px/1.2 var(--serif);margin:0}.heading span{color:#4e6979;font:15px var(--mono)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:20px}
.piece{display:flex;flex-direction:column;color:var(--ink);text-decoration:none;background:var(--surface);
border:1px solid #c8d2df;border-radius:14px;overflow:hidden}
.piece:hover,.piece:focus-visible{border-color:var(--accent)}
.piece img{width:100%;height:244px;object-fit:contain;background:#edf1f5}
.posters .piece img{height:auto;aspect-ratio:1600/1030}.piece div{padding:15px 16px 19px}
.piece h3{font-size:21px;margin:0 0 10px}.piece p,.piece small{line-height:1.55;margin:0;color:var(--sub)}
.piece small{display:block;color:var(--accent);margin-bottom:6px;font-weight:600}
footer{border-top:1px solid #c8d2df;margin:0 0 40px;padding-top:18px;line-height:1.7;color:var(--sub)}
@media(max-width:600px){.container{padding:0 18px}.mast{padding-top:23px}.piece img{height:auto;max-height:400px}}"""


def image_size(file):
    with file.open("rb") as stream:
        header = stream.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Not a PNG: {file.name}")
    return struct.unpack(">II", header[16:])


def page_html(title, css, body, compact=False, lang="zh-CN"):
    return (f'<!DOCTYPE html><html lang="{lang}"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>{escape(title)}</title><style>{BASE_CSS}{css}</style></head>'
            f'<body class="{"compact" if compact else ""}">{body}</body></html>\n')


def render(page, template, html, width, destination):
    template.write_text(html, "utf-8")
    page.set_viewport_size({"width": width, "height": 640})
    page.goto(template.as_uri(), wait_until="load")
    assert page.evaluate("""async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, image => image.decode()));
      return document.documentElement.scrollWidth <= innerWidth;
    }""")
    page.screenshot(path=str(destination), full_page=True)


def record(file):
    width, height = image_size(file)
    return {"file": "images/" + file.name, "width": width, "height": height,
            "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}


def gallery_html(manifest, kit):
    version = escape(manifest["version"])
    mark = b64encode((ROOT / "assets/brand/mark.svg").read_bytes()).decode("ascii")
    groups = [("宣传海报", manifest["posters"])] + [(group["group"], group["images"]) for group in manifest["groups"]]
    docs = (("features.md", "功能手册"), ("community.md", "社区扩展"), ("credits.md", "署名与素材"))
    nav = [f'<a href="{file}">{name}</a>' for file, name in docs if (kit / file).is_file()]
    index = ' · <a href="README.md">发布素材索引</a>' if (kit / "README.md").is_file() else ""
    sections = []
    for index, (group, images) in enumerate(groups):
        nav.append(f'<a href="#group-{index}">{escape(group)}</a>')
        tiles = []
        for entry in images:
            href, title = escape(entry["file"]), escape(entry["title"])
            width, height = entry["width"], entry["height"]
            tiles.append(f'<a class="piece" href="{href}" target="_blank" rel="noopener">'
                         f'<img src="{href}" alt="{title}" width="{width}" height="{height}" loading="lazy">'
                         f'<div><h3>{title}</h3><small>{escape(entry["status"])}</small>'
                         f'<p>{escape(entry["caption"])}</p></div></a>')
        sections.append(f'<section id="group-{index}" class="{"posters" if not index else ""}"><div class="heading">'
                        f'<h2>{escape(group)}</h2><span>{len(images)} 张</span></div><div class="grid">{"".join(tiles)}</div></section>')
    body = f"""<header class="mast"><div class="container">
    <div class="brand"><img src="data:image/svg+xml;base64,{mark}" alt=""><strong>知衡 · Logic KB Agent</strong>
    <span class="version">{version} Beta</span></div><h1>界面图册</h1>
    <p>从项目、证据到交付物。每张图都来自隔离环境的工作台，点击可查看原尺寸 PNG。带脚本模型或外部服务待验证的界面已单独注明。</p>
    </div></header><main class="container"><nav class="toc" aria-label="图册目录">{''.join(nav)}</nav>
    {''.join(sections)}<footer>基线 {escape(manifest["commit"][:7])} · 采集 {escape(manifest["captureDate"])}
    · <a href="manifest.json">图片尺寸和 SHA-256</a>{index}</footer></main>"""
    return page_html("知衡 Beta · 界面图册", GALLERY_CSS, body)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--captures", type=Path, required=True)
    parser.add_argument("--kit", type=Path, required=True, help="Release kit directory with docs and an empty images slot")
    parser.add_argument("--date", type=date.fromisoformat, required=True)
    args = parser.parse_args()
    captures = args.captures.resolve()
    kit = args.kit.resolve()
    images = kit / "images"
    images.mkdir(parents=True, exist_ok=True)
    if any(images.iterdir()):
        parser.error("Render into an empty images directory.")
    manifest = json.loads((captures / "capture.json").read_text("utf-8"))
    names = {name + ".png" for _, items in GALLERY for name, *_ in items}
    if set(manifest["images"]) != names:
        raise ValueError("Capture set does not match the gallery: " + str(set(manifest["images"]) ^ names))
    for name in names:
        if hashlib.sha256((captures / name).read_bytes()).hexdigest() != manifest["images"][name]:
            raise ValueError("Capture hash mismatch for " + name)
    raw_hashes = manifest.pop("images")
    manifest = {**manifest, "captureDate": args.date.isoformat(), "rawCaptureSha256": raw_hashes,
                "groups": [], "posters": []}

    with tempfile.TemporaryDirectory(prefix="zh-gallery-") as temp, sync_playwright() as playwright:
        template = Path(temp) / "page.html"
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(device_scale_factor=1)
        page.route("**/*", lambda route: route.continue_() if route.request.url.startswith("file:") else route.abort())
        version = escape(manifest["version"]) + " Beta"
        mark = (ROOT / "assets/brand/mark.svg").as_uri()
        for name, headline, caption, shot, title, status in POSTERS:
            body = f"""<main><header><div class="brand"><img src="{mark}" alt=""><span>知衡</span><small>LOGIC KB AGENT</small></div>
            <div class="version">{version}</div></header><div class="content"><div class="description">
            <div class="label">{escape(title)}</div><h1>{headline}</h1><p>{escape(caption)}</p></div>
            <figure class="screenshot"><img src="{(captures / (shot + '.png')).as_uri()}" alt="{escape(title)}"></figure></div>
            <footer><span>知衡 · Agent 工作台</span><span>{escape(status)}</span></footer></main>"""
            destination = images / (name + ".png")
            render(page, template, page_html(title, POSTER_CSS, body), 1600, destination)
            manifest["posters"].append({**record(destination), "title": headline.replace("<br>", ""), "status": status,
                                        "caption": caption, "fromCapture": shot + ".png"})
        for group, items in GALLERY:
            entries = []
            for name, title, status, caption in items:
                raw = captures / (name + ".png")
                width, height = image_size(raw)
                body = f"""<main><header><h1>{escape(title)}</h1><div class="version">知衡 · {version}</div></header>
                <img src="{raw.as_uri()}" width="{width}" height="{height}" alt="{escape(title)}">
                <footer><strong>{escape(status)}</strong><p>{escape(caption)}</p></footer></main>"""
                destination = images / (name + ".png")
                render(page, template, page_html(title, FRAME_CSS, body, compact=width < 700), width + 68, destination)
                entries.append({**record(destination), "title": title, "status": status,
                                "caption": caption, "fromCapture": raw.name})
            manifest["groups"].append({"group": group, "images": entries})
        browser.close()

    (kit / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")
    (kit / "gallery.html").write_text(gallery_html(manifest, kit), "utf-8")
    print(f"Rendered {len(names)} interface images and {len(POSTERS)} posters")


if __name__ == "__main__":
    main()
