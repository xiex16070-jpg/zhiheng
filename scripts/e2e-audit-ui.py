"""Audit acceptance against a real isolated server and deterministic tool model.
This verifies framework contracts and browser behavior, not real model quality.
"""
import json, os, subprocess, tempfile, threading, time, urllib.request
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parents[1]
tmp=Path(tempfile.mkdtemp(prefix='zh-audit-ui-'))
shots=root/'.shots';shots.mkdir(exist_ok=True)
class Model(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['content-length'])))
        replies=[m for m in body['messages'] if m['role']=='tool']
        inputs=' '.join(str(m.get('content','')) for m in body['messages'] if m['role']=='user')
        if body.get('tools') and not replies and 'AUDIT_BATCH' in inputs:
            delta={'tool_calls':[{'index':i,'id':'batch-'+str(i),'type':'function','function':{'name':'write_file','arguments':json.dumps({'path':f'batch-{i}.md','content':f'# Synthetic audit {i}'})}} for i in range(3)]};reason='tool_calls'
        elif body.get('tools') and not replies and 'AUDIT_LOGIC' in inputs:
            delta={'tool_calls':[{'index':0,'id':'logic-proposal','type':'function','function':{'name':'propose_logic_program','arguments':json.dumps({'program':'事实 满足(甲)。\n规则 条件：若 满足(?对象) 则 合格(?对象)。\n查询 合格(甲)。','mode':'assumptions','explanation':'请确认给定前提。'})}}]};reason='tool_calls'
        elif body.get('tools') and len(replies)<2 and not any(k in inputs for k in ['AUDIT_BATCH','AUDIT_LOGIC']):
            name,args=('read_file',{'path':'missing-audit.md'}) if not replies else ('list_files',{})
            delta={'tool_calls':[{'index':0,'id':'audit-'+str(len(replies)),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}]};reason='tool_calls'
        else: delta={'content':'目标文件不存在；已检查工作区文件列表。未创建或修改任何文件。'};reason='stop'
        self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers()
        self.wfile.write(('data: '+json.dumps({'choices':[{'index':0,'delta':delta,'finish_reason':reason}]})+'\n\ndata: [DONE]\n\n').encode())

