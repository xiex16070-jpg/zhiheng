"""Isolated Chromium acceptance for modes, settings sections and reviewer form.

Uses temporary application data and synthetic reviewer credentials. No model call,
production setting or external network is permitted. Screenshots are local.
Run: python scripts/ui-settings-navigation-smoke.py [--recon]
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
from urllib.parse import urlsplit
from zipfile import ZipFile

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / '.shots' / 'settings-navigation'
spec = importlib.util.spec_from_file_location('ui_logic_helpers', ROOT / 'scripts/ui-logic-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def open_sidebar_action(page, selector):
    if not page.locator(selector).is_visible():
        page.locator('#btn-sidebar').click()
    page.locator(selector).click()


def no_overflow(page):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1'), 'viewport horizontal overflow'
    assert page.locator('.configuration-panel,.capability-workbench').evaluate_all('nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)'), 'settings/capability panel overflow'


def screenshot(page, name):
    page.evaluate('''async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));
      await Promise.allSettled(document.getAnimations().filter(animation=>
        animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished));
    }''')
    page.screenshot(path=str(SHOTS / (name + '.png')), full_page=True)


def open_settings(page, section='overview'):
    open_sidebar_action(page, '#btn-settings')
    expect(page.locator('dialog.app-settings[open]')).to_be_visible()
    go_section(page, section)


def go_section(page, section):
    nav = page.locator('nav.configuration-navigation')
    button = nav.locator('[data-settings-section="' + section + '"]')
    button.click()
    expect(button).to_have_attribute('aria-current', 'location')
    expect(page.locator('[data-configuration-section="' + section + '"]')).to_be_visible()
    page.wait_for_function('''section=>{
      const target=document.querySelector('[data-configuration-section="'+section+'"]');
      const nav=document.querySelector('nav.configuration-navigation');
      const body=document.querySelector('.configuration-body');
      const a=target.getBoundingClientRect(), n=nav.getBoundingClientRect(), b=body.getBoundingClientRect();
      const aligned=a.top>=b.top-2 && a.top<=b.top+28;
      const atEnd=body.scrollTop+body.clientHeight>=body.scrollHeight-2;
      return a.bottom>Math.max(n.bottom,b.top)+12 && a.top<b.bottom-12 && (aligned||atEnd);
    }''', arg=section)


def mode_acceptance(page, width, theme):
    agent = page.locator('[data-task-mode="agent"]')
    knowledge = page.locator('[data-task-mode="knowledge"]')
    expect(agent).to_be_visible()
    expect(knowledge).to_be_visible()
    # The switch remains at the page top, rather than underneath the composer.
    group_box = page.locator('#task-mode-switch').bounding_box()
    assert group_box['x'] < width * .5 and group_box['y'] < 180, group_box
    for button in (agent, knowledge):
        box = button.bounding_box()
        assert box['y'] < 180 and box['x'] + box['width'] <= width + 1, box
        assert box['height'] >= 36, box
    expect(page.locator('.composer-wrap [data-task-mode]')).to_have_count(0)
    agent.click()
    expect(agent).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.empty-art')).to_have_attribute('src', '/assets/brand/studio-sculpture.png')
    page.wait_for_function('document.querySelector(".empty-art")?.naturalWidth>0')
    expect(page.locator('zh-question-index')).to_have_count(0)
    page.locator('#input').fill('尚未发送的合成测试草稿')
    knowledge.click()
    expect(page.locator('#input')).to_have_value('尚未发送的合成测试草稿')
    expect(knowledge).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.empty-art')).to_have_attribute('src', '/assets/illustrations/research-library.webp')
    page.wait_for_function('document.querySelector(".empty-art")?.naturalWidth>0')
    expect(page.locator('zh-question-index')).to_have_count(1)
    open_sidebar_action(page, '#btn-new')
    expect(knowledge).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.empty-art')).to_have_attribute('src', '/assets/illustrations/research-library.webp')
    no_overflow(page)
    screenshot(page, f'knowledge-{width}-{theme}')
    agent.click()
    open_sidebar_action(page, '#btn-new')
    expect(agent).to_have_attribute('aria-pressed', 'true')
    expect(page.locator('.empty-art')).to_have_attribute('src', '/assets/brand/studio-sculpture.png')
    screenshot(page, f'agent-{width}-{theme}')


def judge_acceptance(page, base, mutate):
    go_section(page, 'judge')
    form = page.locator('[data-judge-form]')
    expect(form.locator('[type=submit]')).to_be_enabled()
    measurements = form.locator('input:not([type=checkbox])').evaluate_all('''nodes=>nodes.map(node=>{
      const visibleControl=node.closest('.judge-number')||node;
      const box=visibleControl.getBoundingClientRect(), css=getComputedStyle(visibleControl);
      return {name:node.name,height:box.height,width:box.width,borderStyle:css.borderStyle,fontSize:parseFloat(getComputedStyle(node).fontSize)};
    })''')
    assert len(measurements) == 5, measurements
    assert max(m['height'] for m in measurements)-min(m['height'] for m in measurements) <= 1, measurements
    assert all(m['height'] >= 42 and m['width'] >= 100 and m['fontSize'] >= 12 and m['borderStyle'] != 'inset' for m in measurements), measurements
    if mutate:
        form.locator('[name=enabled]').check()
        form.locator('[name=baseUrl]').fill('https://reviewer.invalid/v1')
        form.locator('[name=model]').fill('ui-independent-reviewer')
        form.locator('[name=apiKey]').fill('synthetic-reviewer-key-acceptance')
        form.locator('[name=maxOutputTokens]').fill('2048')
        form.locator('[name=timeoutSeconds]').fill('30')
        with page.expect_response(lambda r: r.url.endswith('/api/knowledge/judge') and r.request.method == 'POST') as pending:
            form.locator('[type=submit]').click()
        response = pending.value
        assert response.status == 200, response.text()
        saved = response.json()
        assert saved['enabled'] and saved['hasKey'] and saved['apiKey'] == ''
        expect(form.locator('[name=apiKey]')).to_have_value('')
        form.locator('[name=model]').fill('unsaved-ui-draft')
        form.locator('[data-judge-refresh]').click()
        expect(form.locator('[name=model]')).to_have_value('ui-independent-reviewer')
        # A saved configuration replacing an invalid draft must also replace its
        # feedback. Programmatic value assignment does not emit an input event.
        endpoint = form.locator('[name=baseUrl]')
        endpoint.fill('not-a-url')
        assert not form.evaluate('node=>node.reportValidity()')
        expect(endpoint).to_have_attribute('aria-invalid', 'true')
        expect(form.locator('.field-error')).to_have_count(1)
        form.locator('[data-judge-refresh]').click()
        expect(endpoint).to_have_value('https://reviewer.invalid/v1')
        expect(endpoint).not_to_have_attribute('aria-invalid', 'true')
        expect(form.locator('.field-error')).to_have_count(0)
        budget = form.locator('[name=maxOutputTokens]')
        budget.fill('0')
        assert not form.evaluate('node=>node.reportValidity()')
        expect(budget).to_have_attribute('aria-invalid', 'true')
        assert 'judge-token-hint' in budget.get_attribute('aria-describedby').split()
        form.locator('[data-judge-refresh]').click()
        expect(budget).to_have_value('2048')
        expect(budget).not_to_have_attribute('aria-invalid', 'true')
        expect(budget).to_have_attribute('aria-describedby', 'judge-token-hint')
        expect(form.locator('.field-error')).to_have_count(0)
        form.locator('[name=maxOutputTokens]').fill('3072')
        with page.expect_response(lambda r: r.url.endswith('/api/knowledge/judge') and r.request.method == 'POST') as pending:
            form.locator('[type=submit]').click()
        assert pending.value.status == 200, pending.value.text()
        persisted = page.request.get(base + '/api/knowledge/judge').json()
        assert persisted['hasKey'] and persisted['apiKey'] == '' and persisted['maxOutputTokens'] == 3072
        assert 'synthetic-reviewer-key-acceptance' not in page.evaluate('JSON.stringify(Object.entries(localStorage))')
    return measurements


def capability_acceptance(page, extensive=False):
    open_sidebar_action(page, '#btn-capabilities')
    expect(page.locator('[data-capability="commands"]')).to_be_visible()
    if extensive:
        page.locator('[data-capability-search]').fill('独立审核')
        expect(page.locator('[data-config-destination]:visible')).to_have_count(1)
        expect(page.locator('[data-config-destination=judge]')).to_be_visible()
        expect(page.locator('[data-capability-list]')).not_to_contain_text('没有匹配的能力')
        page.locator('[data-capability-search]').fill('')
    checks = [('commands','settings-commands','#runtime-settings'),
              ('latex','settings-latex','#runtime-math')]
    if extensive:
        checks += [('desktop','settings-browser','#runtime-settings'),
                   ('delegate','settings-teams','#settings-teams-slot'),
                   ('scholar','settings-search','#web-search-settings'),
                   ('mcp','settings-extensions','#extensions-settings')]
    for index, (capability, action, target) in enumerate(checks):
        if index:
            open_sidebar_action(page, '#btn-capabilities')
        button = page.locator('[data-capability="' + capability + '"] [data-navigate]')
        expect(button).to_have_attribute('data-navigate', action)
        button.click()
        expect(page.locator('dialog.app-settings[open]')).to_be_visible()
        expect(page.locator(target)).to_be_visible()
        page.wait_for_function('''selector=>{
          const t=document.querySelector(selector).getBoundingClientRect();
          const b=document.querySelector('.configuration-body').getBoundingClientRect();
          return t.bottom>b.top+20 && t.top<b.bottom-20;
        }''', arg=target)
        page.locator('#app-settings-close').click()
    destinations = page.evaluate('''async()=>{
      const {CONFIGURATION_SECTIONS}=await import('/src/ui/configuration-sections.js');
      return CONFIGURATION_SECTIONS.map(section=>({id:section.id,selector:section.selector}));
    }''') if extensive else [{'id':'judge','selector':'#judge-settings'}]
    for destination in destinations:
        open_sidebar_action(page, '#btn-capabilities')
        page.locator('[data-config-destination="'+destination['id']+'"]').click()
        expect(page.locator('dialog.app-settings[open]')).to_be_visible()
        expect(page.locator('[data-settings-section="'+destination['id']+'"]')).to_have_attribute('aria-current','location')
        expect(page.locator(destination['selector'])).to_be_visible()
        page.locator('#app-settings-close').click()
    if extensive:
        # Closing a dock keeps its node/draft; an explicit capability destination
        # must activate the requested tab on that reused component.
        open_sidebar_action(page, '#btn-knowledge')
        knowledge = page.locator('dialog.knowledge-mask')
        knowledge.locator('[data-page=documents]').click()
        knowledge.locator('.knowledge-search input').fill('保留的测试筛选')
        knowledge.locator('[data-panel-close]').click()
        open_sidebar_action(page, '#btn-capabilities')
        page.locator('[data-capability=conclusions] [data-navigate]').click()
        expect(knowledge.locator('[data-page=conclusions]')).to_have_attribute('aria-pressed','true')
        expect(knowledge.locator('.knowledge-search input')).to_have_value('保留的测试筛选')
        knowledge.locator('[data-panel-close]').click()
        open_sidebar_action(page, '#btn-knowledge')
        expect(knowledge.locator('[data-page=conclusions]')).to_have_attribute('aria-pressed','true')
        knowledge.locator('[data-panel-close]').click()


def skill_exchange_acceptance(page, base, directory):
    uid = page.request.get(base + '/api/bootstrap').json()['user']['id']
    assert re.fullmatch(r'[A-Za-z0-9_-]{1,32}', uid)
    workspace = directory / 'workspace' / uid
    fixture = workspace / 'long-description'
    (fixture / 'references').mkdir(parents=True)
    (fixture / 'references' / 'notes.md').write_text('Test reference', encoding='utf-8')
    description = '适用于证据核验。' * 12
    (fixture / 'SKILL.md').write_text(f'---\nname: long-description\ndescription: {description}\n---\n核对来源。\n', encoding='utf-8')
    # Seed the existing, tracked skill in this temporary user's store for a real download.
    stored = directory / 'skills' / uid / 'citation-export'
    stored.mkdir(parents=True)
    shutil.copyfile(ROOT / 'skill-library/citation-export/SKILL.md', stored / 'SKILL.md')

    open_settings(page, 'integrations')
    page.get_by_role('button', name=re.compile('插件包')).first.click()
    field = page.get_by_label('工作区相对路径')
    check = page.get_by_role('button', name='只读预检')
    install = page.get_by_role('button', name='安装插件包')
    expect(check).to_be_disabled()
    field.fill('long-description/plugin.json')
    expect(install).to_be_enabled()
    field.fill('long-description')
    expect(install).to_be_disabled()
    check.focus()
    page.keyboard.press('Enter')
    report = page.get_by_role('region', name='预检详情')
    expect(report).to_contain_text(f'描述 {len(description)} 字符')
    expect(report).to_contain_text('60')
    page.set_viewport_size({'width':390, 'height':844})
    entry = report.locator('summary').filter(has_text='references/')
    entry.focus()
    page.keyboard.press('Enter')
    expect(report.get_by_text('references/notes.md', exact=True)).to_be_visible()
    no_overflow(page)
    page.set_viewport_size({'width':1440, 'height':1000})
    field.fill('missing-entry')
    expect(report).to_be_hidden()
    check.click()
    expect(page.locator('#pack-progress')).to_contain_text('预检未完成')
    page.locator('#app-settings-close').click()

    open_sidebar_action(page, '#btn-learn')
    page.get_by_role('tab', name='技能', exact=True).click()
    page.locator('[data-view="citation-export"]').click()
    dialog = page.get_by_role('dialog', name='citation-export', exact=True)
    with page.expect_download() as pending:
        dialog.get_by_role('button', name='导出 Agent Skills ZIP').click()
    download = pending.value
    assert download.suggested_filename == 'citation-export.zip'
    with ZipFile(download.path()) as archive:
        members = archive.namelist()
        assert members == ['citation-export/SKILL.md']
        contents = archive.read(members[0])
        assert '# 参考文献导出' in contents.decode('utf-8')
        destination = workspace / members[0]
        destination.parent.mkdir()
        destination.write_bytes(contents)
    dialog.get_by_role('button', name='关闭技能详情').click()
    page.locator('.learn-modal [data-panel-close], .learn-modal .modal-head [data-close]').first.click()
    open_settings(page, 'integrations')
    page.locator('.integration-nav [data-panel=packs]').click()
    field.fill('citation-export/SKILL.md')
    check.click()
    expect(report).to_contain_text('标准头部通过')
    expect(report).to_contain_text('citation-export')
    page.locator('#app-settings-close').click()
    assert page.request.get(base + '/api/settings/plugin-packs').json()['packs'] == []
    return {'roundTripEntries':members, 'longDescriptionCharacters':len(description),
            'resourceOpenedWithKeyboard':'references/notes.md', 'installedPacks':0}


def context7_acceptance(page, base):
    """Exercise consent and key controls without spending a hosted request or quota."""
    endpoint = base + '/api/settings/extensions'
    state = page.request.get(endpoint).json()
    assert state['entries'] == []
    posts = []
    def fixture(route):
        if route.request.method == 'GET':
            return route.fulfill(json=state)
        body = route.request.post_data_json
        assert route.request.method == 'POST' and body.pop('revision') == state['revision']
        posts.append(body)
        if len(posts) == 1:
            return route.fulfill(status=429, json={'error':'context7_rate_limit', 'message':'Context7 已达到请求配额。'})
        if body.get('token') == 'rejected-fixture':
            return route.fulfill(status=403, json={'error':'context7_auth','message':'Context7 拒绝此请求，请检查 API Key 和账号权限。'})
        if body.get('preset') == 'context7':
            if not state['entries']:
                state['entries'].append({'id':'test-docs', 'preset':'context7', 'name':'Context7', 'kind':'http',
                    'target':'mcp.context7.com', 'enabled':False, 'tokenConfigured':False,
                    'tools':[{'name':'query-docs','description':'Query library documentation','allowed':False,'readOnly':True}]})
            if body.get('token') or body.get('clearToken'):
                state['entries'][0]['tokenConfigured'] = bool(body.get('token'))
        else:
            entry = state['entries'][0]
            assert body == {'id':entry['id'],'enabled':True,'allowedTools':['query-docs']}
            entry['enabled'] = entry['tools'][0]['allowed'] = True
        state['revision'] += 1
        route.fulfill(json=state)

    page.route(endpoint, fixture)
    try:
        open_settings(page, 'extensions')
        panel = page.locator('#context7-setup')
        panel.locator('summary').focus()
        page.keyboard.press('Enter')
        expect(panel.locator('#context7-state')).to_have_text('未连接')
        button = panel.locator('[type=submit]')
        expect(button).to_be_disabled()
        assert not posts
        consent = panel.locator('#context7-consent')
        consent.check()
        button.click()
        expect(panel.get_by_role('status')).to_contain_text('配额')
        assert posts == [{'preset':'context7'}]
        key = panel.locator('#context7-key')
        key.fill('rejected-fixture')
        button.click()
        expect(panel.get_by_role('status')).to_contain_text('账号权限')
        expect(panel.locator('#context7-state')).to_have_text('未连接')
        assert len(posts) == 2, 'upstream authentication failure must not replay a credential request'
        key.fill('fixture-context7-only')
        button.click()
        expect(panel.locator('#context7-state')).to_have_text('已连接 · 未启用')
        expect(key).to_have_value('')
        expect(key).to_have_attribute('placeholder', '留空保留已保存的 Key')
        expect(button).to_be_disabled()
        assert 'fixture-context7-only' not in page.evaluate('JSON.stringify(Object.entries(localStorage))')
        panel.locator('#context7-permissions').click()
        card = page.locator('#extension-list [data-id="test-docs"]')
        expect(card.locator('summary')).to_be_focused()
        expect(card.locator('[data-readonly-tool],[data-resource-readonly],[data-resources]')).to_have_count(0)
        card.locator('[data-enabled]').check()
        card.locator('[data-tool="query-docs"]').check()
        card.locator('[data-action=save]').click()
        expect(panel.locator('#context7-state')).to_have_text('已启用')
        page.locator('#app-settings-close').click()
        open_settings(page, 'extensions')
        panel.locator('summary').click()
        expect(key).to_have_value('')
        page.set_viewport_size({'width':390,'height':844})
        no_overflow(page)
        consent.check(); button.click()
        expect(consent).not_to_be_checked()
        assert posts[-1] == {'preset':'context7'}, 'blank must preserve a stored key'
        panel.locator('#context7-clear').check()
        expect(key).to_be_disabled()
        consent.check(); button.click()
        expect(panel.locator('#context7-clear-row')).to_be_hidden()
        assert posts[-1] == {'preset':'context7','clearToken':True}
        expect(panel.locator('#context7-state')).to_have_text('已启用')
        page.locator('#app-settings-close').click()
        page.set_viewport_size({'width':1440,'height':1000})
    finally:
        page.unroute(endpoint, fixture)
    return {'transport':'mock settings response', 'externalRequests':0, 'covered':['anonymous','429','403','key','permissions','retain','clear']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recon', action='store_true')
    args = parser.parse_args()
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors, blocked, rows = [], [], []
    with tempfile.TemporaryDirectory(prefix='zh-ui-settings-navigation-') as temporary:
        directory = Path(temporary).resolve()
        assert directory.parent == Path(tempfile.gettempdir()).resolve() and directory.name.startswith('zh-ui-settings-navigation-')
        fixture_environment = helpers.isolated_environment(directory)
        system_keys = {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT'}
        environment = {key:value for key,value in os.environ.items() if key.upper() in system_keys}
        # Prevent the project's dotenv fallback from loading live provider settings.
        if (ROOT / '.env').is_file():
            for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
                key = line.split('=', 1)[0].strip()
                if '=' in line and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', key):
                    environment[key] = ''
        fixture_keys = ('PORT HOST DATA_DIR STORE_FILE KB_FILE VECTOR_FILE AUTH_SECRET CORPUS_PROFILE CORPUS_JSONL CORPUS_MANIFEST '
                        'MYSQL_ENABLED REDIS_ENABLED QDRANT_URL EMBEDDING_PROVIDER EMBEDDING_BASE_URL EMBEDDING_API_KEY EMBEDDING_DIM '
                        'RAGFLOW_BASE_URL RAGFLOW_API_KEY RERANK_ENABLED MINERU_ENABLED WEB_FETCH_ENABLED WEB_SEARCH_PROVIDER WEB_SEARCH_KEY '
                        'LEARNING_ENABLED INFERENCE_AUDIT EXEC_ENABLED MCP_ENABLED MCP_TOKENS MCP_TOKEN ADMIN_TOKEN ADMIN_LOOPBACK '
                        'LEGACY_LOOPBACK_IDENTITY TRUST_PROXY RATE_LIMIT_PER_MIN HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY').split()
        environment.update({key:fixture_environment[key] for key in fixture_keys})
        environment.update({'LANGFUSE_ENABLED':'false', 'AUX_LLM_MAX_CALLS':'0', 'JUDGE_ENABLED':'false'})
        with (SHOTS / 'server.log').open('w', encoding='utf-8') as log:
            child = subprocess.Popen([shutil.which('node'), 'server.mjs'], cwd=ROOT, env=environment,
                stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            try:
                base = helpers.wait_server(child, directory)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        context = browser.new_context(viewport={'width':1440,'height':1000}, reduced_motion='reduce')
                        context.add_init_script("sessionStorage.setItem('zh.intro.played','1'); localStorage.setItem('csl.theme','light')")
                        def guard(route):
                            url = route.request.url
                            if url.startswith(base + '/') and urlsplit(url).path not in ('/api/chat','/api/models'):
                                route.continue_()
                            else:
                                blocked.append(urlsplit(url).path)
                                route.abort()
                        context.route('**/*', guard)
                        page = context.new_page()
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.goto(base)
                        page.wait_for_load_state('networkidle')
                        expect(page.locator('#btn-settings')).to_be_attached()
                        # Rendered-state reconnaissance precedes all actions.
                        discovery = page.locator('button').evaluate_all('nodes=>nodes.map(n=>({id:n.id,text:n.textContent.trim(),mode:n.dataset.taskMode||null}))')
                        (SHOTS / 'recon.json').write_text(json.dumps(discovery,ensure_ascii=False,indent=2),encoding='utf-8')
                        if args.recon:
                            screenshot(page, 'recon-home')
                            open_sidebar_action(page, '#btn-settings')
                            screenshot(page, 'recon-settings')
                            print(json.dumps({'recon':True,'screenshots':str(SHOTS),'pageErrors':errors,'blocked':blocked}))
                            return
                        skill_exchange = skill_exchange_acceptance(page, base, directory)
                        context7 = context7_acceptance(page, base)
                        for width, theme in [(1440,'light'),(1440,'dark'),(768,'light'),(768,'dark'),(390,'light'),(390,'dark')]:
                            page.set_viewport_size({'width':width,'height':1000 if width>760 else 844})
                            page.evaluate('theme=>{document.documentElement.dataset.theme=theme;localStorage.setItem("csl.theme",theme)}',theme)
                            page.emulate_media(reduced_motion='no-preference' if width==1440 and theme=='light' else 'reduce')
                            mode_acceptance(page,width,theme)
                            open_settings(page)
                            nav = page.locator('nav.configuration-navigation')
                            expected_sections = page.evaluate("async()=> (await import('/src/ui/configuration-sections.js')).CONFIGURATION_SECTIONS.map(section=>section.id)")
                            sections = nav.locator('[data-settings-section]').evaluate_all('nodes=>nodes.map(n=>n.dataset.settingsSection)')
                            assert sections==expected_sections and len(set(sections))==len(sections), sections
                            for section in sections:
                                go_section(page,section)
                                no_overflow(page)
                                assert nav.bounding_box()['y']>=0
                            go_section(page,'judge')
                            page.evaluate('''()=>{const spacer=document.createElement('div');spacer.id='qa-late-form';spacer.style.height='620px';document.querySelector('#configuration-appearance').append(spacer);}''')
                            page.wait_for_function("Math.abs(document.querySelector('#judge-settings').getBoundingClientRect().top-document.querySelector('.configuration-body').getBoundingClientRect().top-12)<3")
                            page.evaluate("document.querySelector('#qa-late-form').remove()")
                            nav.locator('[data-settings-section]').first.focus()
                            page.keyboard.press('End')
                            expect(nav.locator('[data-settings-section]').last).to_be_focused()
                            page.keyboard.press('Home')
                            expect(nav.locator('[data-settings-section]').first).to_be_focused()
                            page.keyboard.press('ArrowRight')
                            expect(nav.locator('[data-settings-section]').nth(1)).to_be_focused()
                            page.keyboard.press('Enter')
                            expect(nav.locator('[data-settings-section]').nth(1)).to_have_attribute('aria-current','location')
                            if width==1440 and theme=='light':
                                page.locator('.configuration-body').dispatch_event('wheel')
                                page.locator('[data-configuration-section=judge]').evaluate('node=>node.scrollIntoView({block:"start",behavior:"instant"})')
                                expect(nav.locator('[data-settings-section=judge]')).to_have_attribute('aria-current','location')
                            measurements=judge_acceptance(page,base,mutate=width==1440 and theme=='light')
                            go_section(page,'judge')
                            screenshot(page,f'judge-{width}-{theme}')
                            go_section(page,'overview')
                            screenshot(page,f'settings-{width}-{theme}')
                            page.locator('#app-settings-close').click()
                            capability_acceptance(page,extensive=width==1440 and theme=='light')
                            open_sidebar_action(page,'#btn-capabilities')
                            expect(page.locator('[data-capability=commands]')).to_be_visible()
                            no_overflow(page)
                            if width<=768:
                                page.locator('.capability-configuration').evaluate('node=>node.scrollIntoView({block:"start",behavior:"instant"})')
                            screenshot(page,f'capabilities-{width}-{theme}')
                            page.locator('.capability-dialog [data-close]').click()
                            rows.append({'width':width,'theme':theme,'sections':sections,'judgeFields':measurements})
                        assert not errors, errors
                        assert not blocked, blocked
                        context.close()
                    finally:
                        browser.close()
            finally:
                child.terminate()
                child.wait(timeout=15)
    report={'status':'passed','viewports':rows,'skillExchange':skill_exchange,'context7':context7,'pageErrors':errors,'blockedRequests':blocked,'modelCalls':0,'productionSettingsChanged':False,
            'provenance':helpers.evidence_metadata(browser.version,SHOTS.glob('*.png'))}
    (SHOTS/'acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','cases':len(rows),'modelCalls':0,'report':str(SHOTS/'acceptance.json')},ensure_ascii=False))


if __name__=='__main__':
    main()
