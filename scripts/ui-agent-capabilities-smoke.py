"""Isolated acceptance for multi-source settings, model vault and MCP management."""
import importlib.util
import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / '.shots' / 'agent-capabilities'
spec = importlib.util.spec_from_file_location('helpers', ROOT / 'scripts' / 'ui-logic-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)

def open_settings(page, tab):
    if not page.locator('#btn-settings').is_visible():
        page.locator('#btn-sidebar').click()
    page.locator('#btn-settings').click()
    expect(page.locator('.search-settings-fields')).to_be_enabled()
    page.locator('#settings-' + tab).click()

def save_search(page):
    page.locator('#web-search-save').click()
    expect(page.locator('#web-search-feedback')).to_contain_text('配置已保存')
    expect(page.locator('.search-settings-fields')).to_be_enabled()
    expect(page.locator('#web-search-key')).to_have_value('')

def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='zh-ui-capabilities-') as raw:
        directory = Path(raw)
        env = helpers.isolated_environment(directory)
        env.update({'WEB_FETCH_ENABLED': 'true', 'JOINT_FIXTURE_LOG': str(directory / 'requests.jsonl')})
        with (SHOTS / 'ui-server.log').open('w', encoding='utf-8') as log:
            process = subprocess.Popen([shutil.which('node'), '--import', './scripts/fixtures/joint-research-network.mjs', 'server.mjs'],
                cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                base = helpers.wait_server(process, directory)
                model_base = 'http://127.0.0.1:' + (directory / '.joint-model-port').read_text().strip() + '/v1'
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        context = browser.new_context(viewport={'width':1480,'height':1000})
                        initial = {'baseUrl': model_base, 'model': 'initial-ui-model', 'apiKey': 'synthetic-initial-model-key', 'preset': 'custom'}
                        context.add_init_script("if(!localStorage.getItem('lkba.provider.v1')) localStorage.setItem('lkba.provider.v1'," + json.dumps(json.dumps(initial)) + ")")
                        page = context.new_page()
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.goto(base); page.wait_for_load_state('networkidle')
                        open_settings(page, 'search')
                        for name, key in [('tavily','tvly-fixture-multi-source-key'),('serper','fixture-serper-multi-key'),('openalex','fixture-openalex-multi-key')]:
                            page.locator('[name=search-provider][value=' + name + ']').check()
                            page.locator('#web-search-key').fill(key)
                            save_search(page)
                        settings = page.request.get(base + '/api/settings/web-search').json()['settings']
                        assert settings['activeProviders'] == ['tavily','serper'], settings
                        assert all(settings['connections'][x]['configured'] for x in ['tavily','serper','openalex'])
                        page.locator('#web-search-test').click()
                        expect(page.locator('#web-search-feedback')).to_contain_text('连接成功')
                        page.locator('[name=search-provider][value=europepmc]').check()
                        expect(page.locator('#web-search-key')).to_be_hidden()
                        page.locator('#web-search-test').click()
                        expect(page.locator('#web-search-feedback')).to_contain_text('连接成功')
                        page.locator('[name=search-provider][value=tavily]').check()
                        expect(page.locator('#web-search-key')).to_have_value('')
                        expect(page.locator('#web-search-key-state')).to_contain_text('已保存')
                        page.locator('#web-search-settings').screenshot(path=str(SHOTS/'multi-source-card.png'))
                        page.locator('#settings-extensions').click()
                        expect(page.locator('#capability-grid')).to_contain_text('Word')
                        page.locator('#extension-browser').click()
                        expect(page.locator('#extension-feedback')).to_contain_text('已保存')
                        expect(page.locator('[data-id=browser]')).to_contain_text('已启用')
                        page.locator('.extension-add > summary').click()
                        page.locator('[name=extension-kind][value=stdio]').check()
                        page.locator('#extension-name').fill('MCP 验证服务')
                        page.locator('#extension-command').fill(shutil.which('node'))
                        page.locator('#extension-args').fill(json.dumps([str(ROOT/'scripts'/'fixtures'/'extension-server.mjs')]))
                        page.locator('#extension-form button[type=submit]').click()
                        expect(page.locator('#extension-feedback')).to_contain_text('已保存', timeout=20000)
                        card = page.locator('.extension-item').filter(has_text='MCP 验证服务')
                        card.locator('summary').click()
                        card.locator('[data-enabled]').check()
                        card.locator('[data-tool=write_note]').check()
                        card.locator('[data-action=save]').click()
                        expect(page.locator('#extension-feedback')).to_contain_text('已保存')
                        expect(page.locator('.extension-item').filter(has_text='MCP 验证服务')).to_contain_text('已启用')
                        page.locator('.extension-add > summary').click()
                        page.locator('#settings-extensions').click()
                        page.screenshot(path=str(SHOTS/'capabilities-desktop.png'), full_page=True)
                        page.locator('#app-settings-close').click()
                        open_settings(page, 'model')
                        expect(page.locator('#btn-save')).to_be_enabled()
                        page.locator('#f-base').fill(model_base)
                        page.locator('#f-model').fill('capability-ui-model')
                        page.locator('#f-key').fill('synthetic-persistent-ui-model-key')
                        page.locator('#btn-save').click()
                        expect(page.locator('#f-key')).to_have_count(0)
                        assert 'synthetic-persistent-ui-model-key' not in page.evaluate('JSON.stringify(Object.entries(localStorage))')
                        context.close()

                        # New browser identity: machine model settings survive; user-owned
                        # extensions remain isolated from this new identity.
                        for width, theme in [(1480,'dark'),(390,'light'),(390,'dark'),(320,'light')]:
                            context = browser.new_context(viewport={'width':width,'height':950 if width>760 else 844}, reduced_motion='reduce')
                            context.add_init_script("localStorage.setItem('csl.theme'," + json.dumps(theme) + ")")
                            page = context.new_page(); page.on('pageerror', lambda error: errors.append(str(error)))
                            page.goto(base); page.wait_for_load_state('networkidle')
                            saved = json.loads(page.evaluate("localStorage.getItem('lkba.provider.v1')"))
                            assert saved['model'] == 'capability-ui-model' and saved['savedKeyId'] and not saved['apiKey'], saved
                            open_settings(page, 'extensions')
                            expect(page.locator('#extension-list')).to_contain_text('尚未启用')
                            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                            assert page.locator('#extensions-settings').evaluate('e=>e.scrollWidth<=e.clientWidth+1')
                            assert page.locator('#app-settings-close').bounding_box()['y'] >= 0
                            page.screenshot(path=str(SHOTS/f'capabilities-{width}-{theme}.png'), full_page=True)
                            page.locator('#settings-search').click()
                            page.locator('[name=search-provider][value=openalex]').check()
                            expect(page.locator('#web-search-key-state')).to_contain_text('已保存')
                            page.screenshot(path=str(SHOTS/f'sources-{width}-{theme}.png'), full_page=True)
                            page.locator('#app-settings-close').click()
                            open_settings(page, 'model')
                            expect(page.locator('#btn-save')).to_be_enabled()
                            expect(page.locator('#f-key')).to_have_value('')
                            expect(page.locator('#f-key')).to_have_attribute('placeholder', '密钥已保存；留空保留，无需重输')
                            page.locator('#btn-save').click()
                            expect(page.locator('#f-key')).to_have_count(0)
                            context.close()
                        assert not errors, errors
                    finally:
                        browser.close()
            finally:
                process.terminate(); process.wait(timeout=15)
    print('PASS: multi-source retention, academic probes, actual MCP discovery/permissions, model restoration in fresh browser, light/dark/mobile layouts.')

if __name__ == '__main__':
    main()
