"""Offline Chromium UI acceptance. Requires Python Playwright and its Chromium.

Starts an isolated Node server and local protocol fixtures, never production data.
Run from the repository root: python scripts/e2e-capability-ui.py
"""
import json
import os
import re
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        if self.path == '/mcp':
            if 'id' not in body:
                self.send_response(202)
                self.end_headers()
                return
            method = body.get('method')
            if method == 'initialize':
                result = {'protocolVersion': body['params']['protocolVersion'], 'capabilities': {'resources': {}}, 'serverInfo': {'name': 'ui-resource-fixture', 'version': '1.0'}}
            elif method == 'resources/list':
                result = {'resources': [{'uri': 'research://proof', 'name': 'Proof', 'mimeType': 'text/plain'}]}
            elif method == 'resources/templates/list':
                result = {'resourceTemplates': []}
            elif method == 'resources/read':
                result = {'contents': [{'uri': 'research://proof', 'text': 'A reproducible proof fixture.'}]}
            else:
                result = {'tools': []}
            self.send_response(200)
            self.send_header('content-type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'jsonrpc': '2.0', 'id': body['id'], 'result': result}).encode())
            return
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': '已整理任务；目前没有足够文献证据。'}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n').encode())


root = Path(__file__).resolve().parents[1]
tmp = Path(tempfile.mkdtemp(prefix='zh-recheck-ui-'))
shots = root / '.shots'
shots.mkdir(exist_ok=True)
(tmp / 'papers.jsonl').write_text('', encoding='utf8')
env = {k: v for k, v in os.environ.items() if k.upper() in ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT']}
if (root / '.env').exists():
    for line in (root / '.env').read_text(encoding='utf8').splitlines():
        if '=' in line and not line.strip().startswith('#'):
            env[line.split('=', 1)[0].strip()] = ''
env.update(PORT='0', HOST='127.0.0.1', DATA_DIR=str(tmp), STORE_FILE=str(tmp / 'store.json'), KB_FILE=str(tmp / 'kb.json'), VECTOR_FILE=str(tmp / 'vector.json'), CORPUS_JSONL=str(tmp / 'papers.jsonl'), MYSQL_ENABLED='0', REDIS_ENABLED='0', EMBEDDING_PROVIDER='off', LEARNING_ENABLED='1', INFERENCE_AUDIT='0', AUX_LLM_MAX_CALLS='0', AUTH_SECRET='synthetic-ui-recheck', NO_PROXY='127.0.0.1,localhost')
fixture = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=fixture.serve_forever, daemon=True).start()
log = (tmp / 'server.log').open('w', encoding='utf8')
start = time.monotonic()
child = subprocess.Popen(['node', 'server.mjs'], cwd=root, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
try:
    while True:
        try:
            base = 'http://127.0.0.1:' + (tmp / '.server-port').read_text().strip()
            if json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base + '/api/health', timeout=1))['ready']:
                break
        except Exception:
            pass
        if time.monotonic() - start > 20:
            raise RuntimeError('isolated server did not become ready')
        time.sleep(.03)
    cold_ms = round((time.monotonic() - start) * 1000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base)
        page.click('#pill-model')
        page.wait_for_selector('#f-base')
        page.fill('#f-base', f'http://127.0.0.1:{fixture.server_port}/v1')
        page.fill('#f-model', 'ui-contract')
        page.fill('#f-key', 'synthetic-ui-key')
        page.click('#btn-save')
        page.wait_for_selector('#f-base', state='detached')
        page.keyboard.press('Control+Shift+k')
        page.wait_for_selector('[data-capability="evidence"]')
        assert page.locator('[data-capability]').count() == 21
        expect(page.locator('[data-capability="image"]')).to_have_attribute('data-state', 'needs_setup')
        expect(page.locator('[data-capability="browser"]')).to_have_attribute('data-state', 'needs_setup')
        page.wait_for_function("document.querySelector('.studio-paths').getAnimations({subtree:true}).every(a => a.playState === 'finished')")
        page.screenshot(path=str(shots / 'recheck-capabilities-light.png'))
        page.fill('[data-capability-search]', 'pdf')
        assert page.locator('[data-capability]').count() >= 2
        page.fill('[data-capability-search]', '不存在的能力')
        expect(page.locator('.capability-empty')).to_be_visible()
        page.fill('[data-capability-search]', '')
        page.click('[data-use="evidence"]')
        expect(page.locator('#input')).to_have_value(re.compile('知识库'))
        assert page.locator('.msg-user').count() == 0, 'draft must not auto-send'

        page.click('#btn-capabilities')
        page.click('[data-capability="mcp"] [data-navigate]')
        page.wait_for_selector('#extensions-settings')
        page.locator('.extension-add summary').click()
        page.fill('#extension-name', '只读资料库')
        page.fill('#extension-url', f'http://127.0.0.1:{fixture.server_port}/mcp')
        page.locator('#extension-form button[type=submit]').click()
        page.wait_for_selector('.extension-item')
        page.locator('.extension-item summary').click()
        expect(page.locator('[data-resources]')).to_be_enabled()
        expect(page.locator('[data-resources]')).not_to_be_checked()
        page.check('.extension-item [data-enabled]')
        page.check('[data-resources]')
        page.click('[data-action="save"]')
        expect(page.locator('.extension-item summary')).to_contain_text('只读资源')
        page.locator('.extension-item summary').click()
        expect(page.locator('[data-resources]')).to_be_checked()
        page.screenshot(path=str(shots / 'recheck-mcp-resources.png'))
        page.locator('dialog[open] [data-close]').click()

        page.fill('#input', '整理后台研究任务')
        page.click('#composer-tools > summary')
        page.click('#background-submit')
        page.wait_for_selector('.activity-card .state-completed')
        target = page.locator('.activity-card [data-open]').first
        target.focus()
        handle = target.element_handle()
        page.wait_for_timeout(4300)
        assert handle.evaluate('(node) => node.isConnected && document.activeElement === node'), 'polling must preserve focused unchanged card'
        def updated_summary(route):
            response = route.fetch()
            body = response.json()
            body['tasks'][0]['summary'] = '新的任务摘要；焦点仍应保留在原操作上。'
            route.fulfill(response=response, json=body)
        page.route('**/api/background', updated_summary)
        expect(page.locator('.activity-card').first).to_contain_text('新的任务摘要', timeout=6000)
        expect(page.locator('.activity-card [data-open]').first).to_be_focused()
        page.unroute('**/api/background', updated_summary)
        assert page.locator('#btn-activity').get_attribute('data-unread') is None
        page.locator('dialog[open] [data-close]').click()

        page.click('#btn-settings')
        page.locator('[data-settings-theme="system"]').click()
        page.emulate_media(color_scheme='dark', reduced_motion='reduce')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        expect(page.locator('[data-settings-theme="system"]')).to_have_attribute('aria-pressed', 'true')
        page.locator('dialog[open] [data-close]').click()
        page.set_viewport_size({'width': 768, 'height': 900})
        page.keyboard.press('Control+Shift+k')
        page.wait_for_selector('[data-capability="evidence"]')
        assert page.locator('.studio-paths path').first.evaluate('(node) => getComputedStyle(node).animationName') == 'none'
        page.screenshot(path=str(shots / 'recheck-capabilities-dark-768.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path=str(shots / 'recheck-capabilities-mobile.png'))
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert page.locator('.capability-workbench').evaluate('(node) => { const r=node.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && node.scrollWidth <= node.clientWidth; }'), 'dialog must fit the mobile viewport'
        assert page.locator('select:visible').count() == 0
        assert errors == [], errors
        browser.close()
    print(json.dumps({'coldStartMs': cold_ms, 'pageErrors': errors, 'checks': ['capability search and draft only', 'MCP resource permission persistence', 'task polling focus retention', 'system theme', 'reduced motion', '1440/768/390 layouts'], 'temporaryData': str(tmp)}, ensure_ascii=False))
finally:
    child.terminate()
    child.wait(timeout=10)
    log.close()
    fixture.shutdown()
    fixture.server_close()
