"""Capture Beta UI publicity from a committed snapshot with disposable data.

Run with Python Playwright and an installed Chromium. All model output comes
from the scripted model below. The browser and app use only the local machine.
"""
import argparse
from contextlib import contextmanager
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
APP_FILES = ("server.mjs", "index.html", "preview.html", "package.json", "src",
             "assets", "data/formal", "db", "skill-library")
EXAMPLE = ROOT / "examples/community"
QUESTION = "教材怎样定义霍尔三元组？已满足前置条件时，能否据此保证程序终止？"
RESEARCH_QUERY = "霍尔三元组 前置条件 后置条件 结束状态 停机"
RESEARCH_QUOTE = "最终在一个结束状态停机，这个结束状态会满足断言 [Q]。"
ASSIGNMENT = "请把霍尔三元组的核查结果写成一份 Markdown 备忘录，列出前提、结论和复查项。"
REPORT_PATH = "程序验证备忘录.md"
EARLY_CLAIM = "初稿：满足霍尔三元组就能证明程序会终止。"
CHECKED_CLAIM = "**部分正确性只约束终止后的结果。** 若初始状态满足前置条件，且程序执行终止，则结束状态应满足后置条件。"
REPORT = """# 程序验证备忘录

## 核查结论

**部分正确性只约束终止后的结果。** 若初始状态满足前置条件，且程序执行终止，则结束状态应满足后置条件。

| 核查项 | 记录 |
| --- | --- |
| 前置条件 | 初始状态满足 P |
| 后置条件 | 执行结束后，状态满足 Q |
| 另行验证 | 程序是否终止 |

## 复查清单

- 区分部分正确性与完全正确性。
- 回读 Software Foundations「Hoare Logic」的定义。
- 检查所用语义是否把终止性作为证明义务。
"""
EARLY_REPORT = REPORT.replace(CHECKED_CLAIM, EARLY_CLAIM)
IMPORT_TEXT = """# 程序验证案例

本资料记录一个教学案例，讨论赋值语句、前置条件与后置条件。

## 案例：计数器递增

给定 count = 4，执行 count := count + 1 后，后置条件为 count = 5。
推导时先将后置条件里的 count 替换为 count + 1，再回到执行前状态核对。

## 适用范围

该案例只讨论顺序执行的单条赋值，整数按数学整数处理。
涉及并发、溢出或循环时，需先确定语义，再重新检查相应规则。
"""


def run(*args, cwd=ROOT, env=None):
    return subprocess.check_output(args, cwd=cwd, env=env, encoding="utf-8").strip()


@contextmanager
def snapshot(temp, commit):
    archive = temp / "source.zip"
    run("git", "archive", "-o", str(archive), commit, "--", *APP_FILES)
    app = temp / "app"
    with ZipFile(archive) as package:
        package.extractall(app)
    dependencies = ROOT / "node_modules"
    if not dependencies.is_dir():
        raise RuntimeError("Install the project's locked Node dependencies first.")
    target = app / "node_modules"
    if os.name == "nt":
        # The junction is removed on its own before the disposable tree is cleaned.
        run("powershell.exe", "-NoProfile", "-Command", "$null = New-Item -ItemType Junction "
            "-Path $env:ZH_CAPTURE_MODULES -Target $env:ZH_CAPTURE_NODE_MODULES",
            env={**os.environ, "ZH_CAPTURE_MODULES": str(target), "ZH_CAPTURE_NODE_MODULES": str(dependencies)})
    else:
        target.symlink_to(dependencies, target_is_directory=True)
    try:
        shutil.copytree(EXAMPLE, app / "examples/community")
        yield app
    finally:
        if os.name == "nt":
            target.rmdir()
        else:
            target.unlink()


