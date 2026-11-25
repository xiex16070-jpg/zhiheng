"""Isolated browser acceptance: real settings API/storage, synthetic search upstream.
Run: python scripts/ui-web-search-settings-smoke.py
No production credentials are read or written; screenshots contain empty key fields.
"""
import importlib.util
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / '.shots' / 'web-search-settings'
spec = importlib.util.spec_from_file_location('ui_helpers', ROOT / 'scripts' / 'ui-logic-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
KEY = 'tvly-fixture-valid-browser-key'
INVALID = 'tvly-fixture-invalid-browser-key'


def snapshot(page, name):
    page.evaluate("""async () => {
      await document.fonts.ready;
      await Promise.allSettled(document.getAnimations().filter(a =>
        a.effect?.getComputedTiming().iterations !== Infinity).map(a => a.finished));
    }""")
    page.screenshot(path=str(SHOTS / f'{name}.png'), full_page=True)


def open_settings(page):
    if not page.locator('#btn-settings').is_visible():
        page.locator('#btn-sidebar').click()
    page.locator('#btn-settings').click()
    expect(page.locator('.search-settings-fields')).to_be_enabled()
    page.locator('#settings-search').click()
    expect(page.locator('#web-search-key')).to_be_focused()


def save(page):
    with page.expect_response(lambda r: r.url.endswith('/api/settings/web-search') and r.request.method == 'POST') as response:
        page.locator('#web-search-save').click()
    assert response.value.ok
    assert KEY not in response.value.text()
    expect(page.locator('#web-search-feedback')).to_contain_text('配置已保存')
    expect(page.locator('.search-settings-fields')).to_be_enabled()


def exercise(page, base, width, theme):
    page.goto(base)
    page.wait_for_load_state('networkidle')
    open_settings(page)
    expect(page.locator('#web-search-save')).to_be_disabled()
    expect(page.locator('#web-search-key')).to_have_attribute('type', 'password')
    expect(page.locator('[name=search-provider][value=tavily]')).to_be_checked()
    page.locator('#web-search-key').fill(KEY)
    page.locator('#web-search-reveal').click()
    expect(page.locator('#web-search-key')).to_have_attribute('type', 'text')
    page.locator('#web-search-reveal').click()
    expect(page.locator('#web-search-key')).to_have_attribute('type', 'password')
    page.locator('#web-search-test').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('连接成功')
    expect(page.locator('#web-search-feedback')).to_contain_text('新密钥尚未保存')
    assert not page.request.get(base + '/api/settings/web-search').json()['settings']['configured']
    page.locator('#web-search-key').fill(INVALID)
    page.locator('#web-search-test').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('服务未接受')
    assert INVALID not in page.locator('#web-search-feedback').inner_text()
    page.locator('#web-search-key').fill(KEY)
    save(page)
    expect(page.locator('#web-search-key')).to_have_value('')
    expect(page.locator('#web-search-key-state')).to_contain_text('已保存')
    expect(page.locator('#joint-availability')).to_contain_text('网站搜索已配置')
    page.locator('#web-search-test').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('连接成功')
    expect(page.locator('#web-search-feedback')).not_to_contain_text('尚未保存')
    # Updating toggles with an empty key preserves the saved credential.
    page.locator('#web-search-enabled').uncheck()
    save(page)
    expect(page.locator('#joint-availability')).to_contain_text('网站搜索未配置')
    page.locator('#web-search-enabled').check()
    save(page)
    page.locator('#web-search-fetch').uncheck()
    save(page)
    expect(page.locator('#joint-availability')).to_contain_text('网站搜索未配置')
    page.locator('#web-search-fetch').check()
    save(page)
    expect(page.locator('#joint-availability')).to_contain_text('网站搜索已配置')
    page.locator('[name=search-provider][value=serper]').check()
    expect(page.locator('#web-search-test')).to_be_disabled()
    page.locator('[name=search-provider][value=tavily]').check()
    expect(page.locator('#web-search-test')).to_be_enabled()
    # A failed save keeps the old server config and the unsaved draft.
    page.route('**/api/settings/web-search', lambda route: route.fulfill(status=500, content_type='application/json', body='{"error":"fixture_failure","message":"配置未能保存，请重试。"}') if route.request.method == 'POST' else route.continue_())
    page.locator('#web-search-key').fill('tvly-fixture-unsaved-alternate-key')
    page.locator('#web-search-save').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('未能保存')
    expect(page.locator('#web-search-key')).to_have_value('tvly-fixture-unsaved-alternate-key')
    page.unroute('**/api/settings/web-search')
    page.locator('#app-settings-close').click()
    expect(page.locator('#web-search-key')).to_have_count(0)
    page.reload()
    page.wait_for_load_state('networkidle')
    open_settings(page)
    expect(page.locator('#web-search-key')).to_have_value('')
    expect(page.locator('#web-search-badge')).to_have_text('已启用')
    page.locator('#web-search-test').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('连接成功')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    for selector in ['.configuration-panel', '#web-search-settings']:
        assert page.locator(selector).evaluate('e => e.scrollWidth <= e.clientWidth + 1'), selector
    if width < 761:
        for selector in ['#web-search-save', '#web-search-test', '#web-search-reveal']:
            box = page.locator(selector).bounding_box()
            assert box['width'] >= 44 and box['height'] >= 44, (selector, box)
    if page.locator('#app-settings-close').bounding_box()['y'] < 0:
        snapshot(page, f'header-problem-{theme}-{width}')
        print(page.evaluate("Object.fromEntries(['dialog.app-settings','.configuration-panel','.configuration-body','#app-settings-close'].map(s=>{const e=document.querySelector(s);return [s,{y:e.getBoundingClientRect().y,height:e.getBoundingClientRect().height,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,overflow:getComputedStyle(e).overflow}]}))"))
        raise AssertionError('settings header left the viewport')
    expect(page.locator('select')).to_have_count(0)
    snapshot(page, f'settings-{theme}-{width}')
    if width == 1480 and theme == 'light':
        page.locator('#web-search-settings').screenshot(path=str(SHOTS / 'search-card.png'), animations='disabled')
    browser_storage = page.evaluate('JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])')
    assert KEY not in browser_storage and INVALID not in browser_storage
    page.locator('#web-search-remove').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('密钥已移除')
    expect(page.locator('#web-search-test')).to_be_disabled()
    expect(page.locator('#joint-availability')).to_contain_text('网站搜索未配置')
    assert not page.request.get(base + '/api/settings/web-search').json()['settings']['configured']


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='zh-ui-web-settings-') as raw:
        directory = Path(raw)
        environment = helpers.isolated_environment(directory)
        environment.update({'WEB_FETCH_ENABLED': 'true', 'JOINT_FIXTURE_LOG': str(directory / 'requests.jsonl')})
        process = None
        with (SHOTS / 'server.log').open('w', encoding='utf-8') as output:
            try:
                process = subprocess.Popen([shutil.which('node') or 'node', '--import', './scripts/fixtures/joint-research-network.mjs', 'server.mjs'], cwd=ROOT,
                    env=environment, stdout=output, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                base = helpers.wait_server(process, directory)
                provider = {'baseUrl': 'http://127.0.0.1:' + (directory / '.joint-model-port').read_text().strip() + '/v1', 'model': 'UI acceptance only', 'apiKey': 'test'}
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        for width, theme in [(1480, 'light'), (1480, 'dark'), (390, 'light'), (390, 'dark'), (320, 'light')]:
                            context = browser.new_context(viewport={'width': width, 'height': 980 if width > 760 else 844}, reduced_motion='reduce' if width == 320 else 'no-preference')
                            context.add_init_script("localStorage.setItem('lkba.provider.v1', " + json.dumps(json.dumps(provider)) + ");localStorage.setItem('csl.theme'," + json.dumps(theme) + ');')
                            page = context.new_page()
                            errors = []
                            page.on('pageerror', lambda error: errors.append(str(error)))
                            exercise(page, base, width, theme)
                            assert not errors, errors
                            context.close()
                    finally:
                        browser.close()
                for filename in ['store.json', 'requests.jsonl', '.web-search.json']:
                    contents = (directory / filename).read_text(encoding='utf-8')
                    assert KEY not in contents and INVALID not in contents, filename
            finally:
                if process and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
    print('PASS: 5 viewport/theme combinations; real save/test/delete API; masked keys; draft isolation; failed-save recovery; persisted reload; live capability updates; no credentials in storage/responses/logs; keyboard/touch layout.')


if __name__ == '__main__':
    main()
