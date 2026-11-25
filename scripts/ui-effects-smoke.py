"""Exercise real local animation bundles, their fallbacks, and idle cleanup."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("logic_ui", ROOT / "scripts/ui-logic-smoke.py")
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
SHOTS = ROOT / ".shots/effects"
suite.SHOTS = SHOTS


def open_navigation(page, selector):
    if not page.locator(selector).is_visible():
        page.locator("#btn-sidebar").click()
    page.locator(selector).click()


def verify_question_source_request(page):
    # Keep the measured question order and source binding returned by the real API.
    page.reload(wait_until='networkidle')
    with page.expect_response(lambda response: "/api/kb/questions?" in response.url) as loaded:
        page.locator('[data-task-mode=knowledge]').click()
    assert loaded.value.ok
    question = loaded.value.json()["questions"][0]
    card = page.locator('zh-question-index .card').first
    expect(card.locator('.q')).not_to_be_empty()
    displayed_question = card.locator('.q').inner_text()
    response = "data: " + json.dumps({"type": "done", "result": {
        "body": "本次只验证提问来源绑定。", "citations": [], "unverified": [], "noEvidence": True,
    }}, ensure_ascii=False) + "\n\n"
    page.route("**/api/chat", lambda route: route.fulfill(
        status=200, content_type="text/event-stream; charset=utf-8", body=response), times=1)
    with page.expect_request(lambda request: request.url.endswith("/api/chat")) as sent:
        card.click()
    body = sent.value.post_data_json
    assert body["focusRef"] == question["ref"]
    assert body["message"] == displayed_question
    assert body['mode'] == 'knowledge'
    expect(page.locator(".msg.user").last).to_have_text(displayed_question)


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors, evidence = [], []
    with tempfile.TemporaryDirectory(prefix="zh-effects-") as name:
        directory = Path(name).resolve()
        with (SHOTS / "server.log").open("w", encoding="utf-8") as log:
            env = {**suite.isolated_environment(directory), "LEARNING_ENABLED": "true"}
            process = subprocess.Popen([shutil.which("node"), "server.mjs"], cwd=ROOT,
                                       env=env, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                base = suite.wait_server(process, directory)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        for mode in ("desktop", "mobile", "reduced", "offline"):
                            context = browser.new_context(viewport={"width": 390, "height": 844} if mode == "mobile"
                                                          else {"width": 1480, "height": 1050},
                                                          reduced_motion="reduce" if mode == "reduced" else "no-preference")
                            page = context.new_page()
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            requests = []
                            page.on("request", lambda request: requests.append(request.url))
                            page.add_init_script("""(() => {
                              sessionStorage.setItem('zh.intro.played','1');
                              localStorage.setItem('lkba.provider.v1', JSON.stringify({baseUrl:location.origin+'/no-model',model:'UI effects fixture',apiKey:'not-a-real-key'}));
                              const raf = requestAnimationFrame.bind(window);
                              window.effectFrames = 0;
                              window.requestAnimationFrame = callback => raf(time => { window.effectFrames++; callback(time); });
                            })();""")
                            if mode == "offline":
                                page.route("**/assets/vendor/*.js", lambda route: route.abort())
                            page.goto(base)
                            page.wait_for_load_state("networkidle")
                            expect(page.locator(".empty")).to_be_visible()
                            suite.no_overflow(page)
                            if mode == "desktop":
                                page.locator('#composer-tools > summary').click()
                                page.locator("#choose-skill").click()
                                page.locator('[data-use-skill="quote-verification"]').click()
                                expect(page.locator("#choose-skill")).to_have_text("quote-verification")
                                page.locator("#clear-skill").click()
                                expect(page.locator("#choose-skill")).to_have_text("选择技能")
                            assert not any("/vendor/workbench.js" in url for url in requests), "GSAP loaded before opening workbench"
                            if mode in ("desktop", "mobile"):
                                suite.snapshot(page, "buttons-home-" + mode)
                            open_navigation(page, "#btn-logic")
                            expect(page.locator(".logic-workbench")).to_be_visible()
                            if mode in ("desktop", "mobile"):
                                page.evaluate("async () => { window.effectsEngine = await import('/assets/vendor/workbench.js'); }")
                                page.wait_for_function("document.querySelector('.logic-masthead > div').style.transform.length > 0")
                                page.locator(".logic-workbench").evaluate("node => node.scrollTo(0, node.scrollHeight)")
                                page.get_by_role("radio", name="逐步追检", exact=False).locator("xpath=..").click()
                                page.get_by_role("tab", name="规则验算").click()
                                expect(page.locator("#logic-sample")).to_be_visible()
                                samples = page.locator('#logic-sample input[type="radio"]')
                                expect(samples).to_have_count(5)
                                samples.nth(2).locator("xpath=..").click()
                                expect(samples.nth(2)).to_be_checked()
                                preview = page.locator(".logic-example-source")
                                expect(preview).not_to_have_attribute("open", "")
                                preview.locator("summary").click()
                                expect(preview.locator("code")).to_be_visible()
                                expect(preview.locator("code")).to_contain_text("非 安全")
                                preview.locator("summary").click()
                                page.get_by_role("tab", name="文献推理").click()
                                page.locator(".logic-workbench").evaluate("node => node.scrollTo(0, 0)")
                                page.wait_for_timeout(700)
                            elif mode == "reduced":
                                assert not any('/vendor/' in url and url.split('?')[0].endswith('.js') for url in requests), "Reduced motion fetched an animation library"
                            expect(page.locator("select")).to_have_count(0)
                            if mode in ("reduced", "offline"):
                                page.get_by_role("tab", name="规则验算").click()
                                page.locator("#logic-run").click()
                                expect(page.locator("#logic-status")).to_contain_text("推演完成")
                            suite.snapshot(page, "effects-" + mode)
                            if mode == "desktop":
                                page.emulate_media(reduced_motion="reduce")
                                page.wait_for_timeout(100)
                                assert not page.locator(".logic-masthead > div").evaluate("node => node.style.transform")
                                assert page.evaluate("effectsEngine.ScrollTrigger.getAll().length") == 0
                            page.keyboard.press("Escape")
                            expect(page.locator(".logic-workbench")).to_have_count(0)
                            suite.no_overflow(page)
                            page.wait_for_timeout(1700)
                            before = page.evaluate("window.effectFrames")
                            page.wait_for_timeout(350)
                            frames = page.evaluate("window.effectFrames") - before
                            assert frames <= 1, f"{mode} left an idle frame loop: {frames}"
                            if mode in ("desktop", "mobile"):
                                assert page.evaluate("effectsEngine.ScrollTrigger.getAll().length") == 0
                            evidence.append({"mode": mode, "idleFrames": frames,
                                             "motionLoaded": any("/vendor/motion-mini.js" in url for url in requests),
                                             "gsapRequested": any("/vendor/workbench.js" in url for url in requests)})
                            if mode == "desktop":
                                verify_question_source_request(page)
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
    print(json.dumps({"ok": True, "checks": evidence, "screenshots": str(SHOTS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
