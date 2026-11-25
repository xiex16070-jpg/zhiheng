"""Exercise the visible radio choices through the real isolated application."""
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
SHOTS = ROOT / ".shots/choices"
suite.SHOTS = SHOTS


def open_sidebar_action(page, selector):
    control = page.locator(selector)
    if not control.is_visible():
        page.locator("#btn-sidebar").click()
    control.click()


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors = []
    with tempfile.TemporaryDirectory(prefix="zh-choices-") as name:
        directory = Path(name).resolve()
        env = {**suite.isolated_environment(directory), "LEARNING_ENABLED": "true"}
        with (SHOTS / "server.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen([shutil.which("node"), "server.mjs"], cwd=ROOT, env=env,
                                       stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                base = suite.wait_server(process, directory)
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    try:
                        for mobile in (False, True):
                            context = browser.new_context(viewport={"width": 390, "height": 844} if mobile
                                                          else {"width": 1480, "height": 1050},
                                                          reduced_motion="reduce")
                            context.add_init_script("""localStorage.setItem('lkba.provider.v1', JSON.stringify({
                              baseUrl:location.origin+'/no-model',model:'UI choice fixture',apiKey:'not-a-real-key'}));""")
                            page = context.new_page()
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            page.goto(base)
                            page.wait_for_load_state("networkidle")
                            for field, value in (("language", "中文"), ("format", "先举例"), ("depth", "详细解释"), ("topic", "形式逻辑")):
                                profile = page.request.get(base + "/api/profile").json()["profile"]
                                response = page.request.put(base + "/api/profile",
                                                            data={"revision": profile["revision"], "field": field, "value": value})
                                assert response.ok, response.text()
                            open_sidebar_action(page, "#btn-learn")
                            expect(page.locator('#mem-target input[value="memory"]')).to_be_checked()
                            expect(page.locator('select')).to_have_count(0)
                            english = page.locator('.profile-choices input[data-field="language"][value="英文"]')
                            with page.expect_response(lambda r: r.url.endswith("/api/profile") and r.request.method == "PUT") as saved:
                                english.check()
                            assert saved.value.ok, saved.value.text()
                            expect(english).to_be_checked()
                            expect(english).to_be_focused()
                            with page.expect_response(lambda r: r.url.endswith("/api/profile") and r.request.method == "PUT") as saved:
                                english.press("ArrowRight")
                            assert saved.value.ok, saved.value.text()
                            bilingual = page.locator('.profile-choices input[data-field="language"][value="中英双语"]')
                            expect(bilingual).to_be_checked()
                            expect(bilingual).to_be_focused()
                            assert page.request.get(base + "/api/profile").json()["profile"]["entries"]["language"]["value"] == "中英双语"
                            suite.snapshot(page, "profile-choices-" + ("mobile" if mobile else "desktop"))
                            page.locator('#mem-target input[value="user"]').check()
                            note = "控件验收记录偏好简洁的说明。"
                            page.locator("#mem-text").fill(note)
                            with page.expect_response(lambda r: r.url.endswith("/api/memory") and r.request.method == "POST") as saved:
                                page.locator("#mem-add-btn").click()
                            assert saved.value.ok and saved.value.json()["ok"], saved.value.text()
                            assert note in page.request.get(base + "/api/memory").json()["user"]["entries"]
                            expect(page.locator('#mem-target input[value="user"]')).to_be_checked()
                            expect(page.locator('select')).to_have_count(0)
                            suite.no_overflow(page)
                            suite.snapshot(page, "memory-choices-" + ("mobile" if mobile else "desktop"))
                            page.keyboard.press("Escape")
                            open_sidebar_action(page, "#btn-logic")
                            page.get_by_role("tab", name="规则验算").click()
                            expect(page.locator(".logic-workbench textarea, .logic-workbench select")).to_have_count(0)
                            assert page.locator(".logic-example-source").get_attribute("open") is None
                            for index, statuses in enumerate((["true", "unknown"], ["true", "unknown"],
                                                              ["both", "false", "unknown"], ["true", "unknown"], ["true"])):
                                page.locator(f'#logic-sample input[value="{index}"]').check()
                                for algorithm in ("naive", "semi-naive", "magic-sets"):
                                    page.locator(f'.logic-algorithms input[value="{algorithm}"]').check()
                                    with page.expect_response(lambda r: r.url.endswith("/api/logic/evaluate")) as evaluation:
                                        page.locator("#logic-run").click()
                                    result = evaluation.value.json()
                                    assert [query["status"] for query in result["queries"]] == statuses
                                    assert result["algorithm"] == algorithm
                                    assert evaluation.value.request.post_data_json["program"] == page.locator("#logic-sample-source").text_content()
                            suite.no_overflow(page)
                            suite.snapshot(page, "sample-choices-" + ("mobile" if mobile else "desktop"))
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
    print(json.dumps({"ok": True, "checks": ["memory destination saves to the selected store", "profile radio save and keyboard focus",
                                            "five fixed examples and actual program body", "no native select or workbench text editor",
                                            "desktop/mobile layout"], "screenshots": str(SHOTS)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
