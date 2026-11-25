"""Run Lighthouse against an isolated workbench, never a user's live session."""
import json,os,subprocess,tempfile,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[1];tmp=Path(tempfile.mkdtemp(prefix='zh-accessibility-'))
env=os.environ.copy()
for line in (root/'.env').read_text(encoding='utf-8').splitlines() if (root/'.env').exists() else []:
    if '=' in line and not line.lstrip().startswith('#'):env[line.split('=',1)[0].strip()]=''
(tmp/'papers.jsonl').write_text('',encoding='utf-8')
env.update(PORT='0',HOST='127.0.0.1',DATA_DIR=str(tmp),STORE_FILE=str(tmp/'store.json'),KB_FILE=str(tmp/'kb.json'),VECTOR_FILE=str(tmp/'vector.json'),CORPUS_JSONL=str(tmp/'papers.jsonl'),MYSQL_ENABLED='0',REDIS_ENABLED='0',EMBEDDING_PROVIDER='off',LEARNING_ENABLED='0',INFERENCE_AUDIT='0',AUTH_SECRET='synthetic-accessibility',NO_PROXY='127.0.0.1,localhost')
for candidate in ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']:
    if Path(candidate).exists():env['CHROME_PATH']=candidate;break
flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
log=(tmp/'server.log').open('w',encoding='utf-8');child=subprocess.Popen(['node','server.mjs'],cwd=root,env=env,stdout=log,stderr=log,creationflags=flags)
try:
    deadline=time.monotonic()+30
    while True:
        try:
            base='http://127.0.0.1:'+(tmp/'.server-port').read_text().strip()
            if json.load(urllib.request.build_opener(urllib.request.ProxyHandler({})).open(base+'/api/health',timeout=1))['ready']:break
        except Exception:pass
        if time.monotonic()>deadline:raise RuntimeError('isolated startup timed out')
        time.sleep(.05)
    output=root/'.shots/audit-lighthouse.json';output.parent.mkdir(exist_ok=True)
    subprocess.run(['npx.cmd' if os.name=='nt' else 'npx','--yes','lighthouse@13.6.0',base,'--only-categories=accessibility','--output=json','--output-path='+str(output),'--chrome-flags=--headless --no-sandbox','--quiet'],cwd=root,env=env,check=True,creationflags=flags,timeout=180)
    result=json.loads(output.read_text(encoding='utf-8'))
    print(json.dumps({'score':result['categories']['accessibility']['score'],'failures':[{ 'id':k,'title':v['title'],'details':v.get('details',{})} for k,v in result['audits'].items() if v.get('score')==0]},ensure_ascii=False))
finally:child.terminate();child.wait(timeout=10);log.close()
