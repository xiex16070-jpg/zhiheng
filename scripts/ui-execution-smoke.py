"""Isolated browser acceptance for folded evidence and observable algorithm views.

Real public search, source reader and deterministic logic API; synthetic chat/SSE
and review opinions. No real model, private document or external request is used.
Run: python scripts/ui-execution-smoke.py [--recon]
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

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / '.shots' / 'execution'
spec = importlib.util.spec_from_file_location('logic_helpers', ROOT / 'scripts/ui-logic-smoke.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)


def snapshot(page, name):
    page.evaluate('''async()=>{
      await document.fonts.ready;
      await Promise.allSettled(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished));
    }''')
    page.screenshot(path=str(SHOTS / (name + '.png')), full_page=True)


def citation_hover_contrast(control):
    control.hover()
    return control.evaluate(r'''element => {
      const style = getComputedStyle(element);
      const luminance = color => color.match(/[\d.]+/g).slice(0,3).map(value => Number(value)/255)
        .map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4)
        .reduce((sum, value, channel) => sum + value * [.2126,.7152,.0722][channel], 0);
      const fg = luminance(style.color), bg = luminance(style.backgroundColor);
      return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);
    }''')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--recon', action='store_true')
    args = parser.parse_args()
    SHOTS.mkdir(parents=True, exist_ok=True)
    errors, blocked, cases = [], [], []
    with tempfile.TemporaryDirectory(prefix='zh-ui-execution-') as temporary:
        directory = Path(temporary).resolve()
        assert directory.parent == Path(tempfile.gettempdir()).resolve() and directory.name.startswith('zh-ui-execution-')
        system_keys = {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT'}
        environment = {key:value for key,value in os.environ.items() if key.upper() in system_keys}
        if (ROOT / '.env').is_file():
            for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
                key = line.split('=', 1)[0].strip()
                if '=' in line and re.fullmatch(r'[A-Za-z_][A-Za-z_0-9]*', key):
                    environment[key] = ''
        fixture = helpers.isolated_environment(directory)
        fixture_keys = ('PORT HOST DATA_DIR STORE_FILE KB_FILE VECTOR_FILE AUTH_SECRET CORPUS_PROFILE CORPUS_JSONL CORPUS_MANIFEST '
                        'MYSQL_ENABLED REDIS_ENABLED QDRANT_URL EMBEDDING_PROVIDER EMBEDDING_BASE_URL EMBEDDING_API_KEY EMBEDDING_DIM '
                        'RAGFLOW_BASE_URL RAGFLOW_API_KEY RERANK_ENABLED MINERU_ENABLED WEB_FETCH_ENABLED WEB_SEARCH_PROVIDER WEB_SEARCH_KEY '
                        'LEARNING_ENABLED INFERENCE_AUDIT EXEC_ENABLED MCP_ENABLED MCP_TOKENS MCP_TOKEN ADMIN_TOKEN ADMIN_LOOPBACK '
                        'LEGACY_LOOPBACK_IDENTITY TRUST_PROXY RATE_LIMIT_PER_MIN HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY').split()
        environment.update({key:fixture[key] for key in fixture_keys})
        environment.update({'LANGFUSE_ENABLED':'false','JUDGE_ENABLED':'false','AUX_LLM_MAX_CALLS':'0','EMBEDDING_REVISION':''})
        with (SHOTS / 'server.log').open('w', encoding='utf-8') as log:
            child = subprocess.Popen([shutil.which('node'),'server.mjs'], cwd=ROOT, env=environment,
                stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            try:
                base = helpers.wait_server(child, directory)
                with sync_playwright() as p:
                    browser = p.chromium.launch(headless=True)
                    try:
                        for width, theme in [(1440,'light'),(1440,'dark'),(390,'light'),(390,'dark')]:
                            context = browser.new_context(viewport={'width':width,'height':1000 if width>600 else 844}, reduced_motion='reduce')
                            context.add_init_script("sessionStorage.setItem('zh.intro.played','1');localStorage.setItem('lkba.provider.v1',JSON.stringify({baseUrl:location.origin+'/no-model',model:'UI fixture',apiKey:'fixture'}));localStorage.setItem('csl.theme'," + json.dumps(theme) + ');')
                            def guard(route):
                                if route.request.url.startswith(base + '/'):
                                    route.continue_()
                                else:
                                    blocked.append(urlsplit(route.request.url).path)
                                    route.abort()
                            context.route('**/*', guard)
                            page = context.new_page()
                            page.on('pageerror', lambda error: errors.append(str(error)))
                            page.goto(base, wait_until='networkidle')
                            expect(page.locator('#input')).to_be_visible()
                            # Reconnaissance of real rendered controls precedes interaction.
                            discovery = page.locator('button').evaluate_all('nodes=>nodes.map(n=>({id:n.id,text:n.textContent.trim()}))')
                            if args.recon:
                                snapshot(page, 'recon-home')
                                print(json.dumps({'recon':True,'buttons':discovery[:12]},ensure_ascii=False))
                                return
                            found = page.request.post(base+'/api/search',data={'query':'Hoare 逻辑 前置条件','k':2,'channels':['paper']})
                            assert found.ok and found.json()['results']
                            citation = found.json()['results'][0]
                            citation['id'] = citation['ref']
                            program = '事实 已验证(程序甲)。\n规则 保证：若 已验证(?程序) 则 满足规范(?程序)。\n查询 满足规范(程序甲)。\n查询 满足规范(程序乙)。'
                            logic_response = page.request.post(base+'/api/logic/evaluate',data={'program':program})
                            assert logic_response.ok
                            logic = {**logic_response.json(),'program':program}
                            selected = {'strategy':'tot'}
                            result = {'body':f"依据原文讨论程序验证。[[{citation['ref']}]]\n\n仍须复核结论适用范围。[[unmatched-source]]",'citations':[citation],
                                'support':[{'sentence':'依据原文讨论程序验证。','verdict':'supported'}, {'sentence':'仍须复核结论适用范围。','verdict':'unsupported','reason':'合成审核意见，仅用于界面验收。'}, {'sentence':'未带引用的界面样本','verdict':'uncited'}],
                                'supportSummary':{'reason':'model_opinion_not_proof'},'inferences':[{'text':'条件满足时才能推出对应结论。','method':'演绎','confidence':'中','audit':{'verdict':'weak','reason':'合成评估，仅用于界面验收。'}}],
                                'inferenceStats':{'total':1,'pass':0,'weak':1,'fail':0},'logicResults':[logic]}
                            def fixture_steps():
                                strategy = selected['strategy']
                                steps = [
                                    {'name':'intake','status':'ok','detail':{'history':0},'ms':3},
                                    {'name':'retrieve','status':'ok','detail':{'hits':3,'weak':False,'channels':[{'name':'paper','hits':3},{'name':'vector','hits':2}]},'ms':16},
                                ]
                                if strategy != 'react':
                                    process = [{'id':1,'parent':None,'depth':1,'hits':2,'status':'ok'}, {'id':2,'parent':1 if strategy=='ircot' else None,'depth':2 if strategy=='ircot' else 1,'hits':1,'status':'ok'}]
                                    if strategy=='tot':
                                        process[0]['score']=0.5
                                        process[1]['score']=0.75
                                        process.append({'id':3,'parent':1,'depth':2,'hits':2,'novel':1,'score':0.9,'status':'ok'})
                                    else:
                                        for operation in process:
                                            operation.update(novel=1,retained=True)
                                    steps.append({'name':'research_'+strategy,'status':'ok','detail':{'mode':strategy,'searches':len(process),'hops':2,'evaluated':3 if strategy=='tot' else 0,'selected':[1,3] if strategy=='tot' else [],'modelCalls':2,'stop':'complete','process':process},'ms':35})
                                steps.extend([
                                    {'name':'reason#1','status':'ok','detail':{'tools':['read_source'],'round':1},'ms':32},
                                    {'name':'tool:read_source','status':'ok','detail':{'round':1,'callId':'read-fixture','tool':'read_source','args':{'ref':citation['ref']},'summary':'已读取公共来源'},'ms':2},
                                    {'name':'tool:current_time','status':'ok','detail':{'round':1,'callId':'time-fixture','tool':'current_time','summary':'已读取当前时间'},'ms':1},
                                    {'name':'verify','status':'ok','detail':{'citations':1,'unverified':0},'ms':1},
                                ])
                                return steps
                            def chat(route):
                                events = [{'type':'step',**step} for step in fixture_steps()]
                                events += [{'type':'token','text':result['body']},{'type':'done','result':result,'ms':89}]
                                route.fulfill(status=200,content_type='text/event-stream; charset=utf-8',body=''.join('data: '+json.dumps(event,ensure_ascii=False)+'\n\n' for event in events))
                            page.route('**/api/chat',chat)
                            for strategy in ('react','ircot','tot'):
                                selected['strategy'] = strategy
                                page.locator('#input').fill('执行视图验收 '+strategy)
                                page.locator('#send').click()
                                message = page.locator('.msg.assistant').last
                                expect(message.locator('.result-disclosure')).to_have_count(5)
                                for selector in ('.support-review','.evidence','.inf-panel','.logic-chat-panel'):
                                    panel = message.locator(selector)
                                    assert panel.get_attribute('open') is None
                                    control = panel.locator(':scope > summary')
                                    control.focus()
                                    control.press('Space')
                                    assert panel.get_attribute('open') is not None
                                    expect(control.locator('.when-open')).to_be_visible()
                                    control.press('Enter')
                                    assert panel.get_attribute('open') is None
                                assert message.locator('.trace-head').get_attribute('aria-expanded')=='false'
                                unmatched = message.locator('.answer .cite.bad')
                                expect(unmatched).to_have_text('来源未匹配')
                                assert unmatched.evaluate('e => e.tabIndex === -1 && !e.closest("button,a,[data-cite]")')
                                ratio = citation_hover_contrast(message.locator('.answer [data-cite]').first)
                                assert ratio >= 4.5, (width, theme, ratio)
                                snapshot(page,f'folded-{strategy}-{width}-{theme}')
                                message.locator('.trace-head').click()
                                expect(message.locator('.execution-overview')).to_be_visible()
                                expect(message.locator('.execution-overview button')).to_have_count(5)
                                retrieve = message.locator('.timeline-step').filter(has_text='检索文献').first
                                phase = message.locator('[data-phase=retrieval]')
                                phase.focus()
                                phase.press('Enter')
                                expect(retrieve.locator(':scope > summary')).to_be_focused()
                                expect(retrieve.locator('.execution-channels meter')).to_have_count(2)
                                if strategy != 'react':
                                    step = message.locator('.timeline-step').filter(has_text='按证据逐步追检' if strategy=='ircot' else '比较候选分支').first
                                    step.locator(':scope > summary').click()
                                    expect(step.locator('.execution-path')).to_have_count(2 if strategy=='ircot' else 3)
                                    assert len(step.locator('[data-selected=true]').all()) == 2
                                snapshot(page,f'{strategy}-{width}-{theme}')
                                message.locator('.trace-head').click()
                                # Native disclosures preserve explicit choices while other panels change.
                                message.locator('.evidence > summary').click()
                                expect(message.locator('.ev')).to_be_visible()
                                message.locator('.ev').click()
                                expect(page.locator('#reader-head h3')).to_have_text(citation['title'])
                                page.locator('.reader-close').click()
                                message.locator('.evidence > summary').click()
                                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
                                cases.append({'width':width,'theme':theme,'strategy':strategy,'defaultFolded':True,
                                              'citationHoverContrast':round(ratio,2)})
                            stable = page.evaluate('''async()=>{
                              const {createTimeline}=await import('/src/ui/timeline.js');
                              const host=document.createElement('div'), root=document.createElement('div'), summary=document.createElement('span');
                              host.append(summary,root);document.body.append(host);
                              const timeline=createTimeline({root,summary});
                              const first=timeline.upsert({name:'tool:read_source',status:'running',attempt:1,detail:{round:1,tool:'read_source',callId:'stable',args:{ref:'public-fixture'}}});
                              first.open=true;const technical=first.querySelector('.timeline-technical');technical.open=true;
                              const next=timeline.upsert({name:'tool:read_source',status:'ok',attempt:1,detail:{round:1,tool:'read_source',callId:'stable',args:{ref:'public-fixture'},summary:'完成'},ms:1});
                              const retry={name:'tool:read_source',status:'error',attempt:1,detail:{round:2,tool:'read_source',callId:'second'}};
                              const failed=timeline.upsert(retry);
                              timeline.upsert({name:'tool:read_source',status:'returned',attempt:2,detail:{round:1,tool:'read_source',callId:'stable'}});
                              const phase=root.querySelector('[data-phase=retrieval]');
                              phase.click();
                              const focused=()=>failed.querySelector('summary')===document.activeElement && failed.open;
                              const errorFocus=focused() && phase.dataset.status==='error';
                              timeline.upsert({...retry,status:'waiting'});
                              phase.focus();phase.click();
                              const answer={stable:first===next&&first.open&&technical.open,rows:root.querySelectorAll('.timeline-step').length,
                                errorFocus,waitingFocus:focused() && phase.dataset.status==='paused'};
                              host.remove();return answer;
                            }''')
                            assert stable=={'stable':True,'rows':3,'errorFocus':True,'waitingFocus':True}, stable
                            # Replay via the real history entry, with synthetic stored-result fixtures.
                            page.route('**/api/projects',lambda route:route.fulfill(json={'projects':[{'id':'default','name':'验收项目','available':True}],'activeId':'default','canChoose':False,'conversations':[{'id':'ui-execution-history','title':'过程回放','workspaceId':'default'}]}))
                            page.route('**/api/conversations/ui-execution-history/messages',lambda route:route.fulfill(json={'messages':[{'role':'assistant','content':result['body'],'taskId':'ui-execution-task','result':result}],'activeTasks':[]}))
                            page.route('**/api/tasks/ui-execution-task/steps',lambda route:route.fulfill(json={'steps':fixture_steps()}))
                            page.reload(wait_until='networkidle')
                            if not page.locator('[data-project-chat="ui-execution-history"]').is_visible():
                                page.locator('#btn-sidebar').click()
                            page.locator('[data-project-chat="ui-execution-history"]').click()
                            replay = page.locator('.msg.assistant').last
                            expect(replay.locator('.timeline-step')).to_have_count(7)
                            assert replay.locator('.trace-head').get_attribute('aria-expanded')=='false'
                            assert replay.locator('.result-disclosure[open]').count()==0
                            replay.locator('.logic-chat-panel > summary').click()
                            replay.locator('.logic-proofs > summary').click()
                            expect(replay.locator('.logic-proof-node')).to_have_count(len(logic['proofs']))
                            expect(replay.locator('.logic-proof-inputs').last).to_contain_text('p1')
                            snapshot(page,f'proof-{width}-{theme}')
                            context.close()
                    finally:
                        browser.close()
            finally:
                child.terminate()
                child.wait(timeout=15)
    assert not errors, errors
    assert not blocked, blocked
    report = {'status':'passed','cases':cases,'pageErrors':errors,'externalRequests':blocked,'modelCalls':0,'productionSettingsChanged':False,
              'provenance':helpers.evidence_metadata(browser.version,SHOTS.glob('*.png'))}
    (SHOTS/'acceptance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'status':'passed','cases':len(cases),'report':str(SHOTS/'acceptance.json')},ensure_ascii=False))


if __name__=='__main__':
    main()
