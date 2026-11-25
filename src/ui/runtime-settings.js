import { icon } from './icons.js';

export function mountRuntimeSettings(host,{apiFetch,onChanged=()=>{}}){
  const life=new AbortController();let state=null,busy=false;
  host.innerHTML=`<section class="runtime-settings" id="runtime-settings"><div class="settings-section-head"><div><span class="settings-eyebrow">EXECUTION ENVIRONMENT</span><h3>执行环境</h3><p>在这里配置能力；运行监控只展示状态。</p></div>${icon('workspace',{size:26})}</div>
  <div class="runtime-options">${[['execEnabled','命令执行','按现有命令审批运行，权限仅属于当前用户。'],['sessionEnabled','持久进程','允许有界进程会话；需要同时开启命令执行。'],['desktopEnabled','本机浏览器','允许 Agent 请求在本机默认浏览器打开网站；具体 URL 仍需确认。']].map(([key,title,note])=>`<button type="button" class="runtime-toggle" data-runtime="${key}" aria-pressed="false"><span><strong>${title}</strong><small>${note}</small></span><i>关闭</i></button>`).join('')}</div>
  <div class="runtime-math" id="runtime-math"><h4>数学排版 · Tectonic</h4><p>配置离线 LaTeX 引擎，已有 PDF 生成不依赖此项。</p><label>本机可执行文件路径<input data-runtime-path placeholder="C:\\Tools\\tectonic.exe" autocomplete="off" spellcheck="false"></label><div class="runtime-actions"><button class="btn" type="button" data-runtime-test="latex">${icon('check',{size:15})}检测引擎</button><button class="btn" type="button" data-runtime-test="commands">检测命令环境</button></div></div>
  <div class="runtime-context" id="runtime-context"><h4>上下文管理</h4><p>此处是远程模型调用的软预算，须小于模型实际窗口。本地 Qwen 保留自身预算约束。</p><div class="runtime-fields"><label>上下文软预算<input type="number" data-runtime-number="contextBudget" min="2048" max="1048576" step="1024"></label><label>压缩阈值（%）<input type="number" data-runtime-ratio min="50" max="90" step="1"></label><label>保留最近消息<input type="number" data-runtime-number="keepTail" min="4" max="40"></label><label>保留最近工具结果<input type="number" data-runtime-number="microKeepRecent" min="1" max="20"></label></div></div>
  <div class="runtime-save"><button class="btn primary" data-runtime-save type="button">保存配置</button><span data-runtime-status role="status">正在读取配置…</span></div></section>`;
  const status=host.querySelector('[data-runtime-status]');
  const paint=()=>{for(const b of host.querySelectorAll('[data-runtime]')){b.setAttribute('aria-pressed',String(state[b.dataset.runtime]));b.querySelector('i').textContent=state[b.dataset.runtime]?'开启':'关闭';}for(const i of host.querySelectorAll('[data-runtime-number]'))i.value=state[i.dataset.runtimeNumber];host.querySelector('[data-runtime-ratio]').value=Math.round(state.compactRatio*100);host.querySelector('[data-runtime-path]').value=state.latexEnginePath;};
  const collect=()=>({...state,latexEnginePath:host.querySelector('[data-runtime-path]').value.trim(),compactRatio:Number(host.querySelector('[data-runtime-ratio]').value)/100,...Object.fromEntries([...host.querySelectorAll('[data-runtime-number]')].map(i=>[i.dataset.runtimeNumber,Number(i.value)]))});
  const request=async(method,body,route='/api/runtime-settings')=>{const response=await apiFetch(route,{method,signal:life.signal,...(body?{headers:{'content-type':'application/json','x-settings-request':'1'},body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.message||'配置暂不可用，请重新打开后重试。');return data;};
  host.addEventListener('click',async e=>{const b=e.target.closest('button');if(!b||busy||!state)return;
    if(b.dataset.runtime){state[b.dataset.runtime]=!state[b.dataset.runtime];const draft=collect();state=draft;paint();status.textContent='有未保存的更改。';return;}
    if(!b.hasAttribute('data-runtime-save')&&!b.dataset.runtimeTest)return;busy=true;b.disabled=true;
    try{if(b.hasAttribute('data-runtime-save')){state=await request('POST',collect());paint();status.textContent='已保存，下次任务调用生效。';onChanged(state);}else{const result=await request('POST',{kind:b.dataset.runtimeTest,latexEnginePath:host.querySelector('[data-runtime-path]').value.trim()},'/api/runtime-settings/test');status.textContent=result.message;if(result.path&&!host.querySelector('[data-runtime-path]').value)host.querySelector('[data-runtime-path]').value=result.path;}}
    catch(error){if(!life.signal.aborted)status.textContent=error.message;}finally{busy=false;b.disabled=false;}
  });
  request('GET').then(data=>{state=data;paint();status.textContent='配置保存在本机，无需修改 .env。';}).catch(error=>{status.textContent=error.message;});
  return ()=>life.abort();
}
