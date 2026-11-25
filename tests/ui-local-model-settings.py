"""Isolated browser regression: model settings only; no production data or upstream calls."""
import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
HTML = b'''<!doctype html><html><body><script type="module">
import {openSettings} from '/src/ui/settings.js';
window.saved = [];
window.openModelSettings = provider => openSettings({provider, onSave: result => window.saved.push(result)});
</script></body></html>'''


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        if self.path == '/fixture':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(HTML)
        else:
            super().do_GET()

    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    cloud = {'baseUrl': 'https://api.deepseek.com/v1', 'model': 'cloud-selected-model', 'preset': 'deepseek',
             'profileId': '', 'savedKeyId': 'fixture-cloud-credential', 'apiKey': ''}
    adapter = {'baseUrl': 'http://127.0.0.1:8018/v1', 'model': 'qwen3-8b-explicit-adapter', 'preset': 'zhiheng-local',
               'profileId': 'local-qwen', 'profileSha': 'a' * 64, 'adapterSha': 'b' * 64, 'apiKey': ''}
    vault = {'revision': 2, 'profiles': [cloud, adapter], 'active': cloud}
    posts, unexpected, errors = [], [], []
    reject_save = True
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    worker = Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f'http://127.0.0.1:{server.server_port}'
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))

            def route(request_route):
                nonlocal vault
                request = request_route.request
                if request.url == origin + '/api/settings/models':
                    if request.method == 'GET':
                        request_route.fulfill(json=vault)
                    elif request.method == 'POST':
                        body = request.post_data_json
                        posts.append(body)
                        if reject_save:
                            request_route.fulfill(status=409, json={'message': '本地模型协议尚未验证'})
                        else:
                            active = {**body, 'apiKey': '', 'profileSha': 'a' * 64, 'adapterSha': None}
                            vault = {'revision': vault['revision'] + 1, 'profiles': [cloud, active], 'active': active}
                            request_route.fulfill(json=vault)
                    else:
                        unexpected.append(request.url)
                        request_route.abort()
                elif request.url.startswith(origin + '/') and '/api/' not in request.url:
                    request_route.continue_()
                else:
                    unexpected.append(request.url)
                    request_route.abort()

            context.route('**/*', route)
            page.goto(origin + '/fixture')
            page.wait_for_load_state('networkidle')
            page.wait_for_function('typeof window.openModelSettings === "function"')
            page.evaluate('provider => window.openModelSettings(provider)', cloud)
            expect(page.locator('#btn-save')).to_be_enabled()
            expect(page.locator('#f-model')).to_have_value('cloud-selected-model')
            page.get_by_role('button', name='知衡 Qwen 本地', exact=True).click()
            expect(page.locator('#f-model')).to_have_value('qwen3-8b-base')
            expect(page.locator('[name=model-profile][value=local-qwen]')).to_be_checked()
            expect(page.locator('#local-profile-note')).to_be_visible()
            expect(page.locator('#f-key')).to_have_attribute('placeholder', '本地服务可留空')
            assert posts == [] and page.evaluate('window.saved.length') == 0
            assert vault['active']['model'] == 'cloud-selected-model'

            page.get_by_role('button', name='DeepSeek', exact=True).click()
            expect(page.locator('[name=model-profile][value=""]')).to_be_checked()
            expect(page.locator('#f-model')).to_have_value('deepseek-chat')
            expect(page.locator('#local-profile-note')).to_be_hidden()
            page.get_by_role('button', name='知衡 Qwen 本地', exact=True).click()
            page.locator('#f-base').fill('https://remote.example/v1')
            expect(page.locator('#local-profile-note')).to_be_hidden()
            page.locator('#f-base').fill('http://127.0.0.1:8018/v1')
            expect(page.locator('#local-profile-note')).to_be_visible()
            page.locator('[name=model-profile][value=""]').check()
            expect(page.locator('#local-profile-note')).to_be_hidden()
            page.locator('[name=model-profile][value=local-qwen]').check()
            expect(page.locator('#local-profile-note')).to_be_visible()

            page.locator('#btn-save').click()
            expect(page.locator('#status')).to_contain_text('本地模型协议尚未验证')
            assert posts[-1]['model'] == 'qwen3-8b-base' and posts[-1]['profileId'] == 'local-qwen'
            assert page.evaluate('window.saved.length') == 0 and vault['active']['model'] == 'cloud-selected-model'
            page.locator('[data-close]').click()
            expect(page.locator('dialog')).to_have_count(0)
            page.evaluate('provider => window.openModelSettings(provider)', adapter)
            expect(page.locator('#btn-save')).to_be_enabled()
            expect(page.locator('#f-model')).to_have_value('qwen3-8b-explicit-adapter')
            expect(page.locator('[name=model-profile][value=local-qwen]')).to_be_checked()
            page.locator('[data-close]').click()
            expect(page.locator('dialog')).to_have_count(0)
            assert page.evaluate('window.saved.length') == 0 and len(posts) == 1

            reject_save = False
            page.evaluate('provider => window.openModelSettings(provider)', cloud)
            expect(page.locator('#btn-save')).to_be_enabled()
            page.get_by_role('button', name='知衡 Qwen 本地', exact=True).click()
            page.locator('#btn-save').click()
            expect(page.locator('dialog')).to_have_count(0)
            assert page.evaluate('window.saved[0].model') == 'qwen3-8b-base'
            assert page.evaluate('window.saved[0].profileId') == 'local-qwen'
            assert vault['profiles'][0] == cloud
            assert len(posts) == 2 and not unexpected and not errors, (unexpected, errors)
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
    print(json.dumps({'status': 'passed', 'settingsPosts': len(posts), 'upstreamRequests': len(unexpected),
                      'productionSettingsChanged': False, 'realModelCalls': 0}))


if __name__ == '__main__':
    main()
