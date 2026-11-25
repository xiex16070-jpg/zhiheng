"""Real app + HTTP/SSE + persisted preferences, with explicitly synthetic upstreams.
Run: python scripts/ui-joint-research-smoke.py
Every write uses a temporary DATA_DIR; no user's documents or preferences change.
"""
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / ".shots" / "joint-research"
spec = importlib.util.spec_from_file_location("helpers", ROOT / "scripts" / "ui-logic-smoke.py")
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def snapshot(page, name):
    page.evaluate("""async () => {
      await document.fonts.ready;
      await Promise.allSettled(document.getAnimations().filter(a =>
        a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished));
    }""")
    page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def check_width(page):
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
    for selector in [".configuration-panel", ".joint-card", ".composer", ".joint-result"]:
        for element in page.locator(selector).all():
            assert element.evaluate("e => e.scrollWidth <= e.clientWidth + 1"), selector


def saved(page, action):
    with page.expect_response(lambda r: r.url.endswith('/api/preferences') and r.request.method == 'POST') as response:
        action()
    assert response.value.ok
    expect(page.locator('#joint-save-status')).to_contain_text('已保存')


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='zh-ui-joint-') as raw:
        directory = Path(raw)
        environment = helpers.isolated_environment(directory)
        environment.update({"SCHOLAR_SEARCH": "true", "OPENALEX_API_KEY": "", "JOINT_FIXTURE_LOG": str(directory / 'requests.jsonl')})
        process = None
        with (SHOTS / 'server.log').open('w', encoding='utf-8') as output:
            try:
                process = subprocess.Popen([shutil.which('node') or 'node', '--import', './scripts/fixtures/joint-research-network.mjs', 'server.mjs'], cwd=ROOT,
                    env=environment, stdout=output, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                base = helpers.wait_server(process, directory)
                port = (directory / '.joint-model-port').read_text().strip()
                provider = {'baseUrl': f'http://127.0.0.1:{port}/v1', 'model': 'joint-contract', 'apiKey': 'test'}
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        for width, theme in [(1480, 'light'), (1480, 'dark'), (390, 'light'), (390, 'dark'), (320, 'light')]:
                            context = browser.new_context(viewport={'width': width, 'height': 980 if width > 760 else 844}, reduced_motion='reduce' if width == 320 else 'no-preference')
                            context.add_init_script("localStorage.setItem('lkba.provider.v1', " + json.dumps(json.dumps(provider)) + ");localStorage.setItem('csl.theme'," + json.dumps(theme) + ");")
                            page = context.new_page()
                            errors = []
                            page.on('pageerror', lambda error: errors.append(str(error)))
                            page.goto(base)
                            page.wait_for_load_state('networkidle')
                            trigger = page.locator('#joint-research-trigger')
                            expect(trigger).to_be_visible()
                            expect(trigger).to_have_attribute('data-enabled', 'false')
                            trigger.click()
                            expect(page.locator('dialog.app-settings')).to_be_visible()
                            expect(page.locator('#joint-enabled')).to_be_focused()
                            expect(page.locator('#joint-weight')).to_be_disabled()
                            saved(page, lambda: page.locator('#joint-enabled').check())
                            expect(page.locator('#joint-weight')).to_be_enabled()
                            saved(page, lambda: page.locator('[data-joint-weight="50"]').click())
                            expect(page.locator('#joint-weight')).to_have_value('50')
                            page.locator('#joint-weight').focus()
                            saved(page, lambda: page.locator('#joint-weight').press('ArrowRight'))
                            expect(page.locator('#joint-weight')).to_have_attribute('aria-valuetext', '本地 60%，外部 40%')
                            saved(page, lambda: page.locator('[data-joint-weight="70"]').click())
                            saved(page, lambda: page.locator('[name=authorityFocus][value=academic]').check())
                            saved(page, lambda: page.locator('[name=includePreprints]').uncheck())
                            expect(page.locator('select')).to_have_count(0)
                            check_width(page)
                            page.locator('#joint-settings').scroll_into_view_if_needed()
                            assert page.locator('#app-settings-close').bounding_box()['y'] >= 0
                            snapshot(page, f'settings-{theme}-{width}')
                            page.locator('#app-settings-close').click()
                            expect(trigger).to_be_focused()
                            expect(trigger).to_contain_text('70/30')
                            page.reload()
                            page.wait_for_load_state('networkidle')
                            expect(trigger).to_have_attribute('data-enabled', 'true')
                            page.locator('#input').fill('formal verification')
                            page.locator('#send').click()
                            expect(page.locator('.joint-result')).to_be_visible(timeout=15000)
                            page.locator('.joint-result > summary').click()
                            expect(page.locator('.joint-result-body')).to_contain_text('尚未取得至少两项不同外部研究')
                            expect(page.locator('.ev-authority')).to_have_count(1)
                            card = page.locator('.ev').filter(has=page.locator('.ev-authority'))
                            card.click()
                            expect(page.locator('.reader-authority')).to_be_visible()
                            expect(page.locator('.reader-authority')).to_contain_text('未读取论文全文')
                            expect(page.locator('.reader-authority a')).to_have_attribute('href', 'https://doi.org/10.1234/verification-5')
                            check_width(page)
                            snapshot(page, f'reader-{theme}-{width}')
                            page.locator('.reader-close').click()
                            snapshot(page, f'answer-{theme}-{width}')
                            # Persisted result/citations are rendered after reload too.
                            page.reload()
                            page.wait_for_load_state('networkidle')
                            expect(page.locator('.joint-result')).to_be_visible()
                            expect(page.locator('.ev-authority')).to_have_count(1)
                            assert not errors, errors
                            context.close()
                        # A server rejection must roll back the optimistic choice.
                        context = browser.new_context(viewport={'width': 1480, 'height': 980})
                        context.add_init_script("localStorage.setItem('lkba.provider.v1', " + json.dumps(json.dumps(provider)) + ");")
                        page = context.new_page()
                        page.goto(base)
                        page.wait_for_load_state('networkidle')
                        page.locator('#joint-research-trigger').click()
                        page.route('**/api/preferences', lambda route: route.fulfill(status=500, content_type='application/json', body='{"error":"fixture_failure"}'))
                        page.locator('#joint-enabled').check()
                        expect(page.locator('#joint-save-status')).to_contain_text('未能保存')
                        expect(page.locator('#joint-enabled')).not_to_be_checked()
                        expect(page.locator('#joint-weight')).to_be_disabled()
                        context.close()
                    finally:
                        browser.close()
            finally:
                if process and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
    print('PASS: 5 viewport/theme combinations; real persisted switch/ratios/keyboard/source scope; HTTP/SSE fusion; external citation reader; reload; failed-save rollback; reduced motion; no native selects or overflow.')


if __name__ == '__main__':
    main()