@contextmanager
def app_server(app, data, node):
    system = {"SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "LANG"}
    env = {k: v for k, v in os.environ.items() if k.upper() in system}
    env.update({
        "USERPROFILE": str(data), "APPDATA": str(data), "LOCALAPPDATA": str(data),
        "DATA_DIR": str(data), "PORT": "0", "HOST": "127.0.0.1", "AUTH_SECRET": secrets.token_urlsafe(32),
        "MYSQL_ENABLED": "false", "REDIS_ENABLED": "false", "CORPUS_PROFILE": "formal",
        "EMBEDDING_PROVIDER": "local", "RERANK_ENABLED": "false", "MINERU_ENABLED": "false",
        "WEB_FETCH_ENABLED": "false", "SCHOLAR_SEARCH": "false", "INFERENCE_AUDIT": "false", "EXEC_ENABLED": "false",
        "LANGFUSE_ENABLED": "false", "MCP_ENABLED": "false", "RATE_LIMIT_PER_MIN": "1000",
        "AUX_LLM_MAX_CALLS": "0", "JUDGE_ENABLED": "false", "NO_PROXY": "localhost,127.0.0.1",
    })
    data.mkdir()
    with (data / "capture.log").open("w+", encoding="utf-8") as log:
        process = subprocess.Popen([node, "server.mjs"], cwd=app, env=env, stdout=log,
                                   stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        try:
            marker = data / ".server-port"
            opener = build_opener(ProxyHandler({}))
            for _ in range(300):
                if process.poll() is not None:
                    break
                if marker.exists():
                    url = "http://127.0.0.1:" + marker.read_text(encoding="utf-8").strip()
                    try:
                        with opener.open(url + "/api/health", timeout=1) as response:
                            health = json.load(response)
                    except (URLError, OSError, ValueError):
                        time.sleep(0.1)
                        continue
                    if health["ready"] and health["corpus"]["profile"] == "formal":
                        yield url, env, health
                        return
                time.sleep(0.1)
            log.seek(0)
            raise RuntimeError(log.read()[-2000:])
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)


@contextmanager
def scripted_model():
    state = {"research_ref": "", "task": "", "calls": 0}

    def plan(states):
        return {"items": [{"content": name, "status": status} for name, status in zip(
            ("整理问题与证据", "撰写 Markdown 备忘录", "确认变更并交付"), states, strict=True)]}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["calls"] += 1
            messages = request["messages"]
            tool_messages = [item for item in messages if item["role"] == "tool"]
            names = [entry["function"]["name"] for item in messages for entry in (item.get("tool_calls") or [])]
            available = {tool["function"]["name"] for tool in request.get("tools") or []}
            tool = None
            if state["task"] == "report":
                if "update_plan" in available and not tool_messages:
                    tool = "update_plan", plan(("completed", "in_progress", "pending"))
                elif "patch_file" in available and "patch_file" not in names:
                    tool = "patch_file", {"path": REPORT_PATH, "old_text": EARLY_CLAIM, "new_text": CHECKED_CLAIM}
                elif "update_plan" in available and names.count("update_plan") == 1:
                    tool = "update_plan", plan(("completed", "completed", "completed"))
                answer = "已把前置条件、后置条件和终止性核查项整理到《程序验证备忘录》。文件可直接预览。"
            elif state["task"] == "research":
                if "search_knowledge" in available and not tool_messages:
                    tool = "search_knowledge", {"query": RESEARCH_QUERY, "source": "paper", "top_k": 6}
                elif "verify_quote" in available and "verify_quote" not in names:
                    tool = "verify_quote", {"ref": state["research_ref"], "quote": RESEARCH_QUOTE}
                answer = ("**教材给出的是一个有条件的保证。** 前置条件 P 成立且程序终止时，最终状态应满足 Q。\n\n"
                          "教材写道：“" + RESEARCH_QUOTE + "”[[" + state["research_ref"] + "]]\n\n"
                          "要证明程序一定终止，还需另行提供终止性论证。")
            elif state["task"] == "glossary":
                if "list_extensions" in available and "list_extensions" not in names:
                    tool = "list_extensions", {}
                elif "extension_tools" in available and "extension_tools" not in names:
                    tool = "extension_tools", {"extension": "demo-glossary"}
                elif "call_extension" in available and "call_extension" not in names:
                    tool = "call_extension", {"extension": "demo-glossary", "revision": state["plugin_rev"],
                                              "tool": "lookup_term", "arguments": {"term": "证据不足"}}
                elif "tool_describe" in available and "tool_describe" not in names:
                    tool = "tool_describe", {"name": "call_extension"}
                result = next((item["content"] for item in tool_messages if "手头材料不足以支持或反驳" in item["content"]), "")
                state["lookup_observed"] = bool(result)
                answer = "已查到术语。证据不足时，先记下待核查的出处和条件，再补充原文。"
            else:
                answer = "已完成演示任务。"
            if tool:
                name, arguments = tool
                delta = {"tool_calls": [{"index": 0, "id": "demo-" + str(len(names)), "type": "function",
                                         "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)}}]}
                ending = "tool_calls"
            else:
                delta, ending = {"content": answer}, "stop"
            payload = "".join("data: " + json.dumps({"id": "demo", "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": content, "finish_reason": finish}]}, ensure_ascii=False) + "\n\n"
                for content, finish in (({"role": "assistant", **delta}, None), ({}, ending))) + "data: [DONE]\n\n"
            raw = payload.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        service = threading.Thread(target=server.serve_forever, daemon=True)
        service.start()
        provider = {"baseUrl": f"http://127.0.0.1:{server.server_port}/v1", "model": "演示模型", "apiKey": "local-demo"}
        try:
            yield provider, state
        finally:
            server.shutdown()
            service.join()


def json_request(response):
    if not response.ok:
        raise RuntimeError(f"HTTP {response.status} for {response.url}: {response.text()[:400]}")
    return response.json()


def browser_context(browser, base, provider=None, theme="light", width=1440, height=1000):
    context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1.25,
                                  color_scheme=theme, reduced_motion="reduce", locale="zh-CN")
    model = f"localStorage.setItem('lkba.provider.v1',{json.dumps(json.dumps(provider))});" if provider else ""
    context.add_init_script(f"""if (window.top === window && location.origin === {json.dumps(base)}) {{
      sessionStorage.setItem('zh.intro.played','1');
      localStorage.setItem('csl.theme',{json.dumps(theme)});
      if (!localStorage.getItem('lkba.provider.v1')) {{ {model} }}
    }}""")
    context.route("**/*", lambda route: route.continue_() if route.request.url.startswith(base + "/") else route.abort())
    return context


def visit(page, base):
    page.goto(base, wait_until="networkidle")
    expect(page.locator("#input")).to_be_visible()


def settings(page, section):
    if not page.locator("dialog.app-settings[open]").count():
        page.locator("#btn-settings").click()
    button = page.locator(f'[data-settings-section="{section}"]')
    button.click()
    expect(button).to_have_attribute("aria-current", "location")
    page.wait_for_function("""(section) => {
      const body = document.querySelector('.configuration-body');
      const target = document.querySelector('[data-configuration-section="' + section + '"]');
      const delta = target.getBoundingClientRect().top - body.getBoundingClientRect().top;
      return Math.abs(delta) < 32 || (delta >= 0 && delta < body.clientHeight &&
        body.scrollTop + body.clientHeight >= body.scrollHeight-2);
    }""", arg=section)


def close_settings(page):
    page.locator("#app-settings-close").click()
    expect(page.locator("dialog.app-settings[open]")).to_have_count(0)


def save_ui(page, target, mask=()):
    page.evaluate("async () => { await document.fonts.ready; await Promise.allSettled([...document.images].map(img => img.decode())); }")
    page.screenshot(path=str(target), animations="disabled", mask=list(mask), mask_color="#dfe5ed")


def register_project(node, app, env, user, folder):
    folder.mkdir()
    command = """import {selectWorkspace} from './src/server/workspace-selection.mjs';
      await selectWorkspace(process.argv[1], 'choose', {picker:async () => process.argv[2]});"""
    run(node, "--input-type=module", "-e", command, user, str(folder), cwd=app, env=env)


def inspect(page):
    controls = page.get_by_role("button").evaluate_all("""nodes => nodes.filter(n=>n.getClientRects().length)
      .slice(0,45).map(n=>[n.id,n.textContent.trim().slice(0,48),n.getAttribute('aria-label')])""")
    print(json.dumps(controls, ensure_ascii=False))


def capture(browser, base, provider, state, app, data, env, node, output, recon):
    if not recon:
        onboarding = browser_context(browser, base)
        initial = onboarding.new_page()
        visit(initial, base)
        expect(initial.locator("#model-onboarding")).to_be_visible()
        save_ui(initial, output / "33-onboarding.png")
        onboarding.close()
    context = browser_context(browser, base, provider)
    page = context.new_page()
    page.set_default_timeout(8000)
    errors = []
    context.on("page", lambda popup: popup.on("pageerror", lambda error: errors.append(str(error))))
    page.on("pageerror", lambda error: errors.append(str(error)))
    def photo(name, mask=()):
        print(f"capture {name}", flush=True)
        save_ui(page, output / (name + ".png"), mask)

    visit(page, base)
    if recon:
        inspect(page)
        return

    photo("01-agent")
    page.locator('[data-task-mode="knowledge"]').click()
    expect(page.locator('[data-context-scope]')).to_contain_text("全部知识库")
    expect(page.get_by_role("heading", name="研究问题索引")).to_be_visible()
    photo("02-research")

    boot = json_request(page.request.get(base + "/api/bootstrap"))
    user = boot["user"]["id"]
    folder = data.parent / "程序验证札记"
    register_project(node, app, env, user, folder)
    page.reload(wait_until="networkidle")
    expect(page.locator("#task-context")).to_contain_text(folder.name)
    page.locator("#file-input").set_input_files(
        {"name": "程序验证案例.md", "mimeType": "text/markdown", "buffer": IMPORT_TEXT.encode("utf-8")})
    expect(page.locator("#btn-section")).to_be_enabled()
    page.locator("#btn-section").click()
    expect(page.get_by_role("dialog").last).to_contain_text("程序验证案例.md")
    photo("39-sections")
    page.keyboard.press("Escape")
    page.locator("#btn-knowledge").click()
    page.locator('[data-page="documents"]').click()
    expect(page.locator('[data-document]')).to_have_count(1)
    photo("03-library")
    page.locator('[data-page="conclusions"]').click()
    expect(page.get_by_role("heading", name="验证结论")).to_be_visible()
    photo("04-conclusions")
    page.locator('dialog[data-workbench="knowledge"] [data-panel-close]').click()

    page.locator('[data-task-mode="knowledge"]').click()
    hits = json_request(page.request.post(base + "/api/search", data={
        "query": RESEARCH_QUERY, "channels": ["paper"], "k": 12}))["results"]
    definition = next(hit for hit in hits if hit["title"] == "霍尔逻辑 · 霍尔三元组")
    assert definition["recordType"] == "textbook-section"
    source = json_request(page.request.get(base + "/api/source/" + definition["ref"]))
    assert RESEARCH_QUOTE in source["content"]
    state.update(research_ref=definition["ref"], task="research")
    page.locator("#input").fill(QUESTION)
    page.locator("#send").click()
    answer = page.locator(".msg.assistant").last
    expect(answer.locator("details.evidence")).to_be_attached(timeout=18000)
    assert answer.locator("details.evidence").get_attribute("open") is None
    answer.locator("details.evidence > summary").click()
    expect(answer.locator(".ev").first).to_be_visible()
    photo("05-citations")
    answer.locator(".ev").first.click()
    expect(page.locator("#reader-body mark").first).to_have_text(RESEARCH_QUOTE)
    expect(page.locator("#reader-head h3")).to_have_text(definition["title"])
    photo("06-source")
    page.locator(".reader-close").click()
    answer.get_by_text("导出参考文献", exact=True).click()
    expect(answer.get_by_role("button", name="CSL-JSON")).to_be_visible()
    photo("37-references")
    with page.expect_download() as references:
        answer.get_by_role("button", name="CSL-JSON").click()
    assert "霍尔三元组" in references.value.path().read_text(encoding="utf-8")

    page.locator("#btn-new").click()
    page.locator('[data-task-mode="agent"]').click()
    assert EARLY_REPORT != REPORT
    (folder / REPORT_PATH).write_text(EARLY_REPORT, encoding="utf-8")
    state["task"] = "report"
    page.locator("#input").fill(ASSIGNMENT)
    page.locator("#send").click()
    approve = page.get_by_role("button", name="批准", exact=True)
    expect(approve).to_be_visible(timeout=18000)
    assert (folder / REPORT_PATH).read_text(encoding="utf-8") == EARLY_REPORT
    page.set_viewport_size({"width": 1440, "height": 1250})
    approval_card = page.locator(".approval-card").last
    approval_card.evaluate("card => card.scrollIntoView({block:'center',behavior:'instant'})")
    expect(approval_card.locator(".ap-head")).to_be_in_viewport()
    expect(approve).to_be_in_viewport()
    photo("07-approval")
    approve.click()
    page.set_viewport_size({"width": 1440, "height": 1000})
    file_card = page.locator(".fc-window").last
    expect(file_card).to_be_visible(timeout=18000)
    assert (folder / REPORT_PATH).read_text(encoding="utf-8") == REPORT
    assistant = page.locator(".msg.assistant").last
    trace = assistant.locator(".trace-head").first
    trace.click()
    trace.scroll_into_view_if_needed()
    photo("08-execution")
    file_card.locator("..").get_by_role("button", name="预览").click()
    expect(page.get_by_role("heading", name="程序验证备忘录", exact=True)).to_be_visible()
    photo("09-preview")
    with context.expect_page() as new_window:
        page.locator("[data-open-window]").click()
    standalone = new_window.value
    expect(standalone.get_by_role("heading", name="程序验证备忘录", exact=True)).to_be_visible()
    save_ui(standalone, output / "10-preview-window.png")
    standalone.close()
    page.get_by_role("button", name="关闭文件预览").click()
    page.locator("#btn-workspace").click()
    expect(page.get_by_text(REPORT_PATH, exact=True).last).to_be_visible()
    photo("11-files", [page.locator("[data-ws-path]")])
    page.keyboard.press("Escape")

    page.locator("#btn-activity").click()
    expect(page.get_by_role("heading", name="任务中心")).to_be_visible()
    photo("12-activity")
    page.keyboard.press("Escape")
    page.locator("#btn-logic").click()
    expect(page.get_by_role("tab", name="文献推理")).to_be_visible()
    photo("13-strategies")
    page.get_by_role("tab", name="规则验算").click()
    page.locator("#logic-run").click()
    expect(page.locator("#logic-output")).to_contain_text("未知")
    page.locator(".logic-proofs > summary").first.click()
    page.locator("#logic-output").scroll_into_view_if_needed()
    photo("14-hanlogic")
    page.keyboard.press("Escape")

    page.locator("#btn-capabilities").click()
    expect(page.locator(".capability-dialog")).to_be_visible()
    photo("15-capabilities")
    page.locator(".capability-dialog [data-close]").click()
    page.locator("#btn-learn").click()
    learning = page.locator('dialog[data-workbench="learning"]')
    expect(learning).to_be_visible()
    learning.get_by_role("tab", name="记忆", exact=True).click()
    photo("16-memory")
    learning.get_by_role("tab", name="技能", exact=True).click()
    expect(learning.locator('[data-view="citation-export"]')).to_be_visible()
    photo("17-skills")
    learning.locator('[data-view="citation-export"]').click()
    detail = page.get_by_role("dialog", name="citation-export", exact=True)
    expect(detail.get_by_role("button", name="导出 Agent Skills ZIP")).to_be_visible()
    photo("18-skill-detail")
    detail.get_by_role("button", name="关闭技能详情").click()
    learning.locator(".modal-head [data-panel-close], .modal-head [data-close]").first.click()

    settings(page, "overview")
    photo("19-settings")
    settings(page, "appearance")
    photo("34-appearance")
    for section, image in (("runtime", "20-runtime"), ("context", "21-context"), ("teams", "22-team"),
                           ("judge", "23-audit"), ("search", "24-search")):
        settings(page, section)
        photo(image)
    settings(page, "preferences")
    photo("25-joint")
    settings(page, "permissions")
    photo("31-permissions")
    # Keep the example outside the source tree and within the registered demo project.
    pack = folder / "evidence-desk-pack"
    shutil.copytree(EXAMPLE / pack.name, pack)
    settings(page, "integrations")
    page.locator('.integration-nav [data-panel="zotero"]').click()
    expect(page.locator("#zotero-enabled")).to_be_visible()
    photo("35-zotero")
    page.locator('.integration-nav [data-panel="image"]').click()
    expect(page.locator("#image-enabled")).to_be_visible()
    photo("36-image")
    page.locator('.integration-nav [data-panel="packs"]').click()
    page.get_by_label("工作区相对路径").fill(pack.name)
    page.get_by_role("button", name="只读预检").click()
    expect(page.get_by_role("region", name="预检详情")).to_contain_text("evidence-desk-check")
    packs_url = base + "/api/settings/plugin-packs"
    assert not json_request(page.request.get(packs_url))["packs"]
    photo("26-pack")
    field = page.get_by_label("工作区相对路径")
    field.fill(pack.name + "/plugin.json")
    page.get_by_role("button", name="安装插件包").click()
    expect(page.locator("#pack-count")).to_have_text("1 个")
    close_settings(page)
    page.locator("#btn-learn").click()
    learning = page.locator('dialog[data-workbench="learning"]')
    learning.get_by_role("tab", name="技能", exact=True).click()
    learning.locator('[data-view="evidence-desk-check"]').click()
    custom_skill = page.get_by_role("dialog", name="evidence-desk-check", exact=True)
    with page.expect_download() as event:
        custom_skill.get_by_role("button", name="导出 Agent Skills ZIP").click()
    with ZipFile(event.value.path()) as archive:
        [entry] = archive.namelist()
        assert entry == "evidence-desk-check/SKILL.md"
        exported = archive.read(entry)
        assert "逐条复查引文" in exported.decode("utf-8")
    export_folder = folder / "回读" / "evidence-desk-check"
    export_folder.mkdir(parents=True)
    (export_folder / "SKILL.md").write_bytes(exported)
    custom_skill.get_by_role("button", name="关闭技能详情").click()
    learning.locator(".modal-head [data-panel-close], .modal-head [data-close]").first.click()
    preflight = json_request(page.request.post(packs_url + "/preflight", headers={"x-settings-request": "1", "Origin": base},
                                              data={"path": "回读/evidence-desk-check"}))
    assert "evidence-desk-check" in json.dumps(preflight, ensure_ascii=False)

    # Connect the checked-in example through the actual gateway. A test connection
    # has no approved tools; an owner explicitly selects lookup_term before saving.
    endpoint = base + "/api/settings/extensions"
    headers = {"x-settings-request": "1", "Origin": base}
    current = json_request(page.request.get(endpoint))
    config = {"id": "demo-glossary", "name": "社区术语表示例", "kind": "stdio",
              "command": node, "args": [str(app / "examples/community/glossary-mcp.mjs")],
              "revision": current["revision"]}
    detected = json_request(page.request.post(endpoint, headers=headers, data={**config, "test": True}))
    connected = next(entry for entry in detected["entries"] if entry["id"] == "demo-glossary")
    assert not connected["enabled"]
    assert len(connected["tools"]) == 1 and not connected["tools"][0]["allowed"]
    saved = json_request(page.request.post(endpoint, headers=headers, data={
        **config, "revision": detected["revision"], "enabled": True, "allowedTools": ["lookup_term"]}))
    extension = next(entry for entry in saved["entries"] if entry["id"] == "demo-glossary")
    assert extension["enabled"] and extension["tools"][0]["allowed"]
    settings(page, "extensions")
    expect(page.get_by_text("社区术语表示例", exact=True).first).to_be_visible()
    photo("27-mcp")
    close_settings(page)
    page.locator("#pill-model").click()
    expect(page.get_by_role("dialog").last).to_be_visible()
    photo("28-model", [page.locator("#f-base")])
    page.get_by_role("button", name="关闭模型设置").click()
    page.locator("#btn-new").click()
    state.update(task="glossary", plugin_rev=extension["revision"])
    page.locator("#input").fill("请用社区术语表解释证据不足。")
    page.locator("#send").click()
    expect(approve).to_be_visible(timeout=18000)
    assert not state.get("lookup_observed")
    approve.click()
    expect(page.get_by_text("已查到术语。证据不足时，先记下待核查的出处和条件，再补充原文。")).to_be_visible(timeout=18000)
    assert state.get("lookup_observed"), "The captured model did not receive the actual glossary result"
    page.locator("#runtime-status > summary").click()
    page.locator("#btn-monitor").click()
    expect(page.get_by_role("heading", name="运行监控")).to_be_visible()
    photo("38-monitor")
    page.get_by_role("button", name="关闭运行监控").click()
    page.locator("#btn-command").click()
    expect(page.get_by_role("dialog").last).to_be_visible()
    photo("32-command")
    context.close()

    cases = (("dark", 1440, 980, "29-dark"), ("light", 390, 844, "30-mobile"))
    for theme, width, height, image in cases:
        context = browser_context(browser, base, provider, theme, width, height)
        page = context.new_page()
        visit(page, base)
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
        photo(image)
        context.close()
    assert not errors, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--output", type=Path, required=True, help="Empty directory for raw screenshots and capture.json")
    parser.add_argument("--recon", action="store_true", help="Print the visible controls in a fresh session")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        parser.error("Use an empty output directory.")
    commit = run("git", "rev-parse", "--verify", f"{args.ref}^{{commit}}")
    node = shutil.which("node")
    if not node:
        parser.error("Node.js is required.")
    with tempfile.TemporaryDirectory(prefix="zh-release-ui-") as directory:
        temp = Path(directory)
        data = temp / "data"
        with snapshot(temp, commit) as app, app_server(app, data, node) as (base, env, health), \
                scripted_model() as (provider, state), sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                capture(browser, base, provider, state, app, data, env, node, output, args.recon)
                if not args.recon:
                    record = {"commit": commit, "version": health["version"], "chromium": browser.version,
                              "node": run(node, "--version"), "corpusRecords": health["corpus"]["papers"],
                              "scriptedModelCalls": state["calls"], "externalModelCalls": 0,
                              "localMcpResultObserved": state["lookup_observed"],
                              "images": {file.name: hashlib.sha256(file.read_bytes()).hexdigest()
                                         for file in sorted(output.glob("*.png"))}}
                    (output / "capture.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", "utf-8")
                    print(json.dumps({k: v for k, v in record.items() if k != "images"}, ensure_ascii=False))
            finally:
                browser.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
