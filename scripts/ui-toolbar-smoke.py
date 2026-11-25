"""Real isolated-server acceptance of the navigation and preference redesign.

Run: python scripts/ui-toolbar-smoke.py
Requires Python Playwright and Chromium. All writes use a disposable DATA_DIR.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".shots" / "toolbar"
spec = importlib.util.spec_from_file_location("logic_ui_helpers", ROOT / "scripts" / "ui-logic-smoke.py")
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def snapshot(page, name):
    page.evaluate("""async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
      await Promise.allSettled(document.getAnimations().filter(animation =>
        animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
    }""")
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def no_overflow(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), "viewport overflow"
    assert page.locator(".topbar").evaluate("node => node.scrollWidth <= node.clientWidth + 1"), "toolbar overflow"
    assert page.locator(".sidebar").evaluate("node => node.scrollWidth <= node.clientWidth + 1"), "sidebar overflow"


def open_sidebar(page):
    trigger = page.locator("#btn-sidebar")
    if trigger.is_visible() and trigger.get_attribute("aria-expanded") != "true":
        trigger.click()


def click_navigation(page, selector):
    if not page.locator(selector).is_visible():
        open_sidebar(page)
    page.locator(selector).click()


def open_settings(page):
    if not page.locator("dialog.app-settings").is_visible():
        click_navigation(page, "#btn-settings")
    expect(page.locator("dialog.app-settings")).to_be_visible()
    expect(page.locator("#settings-preferences-slot zh-preferences")).to_have_count(1)
    expect(page.locator("zh-preferences")).to_have_count(1)


def close_settings(page):
    page.locator("#app-settings-close").click()
    expect(page.locator("dialog.app-settings")).to_have_count(0)
    expect(page.locator("#preferences-host zh-preferences")).to_have_count(1)
    expect(page.locator("zh-preferences")).to_be_hidden()


def preference(page, key, value):
    return page.locator(f'#pref-{key} input[type=radio][value={json.dumps(value, ensure_ascii=False)}]')


def preference_response(response):
    return response.url.endswith("/api/preferences") and response.request.method == "POST"


def click_choice(page, key, value):
    label = page.locator(f"#pref-{key} label").filter(
        has=page.locator(f'input[value={json.dumps(value, ensure_ascii=False)}]')
    )
    label.click()


def save_choice(page, key, value):
    with page.expect_response(preference_response) as pending:
        click_choice(page, key, value)
    assert pending.value.ok, pending.value.text()
    expect(preference(page, key, value)).to_be_checked()


def verify_overlapping_saves(page, base):
    # Hold a real write while the user clicks again; both requests ultimately hit
    # the same disposable server and the last selection must survive a reload.
    delayed = []
    page.route("**/api/preferences", lambda route: delayed.append(route), times=1)
    with page.expect_request(lambda request: request.url.endswith("/api/preferences")):
        click_choice(page, "style", "balanced")
    click_choice(page, "style", "concise")
    expect(preference(page, "style", "concise")).to_be_checked()
    with page.expect_response(lambda response: preference_response(response) and
                              response.request.post_data_json["preferences"].get("style") == "concise") as pending:
        delayed[0].continue_()
    assert pending.value.ok
    assert page.request.get(base + "/api/bootstrap").json()["preferences"]["style"] == "concise"
    expect(preference(page, "style", "concise")).to_be_checked()

    # An immediate question must wait for the selected preference to commit.
    # Reject the save and check that no model task was submitted.
    delayed.clear()
    chat_requests = []
    def record_chat(request):
        if request.url.endswith("/api/chat"):
            chat_requests.append(request)
    page.on("request", record_chat)
    page.route("**/api/preferences", lambda route: delayed.append(route), times=1)
    with page.expect_request(lambda request: request.url.endswith("/api/preferences")):
        click_choice(page, "style", "detailed")
    close_settings(page)
    page.locator("#input").fill("请说明合取命题。")
    page.locator("#input").press("Enter")
    with page.expect_response(preference_response) as failed:
        delayed[0].fulfill(status=503, json={"error": "test failure"})
    assert failed.value.status == 503
    expect(page.locator(".msg.assistant").last).to_contain_text("本次提问未发送")
    expect(page.locator("#input")).to_have_value("请说明合取命题。")
    assert not chat_requests
    page.remove_listener("request", record_chat)
    open_settings(page)
    expect(preference(page, "style", "concise")).to_be_checked()
    expect(page.locator("#pref-status")).to_have_attribute("data-kind", "error")
    expect(page.locator("#pref-status")).to_have_attribute("role", "status")
    expect(page.locator("#pref-status")).to_be_visible()
    expect(page.locator("#pref-status")).not_to_be_empty()
    assert page.request.get(base + "/api/bootstrap").json()["preferences"]["style"] == "concise"
    save_choice(page, "style", "detailed")
    expect(page.locator("#pref-status")).to_have_attribute("data-kind", "saved")


def verify_dynamic_disciplines(page, narrow):
    # Import names are corpus data: render a long name and markup as literal text.
    names = ["程序语言语义与形式化验证", "Logic" * 20, '<img data-ui-probe src=x onerror="window.uiProbe=1">']
    def extra_disciplines(route):
        response = route.fetch()
        bootstrap = response.json()
        bootstrap["corpus"]["disciplines"].extend({"name": name, "count": 1} for name in names)
        route.fulfill(response=response, json=bootstrap)
    page.route("**/api/bootstrap", extra_disciplines, times=1)
    page.reload(wait_until="networkidle")
    open_settings(page)
    group = page.locator("#pref-discipline")
    for name in names:
        label = group.get_by_text(name, exact=True)
        expect(label).to_be_visible()
        assert label.evaluate("node => node.scrollWidth <= node.clientWidth + 1"), name
    expect(group.locator("[data-ui-probe]")).to_have_count(0)
    assert page.evaluate("window.uiProbe === undefined")
    no_overflow(page)
    close_settings(page)


def seed_conversations(page, base):
    for title in ("霍尔逻辑中的循环不变式", "合取命题：从证明到程序"):
        created = page.request.post(base + "/api/conversations", data={})
        assert created.ok, created.text()
        conversation = created.json()["conversation"]
        renamed = page.request.patch(base + "/api/conversations/" + conversation["id"], data={"title": title})
        assert renamed.ok, renamed.text()
    page.reload(wait_until="networkidle")
    expect(page.locator(".convitem")).to_have_count(2)


def verify_question_refresh(page):
    questions = lambda r: "/api/kb/questions?" in r.url
    seen = []
    page.on("request", lambda r: seen.append(r.url) if questions(r) else None)
    page.clock.install()
    with page.expect_response(questions):
        page.locator(".index-refresh").click()
    expect(page.locator("#empty-cards")).to_have_attribute("aria-busy", "false")
    with page.expect_response(questions):
        page.clock.fast_forward(300_001)
    expect(page.locator("#empty-cards")).to_have_attribute("aria-busy", "false")
    page.evaluate("""() => { Object.defineProperty(document, 'hidden', {configurable:true,value:true});
                            document.dispatchEvent(new Event('visibilitychange')); }""")
    count = len(seen)
    page.clock.fast_forward(600_001)
    assert len(seen) == count
    with page.expect_response(questions):
        page.evaluate("""() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); }""")
    expect(page.locator("#empty-cards")).to_have_attribute("aria-busy", "false")
    card = page.locator("#empty-cards .card").first
    question = card.locator(".q").inner_text()
    page.route("**/api/chat", lambda route: route.fulfill(status=503, json={"error": "isolated-test"}), times=1)
    with page.expect_request(lambda req: req.url.endswith("/api/chat")) as outgoing:
        card.click()
    assert outgoing.value.post_data_json["message"] == question
    expect(page.locator("zh-question-index")).to_have_count(0)
    count = len(seen)
    page.clock.fast_forward(300_001)
    assert len(seen) == count


def exercise(page, base, width, theme):
    narrow = width <= 1180
    suffix = f"{theme}-{width}"
    seed_conversations(page, base)
    expect(page.locator("#pill-model .model-name")).to_have_text("qwen3-8b-zhiheng")
    expect(page.get_by_role("textbox", name="研究提问")).to_be_visible()
    expect(page.locator(".corpus-imprint")).to_contain_text("712 全文片段")
    expect(page.locator(".empty-art")).to_have_attribute("alt", "合取消去图示：由 P 与 Q 可推出 P，也可推出 Q。")
    expect(page.locator("#empty-cards button")).to_have_count(6)
    if width == 1480 and theme == "light":
        first_questions = page.locator("#empty-cards .q").all_text_contents()
        with page.expect_response(lambda r: "/api/kb/questions?turn=1" in r.url) as refreshed:
            page.get_by_role("button", name="刷新", exact=True).click()
        assert refreshed.value.ok
        expect(page.locator("#empty-cards .q").first).not_to_have_text(first_questions[0])
    assert page.locator(".empty-copy").evaluate("node => getComputedStyle(node).animationName === 'none'")
    if width < 761:
        for selector in ("#btn-sidebar", "#pill-model", "#btn-theme", "#runtime-status summary", "#send"):
            box = page.locator(selector).bounding_box()
            assert box["width"] >= 44 and box["height"] >= 44, f"small touch target: {selector}"
        open_sidebar(page)
        for selector in ("#btn-logic", "#btn-workspace", "#btn-settings"):
            box = page.locator(selector).bounding_box()
            assert box["width"] >= 44 and box["height"] >= 44, f"small sidebar touch target: {selector}"
        page.keyboard.press("Escape")
    for selector in ("#btn-logic", "#btn-workspace", "#btn-settings"):
        expect(page.locator("#sidebar " + selector)).to_have_count(1)
    expect(page.locator(".topbar #btn-logic, .topbar #btn-workspace")).to_have_count(0)
    expect(page.locator("#preferences-host zh-preferences")).to_have_count(1)
    expect(page.locator("zh-preferences")).to_be_hidden()
    expect(page.locator("#sidebar select")).to_have_count(0)
    expect(page.locator("zh-preferences .pref-field")).to_have_count(4)
    expect(page.locator("#pref-learning label")).to_have_text(["开启", "关闭"])
    no_overflow(page)
    snapshot(page, "navigation-" + suffix)
    if width == 1480 and theme == "light":
        page.locator('#composer-tools > summary').click()
        page.locator("#choose-skill").click()
        page.locator('[data-use-skill="citation-quality"]').click()
        expect(page.locator("#input")).to_be_focused()
        expect(page.locator("#choose-skill")).to_have_text("citation-quality")
        expect(page.locator("#clear-skill")).to_be_visible()
        page.locator("#clear-skill").click()
        expect(page.locator("#choose-skill")).to_have_text("选择技能")
        expect(page.locator("#clear-skill")).to_be_hidden()
        # A real persisted profile is editable from the learning panel.
        prefs = page.request.get(base + "/api/profile").json()["profile"]
        assert page.request.put(base + "/api/profile", data={"revision": prefs["revision"], "field": "format", "value": "先举例"}).ok
        click_navigation(page, "#btn-learn")
        profile = page.get_by_role("region", name="跨会话画像")
        field = profile.get_by_role("group", name="讲解方式", exact=True)
        expect(field.get_by_role("radio", name="先举例", exact=True)).to_be_checked()
        field.get_by_role("radio", name="先给结论", exact=True).check()
        expect(profile.get_by_role("status")).to_contain_text("已保存")
        profile.get_by_role("button", name="忘记讲解方式").click()
        expect(field).to_have_count(0)
        profile.get_by_label("启用", exact=True).uncheck()
        expect(profile.get_by_label("启用", exact=True)).to_be_enabled()
        assert page.request.get(base + "/api/profile").json()["profile"]["enabled"] is False
        page.keyboard.press("Escape")

    page.locator("#runtime-status summary").click()
    expect(page.locator("#pill-corpus")).to_contain_text("712")
    expect(page.locator("#pill-stack")).to_contain_text("文件")
    expect(page.locator("#pill-vector")).to_contain_text("本地向量")
    no_overflow(page)
    snapshot(page, "status-" + suffix)
    page.keyboard.press("Escape")
    expect(page.locator("#runtime-status")).not_to_have_attribute("open", "")
    expect(page.locator("#runtime-status summary")).to_be_focused()

    for button, closer in (("#pill-model", "关闭模型设置"), ("#btn-workspace", "关闭工作区"), ("#btn-learn", "关闭学习与记忆")):
        click_navigation(page, button)
        expect(page.locator(".modal-mask")).to_be_visible()
        page.get_by_role("button", name=closer, exact=True).click()
        expect(page.locator(".modal-mask")).to_have_count(0)
    if width == 1480 and theme == "light":
        open_settings(page)
        page.locator('[data-settings-theme="dark"]').click()
        expect(page.locator("html")).to_have_attribute("data-theme", "dark")
        page.locator('[data-settings-theme="light"]').click()
        expect(page.locator("html")).to_have_attribute("data-theme", "light")
        page.locator("#settings-model").click()
        expect(page.locator("dialog.app-settings")).to_have_count(0)
        expect(page.locator("#f-base")).to_be_focused()
        page.get_by_role("button", name="关闭模型设置", exact=True).click()
        open_settings(page)
        page.locator("#settings-learning").click()
        expect(page.get_by_role("dialog", name="学习与记忆", exact=True)).to_be_visible()
        expect(page.locator("select")).to_have_count(0)
        expect(page.locator('#mem-target input[value="memory"]')).to_be_checked()
        page.locator("#mem-target label").filter(has=page.locator('input[value="user"]')).click()
        expect(page.locator('#mem-target input[value="user"]')).to_be_checked()
        page.keyboard.press("Escape")
        open_settings(page)
        page.locator("#settings-monitor").click()
        expect(page.get_by_role("dialog", name="运行监控", exact=True)).to_be_visible()
        page.get_by_role("button", name="关闭运行监控", exact=True).click()
    click_navigation(page, "#btn-logic")
    expect(page.get_by_role("tab", selected=True)).to_be_focused()
    expect(page.get_by_role("radio", name="工具核查", exact=False)).to_be_checked()
    page.keyboard.press("Escape")
    expect(page.locator("#btn-sidebar" if narrow else "#btn-logic")).to_be_focused()
    page.locator("#runtime-status summary").click()
    page.locator("#btn-monitor").click()
    page.get_by_role("button", name="关闭运行监控", exact=True).click()
    page.keyboard.press("Escape")

    if narrow:
        page.locator("#btn-sidebar").click()
        expect(page.locator("#sidebar")).to_be_visible()
        expect(page.locator("#sidebar")).to_have_attribute("role", "dialog")
        expect(page.locator("#sidebar")).to_have_attribute("aria-modal", "true")
        expect(page.locator("#btn-sidebar-close")).to_be_focused()
        assert page.locator(".topbar").evaluate("node => node.inert")
        page.keyboard.press("Shift+Tab")
        assert page.evaluate("document.activeElement.closest('#sidebar') !== null")
        page.keyboard.press("Tab")
        expect(page.locator("#btn-sidebar-close")).to_be_focused()
    snapshot(page, "sidebar-" + suffix)
    if width == 320:
        # A long library must not push the settings entry outside the sidebar.
        before = page.locator("#btn-settings").bounding_box()
        page.locator(".sidebar-scroll").evaluate("""node => {
          const probe = document.createElement('div');
          probe.id = 'sidebar-overflow-probe';
          probe.style.height = '2000px';
          node.appendChild(probe);
          node.scrollTop = node.scrollHeight;
        }""")
        after = page.locator("#btn-settings").bounding_box()
        assert abs(before["y"] - after["y"]) <= 1, "settings moved with the library scroll"
        assert after["y"] + after["height"] <= page.viewport_size["height"], "settings escaped the viewport"
        page.locator(".sidebar-scroll").evaluate("node => { node.querySelector('#sidebar-overflow-probe').remove(); node.scrollTop = 0; }")
    open_settings(page)
    panel = page.locator("zh-preferences")
    panel.screenshot(path=str(SHOTS / f"preferences-{suffix}.png"), animations="disabled")
    if width < 761:
        bounds = panel.locator("fieldset label:not(.sr-only)").evaluate_all("labels => labels.map(l => l.getBoundingClientRect().height)")
        assert all(height >= 44 for height in bounds), bounds

    # Arrow keys move native radio selection and keep focus through the save.
    preference(page, "style", "balanced").focus()
    with page.expect_response(preference_response) as pending:
        page.keyboard.press("ArrowRight")
    assert pending.value.ok, pending.value.text()
    expect(preference(page, "style", "detailed")).to_be_checked()
    expect(preference(page, "style", "detailed")).to_be_focused()
    for key, value in (("inference", "active"), ("learning", "off")):
        save_choice(page, key, value)
    discipline = page.locator('#pref-discipline input:not([value=""])').first.input_value()
    save_choice(page, "discipline", discipline)
    with page.expect_response(preference_response) as pending:
        page.locator("#pref-quote").focus()
        page.keyboard.press("Space")
    assert pending.value.ok
    if width == 1480 and theme == "light":
        verify_overlapping_saves(page, base)
    close_settings(page)
    if narrow:
        expect(page.locator("#btn-sidebar")).to_be_focused()
        assert not page.locator(".topbar").evaluate("node => node.inert")
        assert page.locator("#sidebar").evaluate("node => node.inert")
    page.reload(wait_until="networkidle")
    open_settings(page)
    for key, value in (("style", "detailed"), ("inference", "active"), ("learning", "off"), ("discipline", discipline)):
        expect(preference(page, key, value)).to_be_checked()
    expect(page.locator("#pref-quote")).not_to_be_checked()
    page.locator(".preference-help summary").click()
    expect(page.locator("#learning-help")).to_be_visible()
    expect(page.locator("#learning-help")).to_contain_text("费用")
    snapshot(page, "settings-" + suffix)
    close_settings(page)
    open_sidebar(page)

    # Exercise the native file picker and real upload route, not a mocked DOM.
    with page.expect_file_chooser() as picker:
        page.locator("#btn-import").click()
    with page.expect_response(lambda response: response.url.endswith("/api/kb/import")) as imported:
        picker.value.set_files({"name": "推演规范.md", "mimeType": "text/markdown", "buffer": "# 推演规范\n未知不等于否定，结论必须相对于给定前提。".encode()})
    assert imported.value.ok, imported.value.text()
    uploads = page.locator('#kblist details[data-key="mine"]')
    expect(uploads.locator(".kb-name")).to_have_text("推演规范.md")
    catalog = page.locator(".library-catalog")
    expect(catalog).not_to_have_attribute("open", "")
    expect(catalog.locator("details[open]")).to_have_count(0)
    catalog.locator(":scope > summary").click()
    expect(uploads.locator(".kb-open")).to_be_hidden()
    uploads.locator(":scope > summary").click()
    expect(uploads.locator(".kb-open")).to_be_visible()
    builtins = page.locator('#kblist details[data-key="corpus"]')
    assert builtins.locator('details > summary').count() > 1
    builtins.locator(':scope > summary').click()
    expect(builtins.locator('details > summary').first).to_contain_text(".v")
    builtins.locator(':scope > summary').click()
    page.locator("#btn-section").click()
    editor = page.get_by_role("dialog", name="建立学科分区")
    editor.get_by_role("checkbox", name="推演规范.md").check()
    editor.get_by_role("button", name="从所选文件提取名称和摘要").click()
    expect(editor.locator("#section-name")).to_have_value("推演规范")
    assert "未知不等于否定" in editor.locator("#section-summary").input_value()
    editor.locator("#section-name").fill("推演研究")
    with page.expect_response(preference_response) as pending:
        editor.get_by_role("button", name="保存并选用").click()
    assert pending.value.ok
    expect(editor).to_have_count(0)
    chosen = page.request.get(base + "/api/bootstrap").json()["preferences"]["discipline"]
    assert chosen.startswith("kb:")
    open_settings(page)
    expect(preference(page, "discipline", chosen)).to_be_checked()
    close_settings(page)
    open_sidebar(page)
    expect(page.locator("#empty-cards button")).to_have_count(1)
    assert "推演规范.md" not in page.locator("zh-question-index").inner_text()
    expect(page.locator('zh-question-index [title*="推演规范.md"]')).to_have_count(0)
    evidence = page.request.post(base + "/api/search", data={"query": "推演 结论"}).json()["results"]
    assert evidence and all(item["title"] == "推演规范.md" for item in evidence)
    snapshot(page, "uploaded-" + suffix)
    uploads.locator(".kb-open").click()
    expect(page.locator("#reader-head h3")).to_contain_text("推演规范.md")
    expect(page.locator("#reader")).to_have_attribute("aria-hidden", "false")
    if narrow:
        expect(page.locator("#sidebar")).to_have_attribute("aria-hidden", "true")
    page.locator(".reader-close").click()
    if narrow:
        page.locator("#btn-sidebar").click()
    page.locator(".conv-open").first.click()
    if narrow:
        expect(page.locator("#sidebar")).to_have_attribute("aria-hidden", "true")
        page.locator("#btn-sidebar").click()
    page.locator("#btn-new").click()
    if narrow:
        expect(page.locator("#sidebar")).to_have_attribute("aria-hidden", "true")
    page.locator("#btn-theme").click()
    expect(page.locator("html")).to_have_attribute("data-theme", "dark" if theme == "light" else "light")
    no_overflow(page)
    if width == 320:
        verify_dynamic_disciplines(page, narrow)
    if width == 1480 and theme == "light":
        verify_question_refresh(page)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors, external = [], []
    with tempfile.TemporaryDirectory(prefix="zhiheng-toolbar-ui-") as name:
        directory = Path(name).resolve()
        assert directory.is_relative_to(Path(tempfile.gettempdir()).resolve())
        with (SHOTS / "server.log").open("w", encoding="utf-8") as logfile:
            process = subprocess.Popen([shutil.which("node") or "node", "server.mjs"], cwd=ROOT,
                                       env={**helpers.isolated_environment(directory), "LEARNING_ENABLED": "true"}, stdout=logfile, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                base = helpers.wait_server(process, directory)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    try:
                        for width, theme in ((1480, "light"), (1480, "dark"), (1024, "light"), (390, "light"), (390, "dark"), (320, "light")):
                            context = browser.new_context(viewport={"width": width, "height": 960 if width > 1180 else 844}, reduced_motion="reduce")
                            context.add_init_script("localStorage.setItem('lkba.provider.v1', JSON.stringify({baseUrl:location.origin+'/no-model',model:'qwen3-8b-zhiheng',apiKey:'not-a-real-key'}));" + f"localStorage.setItem('csl.theme',{json.dumps(theme)});")
                            def local_only(route):
                                if urlsplit(route.request.url).netloc != urlsplit(base).netloc:
                                    external.append(route.request.url)
                                    route.abort()
                                else:
                                    route.continue_()
                            context.route("**/*", local_only)
                            page = context.new_page()
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            page.goto(base, wait_until="networkidle")
                            expect(page.locator("#input")).to_be_visible()
                            exercise(page, base, width, theme)
                            context.close()
                    finally:
                        browser.close()
            finally:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    assert not errors, errors
    assert not external, external
    print(json.dumps({"ok": True, "viewports": [1480, 1024, 390, 320], "checks": ["light/dark navigation", "status disclosure and all toolbar actions", "sidebar focus/inert/Escape", "native radio keyboard and touch controls", "real preference persistence", "rapid updates and failed-save recovery", "long and untrusted discipline names", "native import picker and real source reader", "conversation switching/new chat", "no horizontal overflow or external requests"], "screenshots": str(SHOTS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
