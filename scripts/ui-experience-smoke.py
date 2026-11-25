"""Isolated product-experience acceptance; no model, production data or external calls.

Uses real application routes/public corpus and explicitly synthetic task/SSE/page
mapping fixtures. Run: python scripts/ui-experience-smoke.py [--recon]
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / '.shots/experience'
spec = importlib.util.spec_from_file_location('experience_helpers', ROOT / 'scripts/ui-settings-navigation-smoke.py')
ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ui)
ui.SHOTS = SHOTS


def sse(route, events):
    route.fulfill(status=200, content_type='text/event-stream', body=''.join(
        'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n' for event in events))


def check(page, base, width, theme):
    def unconfigured(route):
        if route.request.method == 'GET': route.fulfill(json={'profiles':[],'revision':0,'active':None})
        else: route.continue_()
    page.route('**/api/settings/models', unconfigured)
    page.goto(base, wait_until='networkidle')
    # Reconnaissance of current rendered controls before actions.
    assert page.get_by_role('group', name='任务模式').is_visible()
    expect(page.locator('#model-onboarding')).to_be_visible()
    expect(page.locator('#task-context')).to_contain_text('默认工作区')
    accepts = page.locator('#file-input').get_attribute('accept')
    assert all(ext in accepts for ext in ('.xlsx', '.pptx', '.ipynb'))
    page.locator('#input').fill('保留的研究草稿')
    page.locator('[data-starter=research]').click()
    expect(page.locator('[data-task-mode=knowledge]')).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('#input')).to_have_value('保留的研究草稿')
    expect(page.locator('[data-context-scope]')).to_contain_text('全部知识库')
    expect(page.locator('dialog.knowledge-mask[open]')).to_have_count(0)
    page.locator('#composer-tools>summary').click()
    expect(page.locator('#choose-skill')).to_be_visible()
    expect(page.locator('#background-submit')).to_be_visible()
    page.locator('#composer-tools>summary').click()
    page.locator('#input').fill('很长的问题与约束。' * 160)
    assert page.locator('#input').evaluate('n=>n.getBoundingClientRect().height') <= 161
    page.locator('#input').fill('')
    ui.no_overflow(page)
    ui.screenshot(page, f'experience-home-{width}-{theme}')

    ui.open_settings(page, 'judge')
    field = page.locator('#judge-settings input[name=baseUrl]')
    expect(field).to_be_enabled()
    field.fill('not-a-url')
    assert not page.locator('[data-judge-form]').evaluate('n=>n.reportValidity()')
    expect(field).to_have_attribute('aria-invalid', 'true')
    expect(page.locator('#' + field.get_attribute('aria-describedby'))).to_contain_text('有效的地址')
    field.fill('https://example.org/v1')
    expect(field).not_to_have_attribute('aria-invalid', 'true')
    # Programmatic reload must clear owned errors, keeping permanent field hints.
    tokens = page.locator('#judge-settings input[name=maxOutputTokens]')
    tokens.fill('2')
    field.fill('not-a-url')
    assert not page.locator('[data-judge-form]').evaluate('n=>n.reportValidity()')
    expect(tokens).to_have_attribute('aria-invalid', 'true')
    page.locator('[data-judge-refresh]').click()
    expect(field).to_have_value('')
    expect(field).not_to_have_attribute('aria-invalid', 'true')
    expect(tokens).not_to_have_attribute('aria-invalid', 'true')
    expect(tokens).to_have_attribute('aria-describedby', 'judge-token-hint')
    expect(page.locator('#judge-settings .field-error')).to_have_count(0)
    page.locator('#app-settings-close').click()
    ui.open_sidebar_action(page, '#btn-learn')
    tabs = page.locator('[aria-label="学习分类"]')
    active = tabs.locator('[aria-selected=true]')
    active.focus()
    active.press('End')
    expect(tabs.locator('[data-tab=ledger]')).to_be_focused()
    tabs.locator('[data-tab=ledger]').press('Enter')
    expect(tabs.locator('[data-tab=ledger]')).to_have_attribute('tabindex', '0')
    expect(page.locator('#learn-body')).to_have_attribute('aria-labelledby', 'learn-body-tab-ledger')
    tabs.locator('[data-tab=ledger]').press('Home')
    expect(tabs.locator('[data-tab=memory]')).to_be_focused()
    expect(tabs.locator('[data-tab=ledger]')).to_have_attribute('aria-selected','true')
    page.keyboard.press('Tab')
    expect(page.locator('#learn-body')).to_be_focused()
    page.keyboard.press('Shift+Tab')
    expect(tabs.locator('[data-tab=ledger]')).to_be_focused()
    # Late learning responses must not replace the current tab, including A→B→A.
    delayed_effects = []
    def hold_effects(route): delayed_effects.append(route)
    page.route('**/api/learn/effectiveness', hold_effects)
    with page.expect_request('**/api/learn/effectiveness'):
        tabs.locator('[data-tab=effectiveness]').click()
    tabs.locator('[data-tab=ledger]').click()
    expect(page.locator('#rev-run')).to_be_visible()
    with page.expect_response('**/api/learn/effectiveness') as effects_response:
        delayed_effects[0].fulfill(json={'skills':[], 'tasks':0, 'window':10, 'note':'过期技能响应'})
    effects_response.value.body()
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    expect(page.locator('#rev-run')).to_be_visible()
    expect(page.locator('#learn-body')).not_to_contain_text('过期技能响应')
    page.unroute('**/api/learn/effectiveness', hold_effects)
    memory = page.request.get(base + '/api/memory').json()
    delayed_memory, memory_reads = [], []
    def memory_response(route):
        memory_reads.append(1)
        if len(memory_reads) == 1: delayed_memory.append(route)
        else: route.fulfill(json={**memory, 'user':{**memory['user'], 'entries':['本轮最新记忆'], 'chars':6}})
    page.route('**/api/memory', memory_response)
    with page.expect_request('**/api/memory'):
        tabs.locator('[data-tab=memory]').click()
    tabs.locator('[data-tab=ledger]').click()
    tabs.locator('[data-tab=memory]').click()
    expect(page.locator('#learn-body')).to_contain_text('本轮最新记忆')
    with page.expect_response('**/api/memory') as memory_result:
        delayed_memory[0].fulfill(json={**memory, 'user':{**memory['user'], 'entries':['过期记忆'], 'chars':4}})
    memory_result.value.body()
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    expect(page.locator('#learn-body')).to_contain_text('本轮最新记忆')
    expect(page.locator('#learn-body')).not_to_contain_text('过期记忆')
    page.unroute('**/api/memory', memory_response)
    refresh_after_write = []
    def memory_write(route):
        if route.request.method == 'POST': route.fulfill(json={'ok':True})
        else: refresh_after_write.append(route)
    page.route('**/api/memory', memory_write)
    page.locator('#mem-text').fill('合成写入结果用于刷新竞态验证')
    with page.expect_request(lambda request: request.url == base + '/api/memory' and request.method == 'GET'):
        page.locator('#mem-add-btn').click()
    tabs.locator('[data-tab=ledger]').click()
    expect(page.locator('#rev-run')).to_be_visible()
    with page.expect_response('**/api/memory') as post_refresh:
        refresh_after_write[0].fulfill(json=memory)
    post_refresh.value.body()
    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    expect(page.locator('#rev-run')).to_be_visible()
    page.unroute('**/api/memory', memory_write)
    page.locator('dialog[data-workbench=learning] [data-panel-close]').click()

    # Connect only a synthetic provider in the temporary user's vault.
    page.unroute('**/api/settings/models', unconfigured)
    page.evaluate("localStorage.setItem('lkba.provider.v1',JSON.stringify({baseUrl:location.origin+'/no-model',model:'UI fixture',apiKey:'fixture'}))")
    page.reload(wait_until='networkidle')
    expect(page.locator('#model-onboarding')).to_be_hidden()
    conv = page.request.post(base + '/api/conversations', data={}).json()['conversation']['id']
    hit = page.request.post(base + '/api/search', data={'query':'Hoare 逻辑 前置条件','channels':['paper'],'k':1}).json()['results'][0]
    source = page.request.get(base + '/api/source/' + hit['ref']).json()
    sample = {**hit, 'id':hit['ref'], 'start':0, 'end':min(20, len(source['content']))}
    body = '**结论与依据**\n\n| 判断 | 来源 |\n| --- | --- |\n| 待核对 | [[' + hit['ref'] + ']] |\n[推断]（依据[[' + hit['ref'] + ']]；方法:演绎）A | B\n\n[官方资料](https://example.org/)\n\n' + ('需要回源核对的段落。\n\n' * 70)
    result = {'body':body, 'citations':[sample], 'jointResearch':{'enabled':True,'status':'partial','counts':{'local':1,'external':0}},
              'support':[{'sentence':'待核对','verdict':'uncertain'}], 'supportSummary':{'reason':'model_opinion_not_proof'}}
    calls, resumed = [], []
    def chat(route):
        message = route.request.post_data_json['message']
        calls.append(message)
        task_id = 'ux-cancelled' if message == 'cancel' else 'ux-failed' if message == 'fail' else 'ux-complete'
        events = [{'type':'conversation','conversationId':conv,'taskId':task_id}]
        if message == 'cancel':
            # Deliberate premature EOF; GET task is authoritative cancelled.
            sse(route, events)
        elif message == 'fail':
            sse(route, events + [{'type':'error','taskId':task_id,'message':'合成上游故障'}])
        else:
            sse(route, events + [{'type':'done','taskId':task_id,'result':result}])
    page.route('**/api/chat', chat)
    def task(route):
        task_id = urlsplit(route.request.url).path.rsplit('/', 1)[-1]
        route.fulfill(json={'task':{'id':task_id,'conversationId':conv,'question':'合成失败任务','status':'cancelled' if task_id=='ux-cancelled' else 'failed','checkpoint':{'workspaceId':'default'}}})
    page.route('**/api/tasks/ux-*', task)
    def resume(route):
        resumed.append(route.request.post_data_json)
        sse(route, [{'type':'done','taskId':'ux-failed','result':{'body':'恢复完成（界面夹具）','citations':[]}}])
    page.route('**/api/tasks/ux-failed/resume', resume)
    page.locator('#input').fill('read')
    page.locator('#send').click()
    answer = page.locator('.msg.assistant').last
    expect(answer.locator('.run-status-text')).to_have_text('回答已完成 · 部分来源不可用')
    # Exercise the normal browser download and keyboard path with a synthetic stored answer.
    exported = [{'id': str(hit['ref']), 'type': 'chapter', 'title': '合成导出样本'}]
    page.route('**/api/tasks/ux-complete/references?format=csl-json', lambda route: route.fulfill(json=exported))
    menu = answer.locator('summary').filter(has_text='导出参考文献')
    menu.focus()
    menu.press('Enter')
    with page.expect_download() as pending_download:
        answer.get_by_role('button', name='CSL-JSON').click()
    artifact = pending_download.value
    assert artifact.suggested_filename == 'references.json'
    assert json.loads(Path(artifact.path()).read_text(encoding='utf-8')) == exported
    expect(menu).to_be_focused()
    expect(answer.locator('table')).to_be_visible()
    expect(answer.locator('.inference')).to_be_visible()
    expect(answer.locator('tbody tr')).to_have_count(1)
    expect(answer.locator('a[href="https://example.org/"]')).to_have_attribute('rel','noopener noreferrer')
    assert answer.locator('details.evidence').get_attribute('open') is None
    assert answer.locator('details.support-review').get_attribute('open') is None
    before = len(calls)
    answer.locator('[data-resend]').click()
    expect(page.locator('#input')).to_have_value('read')
    assert len(calls) == before, 'draft action sent a new task'

    attempts = []
    def read_source(route):
        attempts.append(1)
        if len(attempts) <= 3:
            route.fulfill(status=[500,403,404][len(attempts)-1], json={'error':'fixture_unavailable'})
        else:
            # Synthetic page map tests presentation, not OCR accuracy.
            route.fulfill(json={**source, 'locations':[{'start':0,'end':len(source['content']),'page':7}]})
    page.route('**/api/source/**', read_source)
    answer.locator('.answer .cite').first.click()
    expect(page.locator('[data-source-retry]')).to_be_visible()
    for _ in (403,404):
        page.locator('[data-source-retry]').click()
        expect(page.locator('.reader-status')).to_contain_text('资料不存在或不可访问')
    page.locator('[data-source-retry]').click()
    expect(page.locator('#reader-foot')).to_contain_text('原文件第 7 页')
    expect(page.locator('#reader-body mark')).to_have_text(source['content'][:sample['end']])
    page.keyboard.press('Escape')
    expect(answer.locator('.answer .cite').first).to_be_focused()
    page.unroute('**/api/source/**', read_source)

    page.locator('#input').fill('fail'); page.locator('#send').click()
    recovery = page.locator('.msg.assistant').last.locator('.task-recovery')
    expect(recovery.get_by_role('button', name='恢复失败任务')).to_be_visible()
    recovery.get_by_role('button', name='恢复失败任务').evaluate('(button)=>{button.click();button.click();}')
    expect(page.locator('.msg.assistant').last.locator('.answer')).to_have_text('恢复完成（界面夹具）')
    assert len(resumed) == 1, 'double click duplicated resume request'
    page.locator('#input').fill('cancel'); page.locator('#send').click()
    stopped = page.locator('.msg.assistant').last
    expect(stopped.locator('.run-status-text')).to_have_text('已停止')
    expect(stopped.locator('.warn-note').filter(has_text='任务失败')).to_have_count(0)
    expect(stopped.get_by_role('button', name='恢复失败任务')).to_have_count(0)
    ui.no_overflow(page)
    ui.screenshot(page, f'experience-result-{width}-{theme}')

    # Stop while GET task is pending: no resume request may reach the backend.
    page.locator('#input').fill('fail'); page.locator('#send').click()
    recovery = page.locator('.msg.assistant').last.locator('.task-recovery')
    expect(recovery.get_by_role('button', name='恢复失败任务')).to_be_visible()
    held = []
    def hold_task(route): held.append(route)
    page.route('**/api/tasks/ux-failed', hold_task)
    with page.expect_request('**/api/tasks/ux-failed'):
        recovery.get_by_role('button', name='恢复失败任务').click()
    expect(page.locator('#send')).to_have_attribute('aria-label', '停止')
    page.locator('#send').click()
    expect(page.locator('#send')).to_have_attribute('aria-label', '发送')
    assert len(resumed) == 1, 'stop during preparation sent a resume request'
    for route in held:
        try: task(route)
        except Exception: pass  # the browser has already aborted this GET
    page.unroute('**/api/tasks/ux-failed', hold_task)

    # Switching conversation during history loading must not insert/restart the old task.
    page.locator('#input').fill('fail'); page.locator('#send').click()
    recovery = page.locator('.msg.assistant').last.locator('.task-recovery')
    expect(recovery.get_by_role('button', name='恢复失败任务')).to_be_visible()
    held_history = []
    def hold_history(route): held_history.append(route)
    page.route('**/api/conversations/' + conv + '/messages', hold_history)
    with page.expect_request('**/api/conversations/' + conv + '/messages'):
        recovery.get_by_role('button', name='恢复失败任务').click()
    ui.open_sidebar_action(page, '#btn-new')
    for route in held_history:
        try: route.fulfill(json={'messages':[], 'activeTasks':[]})
        except Exception: pass
    expect(page.locator('#send')).to_have_attribute('aria-label', '发送')
    expect(page.locator('.msg.assistant')).to_have_count(0)
    assert len(resumed) == 1, 'navigation during preparation resumed a stale task'
    page.unroute('**/api/conversations/' + conv + '/messages', hold_history)
    ui.no_overflow(page)
    contrast = page.evaluate("""()=>{
      const css=getComputedStyle(document.documentElement);
      const rgb=hex=>{hex=hex.trim();if(hex.length===4)hex='#'+[...hex.slice(1)].map(c=>c+c).join('');return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255);};
      const luminance=hex=>rgb(hex).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((s,c,i)=>s+c*[.2126,.7152,.0722][i],0);
      return ['--ui-ink','--ui-muted','--ui-accent'].map(token=>{const a=luminance(css.getPropertyValue(token)),b=luminance(css.getPropertyValue('--ui-surface'));return {token,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};});
    }""")
    assert all(pair['ratio'] >= 4.5 for pair in contrast), contrast
    return {'width':width,'theme':theme,'contrastPairs':contrast,'syntheticTasks':len(calls),'resumeRequests':len(resumed)}


def main():
    global SHOTS
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recon', action='store_true')
    parser.add_argument('--output-dir', type=Path, help='Save a distinct run without replacing previous evidence')
    args = parser.parse_args()
    if args.output_dir:
        SHOTS = args.output_dir.resolve()
        ui.SHOTS = SHOTS
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors, blocked, cases = [], [], []
    with tempfile.TemporaryDirectory(prefix='zh-ui-experience-') as temporary:
        directory = Path(temporary).resolve()
        environment = {key:value for key,value in os.environ.items() if key.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT'}}
        if (ROOT / '.env').is_file():
            for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
                key = line.split('=',1)[0].strip()
                if '=' in line and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*',key): environment[key]=''
        fixture = ui.helpers.isolated_environment(directory)
        fixture_keys = ('PORT HOST DATA_DIR STORE_FILE KB_FILE VECTOR_FILE AUTH_SECRET CORPUS_PROFILE CORPUS_JSONL CORPUS_MANIFEST '
                        'MYSQL_ENABLED REDIS_ENABLED QDRANT_URL EMBEDDING_PROVIDER EMBEDDING_BASE_URL EMBEDDING_API_KEY EMBEDDING_DIM '
                        'RAGFLOW_BASE_URL RAGFLOW_API_KEY RERANK_ENABLED MINERU_ENABLED WEB_FETCH_ENABLED WEB_SEARCH_PROVIDER WEB_SEARCH_KEY '
                        'LEARNING_ENABLED INFERENCE_AUDIT EXEC_ENABLED MCP_ENABLED MCP_TOKENS MCP_TOKEN ADMIN_TOKEN ADMIN_LOOPBACK '
                        'LEGACY_LOOPBACK_IDENTITY TRUST_PROXY RATE_LIMIT_PER_MIN HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY').split()
        environment.update({key:fixture[key] for key in fixture_keys})
        environment.update({'LANGFUSE_ENABLED':'false','AUX_LLM_MAX_CALLS':'0','JUDGE_ENABLED':'false'})
        with (SHOTS / 'server.log').open('w', encoding='utf-8') as log:
            child = subprocess.Popen([shutil.which('node'),'server.mjs'], cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:
                base = ui.helpers.wait_server(child,directory)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        for width in (1440,768,390):
                            for theme in ('light','dark'):
                                context = browser.new_context(viewport={'width':width,'height':1000},reduced_motion='reduce')
                                context.add_init_script("sessionStorage.setItem('zh.intro.played','1');localStorage.setItem('csl.theme',"+json.dumps(theme)+');')
                                def guard(route):
                                    if route.request.url.startswith(base + '/') and urlsplit(route.request.url).path not in ('/api/models','/api/chat') and '/no-model' not in urlsplit(route.request.url).path: route.continue_()
                                    else: blocked.append(urlsplit(route.request.url).path); route.abort()
                                context.route('**/*',guard)
                                page = context.new_page(); page.on('pageerror',lambda error:errors.append(str(error)))
                                if args.recon:
                                    page.goto(base,wait_until='networkidle');ui.screenshot(page,'recon');return
                                try: cases.append(check(page,base,width,theme))
                                except Exception:
                                    page.screenshot(path=str(SHOTS/f'failure-{width}-{theme}.png'),full_page=True)
                                    raise
                                finally: context.close()
                    finally: browser.close()
            finally:
                child.terminate()
                try: child.wait(timeout=10)
                except subprocess.TimeoutExpired: child.kill();child.wait(timeout=5)
    assert not errors, errors
    assert not blocked, blocked
    report={'status':'passed','cases':cases,'pageErrors':errors,'blockedRequests':blocked,'realModelCalls':0,'productionDataChanged':False,
            'provenance':ui.helpers.evidence_metadata(browser.version,SHOTS.glob('experience-*.png')),
            'limitations':['Task/SSE and page map are synthetic fixtures.','Contrast checks cover named token pairs, not full WCAG or screen-reader certification.']}
    (SHOTS/'acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','cases':len(cases),'realModelCalls':0},ensure_ascii=False))


if __name__ == '__main__': main()