env={k:v for k,v in os.environ.items() if k.upper() in ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','COMSPEC','PATHEXT']}
for line in (root/'.env').read_text(encoding='utf-8').splitlines() if (root/'.env').exists() else []:
    if '=' in line and not line.lstrip().startswith('#'): env[line.split('=',1)[0].strip()]=''
(tmp/'papers.jsonl').write_text('',encoding='utf-8')
env.update(PORT='0',HOST='127.0.0.1',DATA_DIR=str(tmp),STORE_FILE=str(tmp/'store.json'),KB_FILE=str(tmp/'kb.json'),VECTOR_FILE=str(tmp/'vector.json'),CORPUS_JSONL=str(tmp/'papers.jsonl'),MYSQL_ENABLED='0',REDIS_ENABLED='0',EMBEDDING_PROVIDER='off',LEARNING_ENABLED='0',INFERENCE_AUDIT='0',AUX_LLM_MAX_CALLS='0',AUTH_SECRET='synthetic-audit-ui',NO_PROXY='127.0.0.1,localhost')
model=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=model.serve_forever,daemon=True).start()
log=(tmp/'server.log').open('w',encoding='utf-8')
child=subprocess.Popen(['node','server.mjs'],cwd=root,env=env,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
try:
    deadline=time.monotonic()+25
    while True:
        try:
            base='http://127.0.0.1:'+(tmp/'.server-port').read_text().strip()
            if json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base+'/api/health',timeout=1))['ready']:break
        except Exception: pass
        if time.monotonic()>deadline:raise RuntimeError('isolated startup timed out')
        time.sleep(.05)
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1440,'height':1000})
        errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        page.add_init_script("localStorage.setItem('zh.intro','off')")
        page.goto(base);page.wait_for_load_state('networkidle');page.wait_for_selector('#btn-command');page.wait_for_timeout(650)
        page.keyboard.press('Control+k');expect(page.locator('.command-panel')).to_be_visible()
        page.fill('.command-input','新建会话');expect(page.locator('.command-results button')).to_have_count(1);page.keyboard.press('Escape')
        page.click('#pill-model');page.fill('#f-base',f'http://127.0.0.1:{model.server_port}/v1');page.fill('#f-model','audit-fixture');page.fill('#f-key','synthetic-key');page.click('#btn-save');page.wait_for_selector('#f-base',state='detached')
        page.fill('#input','读取 missing-audit.md；如果不存在就列出工作区文件，准确说明结果。');page.click('#send')
        page.wait_for_function('document.querySelector("#send").getAttribute("aria-label")==="发送"')
        page.locator('.trace-head').last.click()
        failed=page.locator('.timeline-step[data-status=error]');expect(failed).to_have_count(1)
        failed.locator('summary').click();expect(failed).to_contain_text('missing-audit.md')
        assert page.locator('.timeline-round').count()>=2
        expect(page.locator('.timeline-step[data-tool=list_files]')).to_have_count(1)
        tasks=page.request.get(base+'/api/tasks').json()['tasks'];task=tasks[0]
        steps=page.request.get(base+'/api/tasks/'+task['id']+'/steps');assert steps.status==200
        assert any(s['status']=='error' for s in steps.json()['steps'])
        other=browser.new_context();other.request.get(base+'/api/bootstrap');assert other.request.get(base+'/api/tasks/'+task['id']+'/steps').status==404;other.close()
        page.screenshot(path=str(shots/'audit-timeline.png'),animations='disabled')
        page.reload();page.wait_for_selector('[data-project-chat]');page.locator('[data-project-chat]').first.click();page.wait_for_selector('.timeline-step[data-status=error]',state='attached')
        page.locator('.trace-head').last.click();expect(page.locator('.timeline-step[data-status=error]')).to_have_count(1)
        # A batch has one card, defaults to no approval, and a failed POST remains retryable.
        page.click('#btn-new');page.fill('#input','AUDIT_BATCH 生成三个示范 Markdown 文件。');page.click('#send')
        batch=page.locator('.approval-card').last;expect(batch.locator('[data-approve-call]')).to_have_count(3)
        assert batch.locator('[data-approve-call]:checked').count()==0
        batch.locator('[data-approve-call]').nth(0).check();batch.locator('[data-approve-call]').nth(2).check()
        page.route('**/api/approvals/*/decide',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":"temporary approval failure"}'))
        batch.locator('[data-act=approved]').click();expect(batch.locator('.ap-done')).to_contain_text('可重试')
        expect(batch.locator('[data-act=rejected]')).to_be_enabled();assert batch.locator('[data-approve-call]:checked').count()==2
        page.unroute('**/api/approvals/*/decide');batch.locator('[data-act=approved]').click()
        page.wait_for_function('document.querySelector("#send").getAttribute("aria-label")==="发送"')
        for i,status in [(0,200),(1,404),(2,200)]:assert page.request.get(base+f'/api/workspace/file?path=batch-{i}.md').status==status
        expect(batch.locator('[data-act=approved]')).to_be_hidden()
        # Human edits are executed, not the original proposed program.
        page.click('#btn-new');page.fill('#input','AUDIT_LOGIC 若满足则合格，能否推出甲合格？');page.click('#send')
        proposal=page.locator('.approval-card').last;expect(proposal.locator('.logic-proposal-program')).to_be_visible()
        proposal.locator('.logic-proposal-program').fill('事实 非 合格(甲)。\n查询 合格(甲)。')
        proposal.locator('[data-act=approved]').click();page.wait_for_function('document.querySelector("#send").getAttribute("aria-label")==="发送"')
        latest=page.request.get(base+'/api/tasks').json()['tasks'][0]
        record=page.request.get(base+'/api/tasks/'+latest['id']).json()['task']
        assert record['result']['logicResults'][0]['queries'][0]['status']=='false'
        # Failed fetches leave a retry action; no unhandled rejection or permanent spinner.
        page.route('**/api/memory',lambda r:r.fulfill(status=503,content_type='application/json',body='{"error":"fixture unavailable"}'))
        page.click('#btn-learn');expect(page.locator('[data-learn-retry]')).to_be_visible();page.unroute('**/api/memory');page.click('[data-learn-retry]');expect(page.locator('#mem-text')).to_be_visible()
        page.fill('#mem-text','保留未提交的草稿');page.click('[data-workbench=learning] [data-workbench-tab=knowledge]');expect(page.locator('.knowledge-workbench')).to_be_visible()
        page.click('[data-workbench=knowledge] [data-workbench-tab=learning]');expect(page.locator('#mem-text')).to_have_value('保留未提交的草稿')
        page.locator('[data-workbench=learning] [data-panel-close]').click()
        page.route('**/api/metrics',lambda r:r.fulfill(status=503,content_type='application/json',body='{}'))
        page.click('#runtime-status>summary');page.click('#btn-monitor');expect(page.locator('[data-retry-load]')).to_be_visible();page.unroute('**/api/metrics');page.click('[data-retry-load]');expect(page.locator('dialog[open] .metrics')).to_be_visible();page.locator('dialog[open] [data-close]').first.click()
        for theme in ['light','dark']:
            page.evaluate('(theme)=>{document.documentElement.dataset.theme=theme;localStorage.setItem("csl.theme",theme)}',theme)
            for width in [390,768,1440]:
                page.set_viewport_size({'width':width,'height':1000});page.evaluate('document.querySelector("#btn-new").click()');page.wait_for_timeout(650)
                page.screenshot(path=str(shots/f'audit-home-{theme}-{width}.png'),animations='disabled')
                assert not page.evaluate('document.documentElement.scrollWidth>innerWidth')
        assert not errors,errors
        print(json.dumps({'pageErrors':errors,'checks':['two rounds with real tool failure','parameters and error shown','history replay after reload','steps ownership','command search','batch selection and approval POST retry','edited rule proposal executes','HTTP error retry','workbench tab draft preservation','six theme/viewport screenshots'],'data':str(tmp)},ensure_ascii=False))
        browser.close()
finally:
    child.terminate();child.wait(timeout=10);log.close();model.shutdown();model.server_close()
