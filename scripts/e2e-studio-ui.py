"""Real Chromium workbench acceptance with an isolated, deterministic model fixture.
Run: python scripts/e2e-studio-ui.py. Never reads production user/model data.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

DOCUMENT = '# 项目交付说明\n\n## 实施结果\n\n| 能力 | 状态 |\n| --- | --- |\n| 渲染预览 | 已完成 |\n| 文件审批 | 已验证 |\n\n```js\nconst ready = true;\n```\n\n审批后才生成此文件。'


class Model(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        with (tmp / 'fixture-requests.jsonl').open('a', encoding='utf8') as trace:
            trace.write(json.dumps(body, ensure_ascii=False) + '\n')
        last_user = max((i for i, m in enumerate(body['messages']) if m['role'] == 'user' and any(str(m.get('content', '')).startswith(prefix) for prefix in ['生成项目', '后台整理', '独立总结', '记录项目'])), default=0)
        prompt = body['messages'][last_user]['content']
        replies = [m for m in body['messages'][last_user + 1:] if m['role'] == 'tool']
        delta = {'content': '已依据工具结果完成项目任务，产物可在下方打开。'}
        if body.get('tools') and not replies:
            name, args = None, None
            if '后台整理' in prompt:
                name, args = 'start_background_task', {'goal': '独立总结项目工作，直接给出简短结果', 'title': '独立项目总结'}
            elif '生成' in prompt:
                name, args = 'write_file', {'path': 'report.md', 'content': DOCUMENT}
            if name:
                delta = {'tool_calls': [{'index': 0, 'id': 'ui-' + name, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        self.wfile.write(('data: ' + json.dumps({'choices': [{'index': 0, 'delta': delta, 'finish_reason': 'tool_calls' if 'tool_calls' in delta else 'stop'}], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 50, 'prompt_tokens_details': {'cached_tokens': 200}}}) + '\n\ndata: [DONE]\n\n').encode())


root = Path(__file__).resolve().parents[1]
tmp = Path(tempfile.mkdtemp(prefix='zh-studio-ui-'))
shots = root / '.shots'
shots.mkdir(exist_ok=True)
(tmp / 'papers.jsonl').write_text('', encoding='utf8')
env = {k: v for k, v in os.environ.items() if k.upper() in ['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC', 'PATHEXT']}
if (root / '.env').exists():
    for line in (root / '.env').read_text(encoding='utf8').splitlines():
        if '=' in line and not line.strip().startswith('#'):
            env[line.split('=', 1)[0].strip()] = ''
env.update(PORT='0', HOST='127.0.0.1', DATA_DIR=str(tmp), STORE_FILE=str(tmp / 'store.json'), KB_FILE=str(tmp / 'kb.json'), VECTOR_FILE=str(tmp / 'vector.json'), CORPUS_JSONL=str(tmp / 'papers.jsonl'), MYSQL_ENABLED='0', REDIS_ENABLED='0', EMBEDDING_PROVIDER='off', LEARNING_ENABLED='0', INFERENCE_AUDIT='0', AUX_LLM_MAX_CALLS='0', AUTH_SECRET='synthetic-studio-ui', NO_PROXY='127.0.0.1,localhost')
model = ThreadingHTTPServer(('127.0.0.1', 0), Model)
threading.Thread(target=model.serve_forever, daemon=True).start()
log = (tmp / 'server.log').open('w', encoding='utf8')
child = subprocess.Popen(['node', 'server.mjs'], cwd=root, env=env, stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
try:
    deadline = time.monotonic() + 20
    while True:
        try:
            base = 'http://127.0.0.1:' + (tmp / '.server-port').read_text().strip()
            if json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base + '/api/health', timeout=1))['ready']:
                break
        except Exception:
            pass
        if time.monotonic() > deadline:
            raise RuntimeError('isolated server failed to start')
        time.sleep(.03)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1560, 'height': 1040})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base)
        page.wait_for_load_state('networkidle')
        expect(page.locator('.studio-intro')).to_have_count(0, timeout=4000)
        expect(page.locator('.brand-text h1')).to_contain_text('Agent 工作台')
        expect(page.locator('[data-project="default"]')).to_be_visible()
        assert page.locator('.empty-art').evaluate('(image) => image.complete && image.naturalWidth > 0')
        expect(page.locator('.empty-art')).to_have_attribute('src', '/assets/illustrations/research-library.webp')
        expect(page.locator('[data-task-mode="agent"]')).to_have_attribute('aria-pressed','true')
        assert page.locator('zh-question-index').count() == 0, 'knowledge suggestions belong to research mode'
        page.click('[data-task-mode="knowledge"]')
        expect(page.locator('zh-question-index')).to_be_visible()
        page.click('[data-task-mode="agent"]')
        assert not page.locator('dialog[open]').count(), 'startup must not gate the workbench'
        page.wait_for_timeout(500)
        page.screenshot(path=str(shots / 'studio-home-light.png'),animations='disabled')
        page.click('#pill-model')
        page.fill('#f-base', f'http://127.0.0.1:{model.server_port}/v1')
        page.fill('#f-model', 'studio-contract')
        page.fill('#f-key', 'synthetic-key')
        page.click('#btn-save')
        page.wait_for_selector('#f-base', state='detached')
        uid = page.request.get(base + '/api/bootstrap').json()['user']['id']
        output = tmp / 'workspace' / uid / 'report.md'

        # Configure actions must open actual controls, not the monitoring panel.
        page.click('#btn-capabilities')
        page.click('[data-capability="commands"] [data-navigate]')
        expect(page.locator('#runtime-settings')).to_be_visible()
        expect(page.locator('[data-runtime-status]')).to_contain_text('无需修改')
        page.click('[data-runtime="execEnabled"]')
        page.click('[data-runtime="sessionEnabled"]')
        page.fill('[data-runtime-number="contextBudget"]', '32000')
        page.click('[data-runtime-save]')
        expect(page.locator('[data-runtime-status]')).to_contain_text('已保存')
        page.click('[data-runtime-test="commands"]')
        expect(page.locator('[data-runtime-status]')).to_contain_text('Node')
        page.locator('dialog[open] [data-close]').click()
        page.click('#btn-capabilities')
        expect(page.locator('[data-capability="commands"]')).to_have_attribute('data-state','available')
        page.click('[data-capability="latex"] [data-navigate]')
        expect(page.locator('#runtime-math')).to_be_visible()
        expect(page.locator('[data-runtime="execEnabled"]')).to_have_attribute('aria-pressed','true')
        expect(page.locator('[data-runtime-number="contextBudget"]')).to_have_value('32000')
        page.click('[data-runtime-test="latex"]')
        expect(page.locator('[data-runtime-status]')).to_contain_text('请填写')
        page.screenshot(path=str(shots / 'agent-runtime-settings.png'), animations='disabled')
        page.locator('dialog[open] [data-close]').click()

        page.click('#btn-knowledge')
        expect(page.locator('.knowledge-workbench')).to_be_visible()
        page.click('[data-page="conclusions"]')
        expect(page.locator('.knowledge-body')).to_contain_text('候选')
        page.locator('dialog[open] [data-close]').click()
        imported=page.request.post(base+'/api/kb/import',multipart={'file':{'name':'演绎规则.txt','mimeType':'text/plain','buffer':'从 A 且 B 可以推出 A。前提有效性必须单独核对。'.encode('utf8')}})
        assert imported.status == 200
        document_id=imported.json()['results'][0]['doc']['id']
        page.click('#btn-knowledge')
        expect(page.locator('[data-page="conclusions"]')).to_have_attribute('aria-pressed','true')
        page.click('[data-page="documents"]')
        page.click('[data-document="'+document_id+'"]')
        expect(page.locator('[data-task-mode="knowledge"]')).to_have_attribute('aria-pressed','true')
        expect(page.locator('#focused-source-chip')).to_contain_text('仅所选文档')
        page.fill('#input','请在选定文档内解释前提为什么需要独立核对。')
        expect(page.locator('#focused-source-chip')).to_be_visible()
        with page.expect_request('**/api/chat') as focused_request:
            page.click('#send')
        focused_body=focused_request.value.post_data_json
        assert focused_body['mode']=='knowledge' and focused_body['focusDocId']==document_id
        assert focused_body['focusRef']==document_id+'_0'
        page.wait_for_function('document.querySelector("#send").getAttribute("aria-label")==="发送"')
        page.click('#btn-new')

        # Actual model tool call must stop before creating the output.
        page.fill('#input', '生成项目交付 Markdown 文档')
        page.click('#send')
        page.wait_for_selector('.file-change-review')
        expect(page.locator('.file-change-review')).to_contain_text('report.md')
        assert not output.exists()
        page.screenshot(path=str(shots / 'studio-file-approval.png'))
        page.click('.approval-card [data-act="approved"]')
        page.wait_for_selector('.file-card .fc-view')
        assert output.read_text(encoding='utf8') == DOCUMENT
        page.click('.file-card .fc-view')
        page.wait_for_selector('.artifact-prose h1')
        expect(page.locator('.artifact-prose h1')).to_have_text('项目交付说明')
        assert page.locator('.artifact-prose table').count() == 1
        assert page.locator('.artifact-prose pre code').count() == 1
        output.write_text(DOCUMENT + '\n\n刷新预览验证。', encoding='utf8')
        page.click('[data-refresh-preview]')
        expect(page.locator('.artifact-prose')).to_contain_text('刷新预览验证')
        page.click('[data-close-preview]')
        expect(page.locator('.artifact-dock')).to_be_hidden()
        page.click('.file-card .fc-view')
        page.wait_for_selector('.artifact-prose h1')
        page.wait_for_function('document.querySelector(".chat").getBoundingClientRect().right <= document.querySelector(".artifact-dock").getBoundingClientRect().left + 15')
        page.screenshot(path=str(shots / 'studio-chat-preview.png'))
        bounds = page.evaluate('Object.fromEntries([".layout",".chat",".artifact-dock"].map(s=>{const n=document.querySelector(s),r=n.getBoundingClientRect();return[s,{left:r.left,right:r.right,columns:getComputedStyle(n).gridTemplateColumns}]}))')
        assert bounds['.chat']['right'] <= bounds['.artifact-dock']['left'] + 15, 'preview must not cover desktop chat: ' + json.dumps(bounds)

        # Check both sides of the sidebar/reader breakpoints, including the old 1100/1180 gap.
        # A real open artifact must reserve its own width; tablet overlays must leave chat usable.
        page.emulate_media(reduced_motion='reduce')
        for width in [1440, 1181, 1180, 1140, 1101, 1100, 1024, 961, 960, 820, 701, 700, 390]:
            page.set_viewport_size({'width': width, 'height': 1040})
            page.wait_for_function('''() => {
              const r=document.querySelector('.artifact-dock').getBoundingClientRect();
              return r.width>0 && r.left>=0 && r.right<=innerWidth;
            }''')
            geometry = page.evaluate('''() => {
              const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};};
              return {chat:box('.chat'),dock:box('.artifact-dock'),overflow:document.documentElement.scrollWidth>innerWidth};
            }''')
            assert not geometry['overflow'], f'page overflows at {width}px: {geometry}'
            if width > 960:
                gap = geometry['dock']['left'] - geometry['chat']['right']
                assert -15 <= gap <= 16, f'reader width reservation mismatch at {width}px: {geometry}'
                assert geometry['chat']['width'] >= 330, f'chat squeezed at {width}px: {geometry}'
            else:
                assert geometry['chat']['width'] >= width - 2, f'tablet chat must stay full width at {width}px: {geometry}'
            if width == 1140:
                page.screenshot(path=str(shots / 'studio-preview-tablet-split.png'), animations='disabled')
            if width == 820:
                page.screenshot(path=str(shots / 'studio-preview-tablet-overlay.png'), animations='disabled')
        page.set_viewport_size({'width': 1560, 'height': 1040})
        page.emulate_media(reduced_motion='no-preference')
        page.click('[data-mode="source"]')
        expect(page.locator('.artifact-source')).to_contain_text('# 项目交付说明')
        page.click('[data-mode="render"]')
        with page.expect_popup() as opened:
            page.click('[data-open-window]')
        preview = opened.value
        preview.wait_for_selector('.artifact-prose h1')
        assert preview.url.startswith(base + '/preview.html?')
        assert preview.locator('.artifact-dock').evaluate('(node)=>getComputedStyle(node).getPropertyValue("--ui-surface").trim()')
        assert preview.locator('.artifact-dock').evaluate('(node)=>getComputedStyle(node).backgroundColor') != 'rgba(0, 0, 0, 0)'
        preview.close()
        page.keyboard.press('Escape')

        # Actual provider usage, private aggregation and /context entry point.
        page.fill('#input','/context')
        page.click('#send')
        expect(page.locator('#context-insights')).to_be_visible()
        expect(page.locator('[data-insights-status]')).to_contain_text('仅当前用户可见')
        snapshot = page.request.get(base + '/api/context-insights').json()
        assert snapshot['totals']['reportedRequests'] >= 2
        assert snapshot['totals']['input'] == snapshot['totals']['reportedRequests'] * 1000
        assert snapshot['totals']['output'] == snapshot['totals']['reportedRequests'] * 50
        assert snapshot['totals']['cachedInput'] == snapshot['totals']['reportedRequests'] * 200
        assert snapshot['latest']['parts']['tools'] > 0
        assert snapshot['latest']['budget'] == 32000
        assert 'synthetic-key' not in json.dumps(snapshot) and DOCUMENT not in json.dumps(snapshot,ensure_ascii=False)
        guest = browser.new_context()
        guest.request.get(base + '/api/bootstrap')
        assert guest.request.get(base + '/api/context-insights').json()['totals']['reportedRequests'] == 0
        conversation = snapshot['latest']['conversationId']
        assert guest.request.get(base + '/api/context-insights?conversationId=' + conversation).status == 404
        assert guest.request.get(base + '/api/runtime-settings').json()['execEnabled'] is False
        guest.close()
        page.screenshot(path=str(shots / 'agent-context-insights.png'), animations='disabled')
        page.click('[data-settings-jump="settings-teams-slot"]')
        expect(page.locator('#agent-teams-settings')).to_be_visible()
        page.screenshot(path=str(shots / 'agent-team-settings.png'), animations='disabled')
        page.locator('dialog[open] [data-close]').click()
        expect(page.locator('.artifact-dock')).to_be_hidden()
        page.reload()
        page.wait_for_selector('.file-card .fc-view')
        assert page.locator('.studio-intro').count() == 0
        page.click('.file-card .fc-view')
        page.wait_for_selector('.artifact-prose h1')
        page.keyboard.press('Escape')

        # Model selects a background task without the manual background button.
        page.fill('#input', '后台整理一个独立项目总结')
        page.click('#send')
        page.wait_for_selector('.background-task-card')
        page.locator('.background-task-card button').first.click()
        page.wait_for_selector('.activity-card .state-completed')
        page.locator('dialog[open] [data-close]').click()

        # Project registration uses the actual backend helper; only the OS picker is injected.
        folder = Path(tempfile.mkdtemp(prefix='zh-studio-project-'))
        script = "import {selectWorkspace} from './src/server/workspace-selection.mjs'; console.log(JSON.stringify(await selectWorkspace(process.argv[1], 'choose', {picker:async()=>process.argv[2]})));"
        selected = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script, uid, str(folder)], cwd=root, env=env, text=True, encoding='utf8'))
        project_id = selected['workspace']['id']
        page.reload()
        page.wait_for_selector(f'[data-project="{project_id}"].is-current')
        assert page.locator('[data-project="default"] .project-children').is_hidden()
        page.fill('#input', '记录项目设计任务')
        page.click('#send')
        page.wait_for_selector(f'[data-project="{project_id}"] [data-project-chat]')
        page.wait_for_function('!document.querySelector("#send").classList.contains("stop")')
        page.click('[data-project-select="default"]')
        page.wait_for_selector('[data-project="default"].is-current')
        page.locator('[data-project="default"] [data-project-chat="'+conversation+'"]').click()
        page.wait_for_selector('.file-card .fc-view')

        page.click('#file-permission-trigger')
        page.click('[data-permission-mode="read_only"]')
        expect(page.locator('[data-permission-mode="read_only"]')).to_have_attribute('aria-pressed', 'true')
        page.locator('dialog[open] [data-close]').click()
        page.click('#btn-settings')
        expect(page.locator('[data-permission-mode="read_only"]')).to_have_attribute('aria-pressed', 'true')
        page.click('#settings-intro-replay')
        page.wait_for_selector('.studio-intro')
        page.keyboard.press('Escape')
        expect(page.locator('.studio-intro')).to_have_count(0)
        page.click('#btn-settings')
        page.click('[data-settings-theme="dark"]')
        page.screenshot(path=str(shots / 'studio-settings-dark.png'), animations='disabled')
        contrast = page.locator('.file-permission-option').evaluate_all('''cards => {
          const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});canvas.width=canvas.height=1;
          const rgba=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];};
          const lum=rgb=>rgb.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
          return cards.flatMap(card=>[...card.querySelectorAll('strong,small')].map(node=>{
            const bg=rgba(getComputedStyle(card).backgroundColor),fg=rgba(getComputedStyle(node).color);
            let opacity=fg[3]/255;for(let n=node;n!==card;n=n.parentElement)opacity*=Number(getComputedStyle(n).opacity);
            const visible=fg.map((v,i)=>i<3?v*opacity+bg[i]*(1-opacity):255),l1=lum(visible),l2=lum(bg);
            return {text:node.textContent,ratio:(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)};
          }));
        }''')
        assert all(item['ratio'] >= 4.5 for item in contrast), 'dark file permissions must be readable: ' + json.dumps(contrast, ensure_ascii=False)
        page.locator('dialog[open] [data-close]').click()
        page.emulate_media(reduced_motion='reduce')
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('.file-card .fc-view').first.click()
        page.wait_for_selector('.artifact-prose h1')
        page.screenshot(path=str(shots / 'studio-preview-mobile.png'))
        assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')
        assert page.locator('.artifact-dock').evaluate('(node) => {const r=node.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;}')
        assert page.locator('select:visible').count() == 0
        assert not errors, errors
        browser.close()
    print(json.dumps({'pageErrors': errors, 'checks': ['restored book and agent/knowledge modes', 'runtime configure/save/test', 'actual usage/privacy/owner isolation', 'team settings mount', 'preview X/refresh clicks', 'review before write', 'render/source/new window', '13 responsive preview widths', 'history preview', 'model selected background task', 'project conversation ownership', 'project permissions persisted', 'dark permission text contrast', 'dark and reduced-motion mobile'], 'temporaryData': str(tmp)}, ensure_ascii=False))
finally:
    child.terminate()
    child.wait(timeout=10)
    log.close()
    model.shutdown()
    model.server_close()
