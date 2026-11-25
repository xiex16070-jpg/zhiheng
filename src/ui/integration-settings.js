import { icon } from './icons.js';
import { escapeHtml as esc } from '../agent/text.js';

function preflightMarkup(report) {
  const issueList = issues => issues.length ? `<ul class="preflight-issues">${issues.map(issue => {
    const label = { error: '问题', warning: '注意', info: '说明' }[issue.level] || '说明';
    return `<li><strong>${label}</strong> ${esc(issue.message)}</li>`;
  }).join('')}</ul>` : '';
  const resourceList = resources => resources.map(group => `<details class="preflight-files">
    <summary><code>${esc(group.directory)}/</code> · 已发现 ${esc(group.count)} 个文件${group.truncated || group.sample.length < group.count ? '（部分列出）' : ''}</summary>
    <ul>${group.sample.map(file => `<li><code>${esc(file)}</code></li>`).join('')}</ul></details>`).join('');
  return `<h5>预检结果</h5><p>${report.kind === 'plugin' ? '插件清单' : '技能包'} · <code>${esc(report.path)}</code></p>
    ${issueList(report.issues)}${report.skills.map(skill => `<article><strong>${esc(skill.name || skill.path)}</strong>
      <p>${skill.standardValid ? '标准头部通过' : '标准头部有问题'} · 描述 ${esc(skill.descriptionLength)} 字符</p>
      ${issueList(skill.issues)}${resourceList(skill.resources)}</article>`).join('')}`;
}

export function mountIntegrationSettings(host, { apiFetch = fetch, onExtensionsChanged = () => {} } = {}) {
  host.innerHTML = `<section class="search-settings-card integration-suite" id="integration-settings" aria-labelledby="integration-title">
    <header class="search-settings-heading"><span class="search-settings-emblem">${icon('learning',{size:22})}</span><div><span class="search-settings-eyebrow">RESEARCH / CONNECTIONS</span><h3 id="integration-title">研究能力实验室</h3><p>按需连接文献、视觉与流程，把能力收进你的工作台。</p></div></header>
    <nav class="integration-nav" aria-label="集成配置分类"><button type="button" data-panel="zotero" aria-pressed="true">文献库<span>01</span></button><button type="button" data-panel="image" aria-pressed="false">图像生成<span>02</span></button><button type="button" data-panel="packs" aria-pressed="false">插件包<span>03</span></button></nav>
    <div data-integration-panel="zotero"><div class="integration-section-heading"><div><span class="integration-kicker">LOCAL LIBRARY</span><h4>Zotero</h4></div><span class="integration-state" id="zotero-state">未连接</span></div>
      <p class="search-settings-note">从本机 Zotero 检索条目、集合和标签，将选定条目导出为 BibTeX。不会修改你的文献库。</p>
      <label class="integration-toggle"><input id="zotero-enabled" type="checkbox"><span><strong>允许访问本机 Zotero</strong><small>需启动 Zotero，并在设置中开放本地 API。</small></span></label>
      <label class="extension-field">本地 API 授权密钥（可选）<input id="zotero-key" type="password" maxlength="2048" autocomplete="new-password" placeholder="Zotero 10+ 如要求授权，可在此填写"></label>
      <div class="search-settings-actions"><button class="btn search-save" type="button" id="zotero-save">${icon('check',{size:14})}保存配置</button><button class="btn" type="button" id="zotero-test">${icon('activity',{size:14})}检测本机服务</button></div>
    </div>
    <div data-integration-panel="image" hidden><div class="integration-section-heading"><div><span class="integration-kicker">IMAGE STUDIO</span><h4>独立的图像接口</h4></div><span class="integration-state" id="image-state">未配置</span></div>
      <p class="search-settings-note">单独保存图像模型与凭据，可和对话模型共用地址。每次生成前均需审批提示词外发与费用。</p>
      <label class="integration-toggle"><input id="image-enabled" type="checkbox"><span><strong>启用图像生成</strong><small>兼容 images/generations，需支持 b64_json 返回。</small></span></label>
      <div class="integration-fields"><label class="extension-field">接口地址<input id="image-base" placeholder="https://images.example.com/v1" spellcheck="false" maxlength="512"></label><label class="extension-field">模型名称<input id="image-model" placeholder="填写服务支持的图像模型" maxlength="160" spellcheck="false"></label></div>
      <label class="extension-field">图像服务 API Key<input id="image-key" type="password" autocomplete="new-password" maxlength="1024" placeholder="独立加密保存，不使用对话密钥"></label>
      <div class="search-settings-actions"><button class="btn search-save" type="button" id="image-save">${icon('check',{size:14})}保存图像接口</button><button class="search-remove" type="button" id="image-remove" hidden>移除图像配置</button></div>
      <p class="search-settings-note">保存不会发起收费生成。首次实际生成的产物会留在当前工作区。</p>
    </div>
    <div data-integration-panel="packs" hidden><div class="integration-section-heading"><div><span class="integration-kicker">PERSONAL WORKFLOWS</span><h4>我的插件包</h4></div><span class="integration-state" id="pack-count">0 个</span></div>
      <p class="search-settings-note" id="pack-path-hint">填写当前工作区内的技能目录、SKILL.md 或 plugin.json。预检核对技能说明和附属文件目录。安装需提供 plugin.json，MCP 连接需单独确认。</p>
      <div class="integration-install"><label class="extension-field">工作区相对路径<input id="pack-path" maxlength="240" spellcheck="false" aria-describedby="pack-path-hint" placeholder="skills/research/SKILL.md"></label>
        <button class="btn search-save" id="pack-preflight" type="button" disabled>${icon('eye',{size:15})}只读预检</button><button class="btn" id="pack-install" type="button" disabled>${icon('plus',{size:15})}安装插件包</button></div>
      <div id="pack-progress" role="status" aria-live="polite"></div>
      <section class="pack-preflight" id="pack-report" aria-label="预检详情" hidden></section>
      <div class="integration-pack-list" id="integration-pack-list"></div>
    </div><div class="integration-behavior"><label class="integration-toggle"><input id="followups-enabled" type="checkbox" checked><span><strong>研究跟进建议</strong><small>回答后提供少量下一步问题；点击只填入输入框，由你决定是否发送。</small></span></label></div><div class="search-settings-feedback" id="integration-feedback" role="status" aria-live="polite">正在读取连接配置…</div>
  </section>`;
  const $=s=>host.querySelector(s), life=new AbortController(); let closed=false,busy=false,state,models,packs=[];
  const feedback=(message,error=false)=>{if(closed)return;$('#integration-feedback').textContent=message;$('#integration-feedback').dataset.tone=error?'error':'success';};
  function updatePackActions() {
    const path = $('#pack-path').value.trim();
    $('#pack-preflight').disabled = busy || !path;
    $('#pack-install').disabled = busy || !/(?:^|[\\/])plugin\.json$/i.test(path);
  }
  async function request(url, method='GET', body) {
    const r=await apiFetch(url,{method,signal:AbortSignal.any([life.signal,AbortSignal.timeout(50000)]),headers:body?{'content-type':'application/json','x-settings-request':'1'}:{},...(body?{body:JSON.stringify(body)}:{})});
    const data=await r.json();if(!r.ok)throw new Error(data.message||'配置暂不可用');return data;
  }
  function paintPacks(){
    $('#pack-count').textContent=`${packs.length} 个`;
    $('#integration-pack-list').innerHTML=packs.map(p=>`<article class="integration-pack" data-pack="${esc(p.id)}"><div class="integration-pack-title"><strong>${esc(p.name)}</strong><span>v${esc(p.version)}</span><button type="button" class="search-remove" data-pack-remove>移除</button></div><p>${esc(p.description)}</p><div class="integration-tags">${p.skills.map(s=>`<span>${esc(s)}</span>`).join('')||'<span>仅 MCP 配置</span>'}</div>${p.mcpServers.map(s=>`<div class="integration-mcp-draft"><span><strong>${esc(s.name)}</strong><small>${esc(s.kind)} · ${esc(s.target)}</small></span><button class="btn" type="button" data-connect="${s.index}">连接并检查</button></div>`).join('')}${p.mcpServers.length?'<p class="search-settings-note">连接本地进程会启动清单指定的程序；连接后还需在上方插件权限中启用工具。</p>':''}</article>`).join('')||'<div class="integration-empty">把可信流程整理成一个包，<br>在不同研究任务中重复使用。</div>';
  }
  async function refresh(){
    const results=await Promise.all([request('/api/settings/integrations'),request('/api/settings/models'),request('/api/settings/plugin-packs')]);
    if(closed)return;[state,models]=results;packs=results[2].packs;
    $('#zotero-enabled').checked=state.zoteroEnabled;$('#zotero-state').textContent=state.zoteroEnabled?'已启用 · 待检测':'已关闭';
    $('#zotero-key').placeholder=state.zoteroKeyConfigured?'已加密保存；留空保留':'Zotero 10+ 如要求授权，可在此填写';
    const p=models.activeImage;$('#image-enabled').checked=p?.enabled===true;$('#image-base').value=p?.baseUrl||'';$('#image-model').value=p?.model||'';
    $('#image-state').textContent=p?.enabled?'已配置':p?'已停用':'未配置';$('#image-key').placeholder=p?.configured?'已加密保存；留空保留':'独立加密保存，不使用对话密钥';$('#image-remove').hidden=!p;
    paintPacks();feedback('配置保存在本机。能力启用后，下一次任务会读取最新设置。');
  }
  async function act(fn){
    if(busy||closed)return;busy=true;host.setAttribute('aria-busy','true');for(const b of host.querySelectorAll('button,input[type=checkbox]'))b.disabled=true;
    try{await fn();}catch(e){feedback(e.message,true);}finally{busy=false;if(!closed){host.removeAttribute('aria-busy');for(const b of host.querySelectorAll('button,input[type=checkbox]'))b.disabled=false;updatePackActions();}}
  }
  for(const b of host.querySelectorAll('[data-panel]'))b.addEventListener('click',()=>{for(const x of host.querySelectorAll('[data-panel]'))x.setAttribute('aria-pressed',String(x===b));for(const x of host.querySelectorAll('[data-integration-panel]'))x.hidden=x.dataset.integrationPanel!==b.dataset.panel;});
  $('#zotero-save').addEventListener('click',()=>act(async()=>{if(!state)throw new Error('请先重新打开设置。');state=await request('/api/settings/integrations','POST',{revision:state.revision,zoteroEnabled:$('#zotero-enabled').checked,zoteroLocalApiKey:$('#zotero-key').value.trim()});$('#zotero-key').value='';await refresh();feedback('已保存 Zotero 访问设置。');}));
  $('#zotero-test').addEventListener('click',()=>act(async()=>{const r=await request('/api/settings/integrations/test-zotero','POST',{});$('#zotero-state').textContent=r.available?'连接就绪':'尚未就绪';feedback(r.available?'Zotero 本地 API 已响应。':r.reason,!r.available);}));
  $('#image-save').addEventListener('click',()=>act(async()=>{if(!models)throw new Error('请先重新打开设置。');await request('/api/settings/models','POST',{revision:models.revision,capability:'image',enabled:$('#image-enabled').checked,baseUrl:$('#image-base').value.trim(),model:$('#image-model').value.trim(),apiKey:$('#image-key').value.trim(),preset:'image-custom'});$('#image-key').value='';await refresh();feedback('图像接口已独立保存，对话模型保持当前选择。');}));
  $('#image-remove').addEventListener('click',()=>act(async()=>{await request('/api/settings/models','DELETE',{revision:models.revision,savedKeyId:models.activeImage.id});await refresh();feedback('图像接口已移除。');}));
  const pathField = $('#pack-path'), reportPanel = $('#pack-report'), progress = $('#pack-progress');
  pathField.addEventListener('input', () => {
    reportPanel.hidden = true;
    reportPanel.replaceChildren();
    progress.textContent = '';
    updatePackActions();
  });
  $('#pack-preflight').addEventListener('click', () => act(async () => {
    const path = pathField.value.trim();
    pathField.readOnly = true;
    reportPanel.hidden = true;
    progress.textContent = '正在检查技能包…';
    try {
      const report = await request('/api/settings/plugin-packs/preflight', 'POST', { path });
      if (closed) return;
      reportPanel.innerHTML = preflightMarkup(report);
      reportPanel.hidden = false;
      progress.textContent = `预检完成，找到 ${report.skills.length} 个技能。`;
    } catch (error) {
      if (!closed) progress.textContent = `预检未完成：${error.message}`;
    } finally {
      pathField.readOnly = false;
    }
  }));
  $('#pack-install').addEventListener('click',()=>act(async()=>{const r=await request('/api/settings/plugin-packs','POST',{path:$('#pack-path').value.trim()});packs=r.packs;paintPacks();feedback(r.message);}));
  $('#integration-pack-list').addEventListener('click',e=>{const b=e.target.closest('[data-pack-remove],[data-connect]');if(!b)return;const id=b.closest('[data-pack]').dataset.pack;act(async()=>{const connect=b.hasAttribute('data-connect');const r=await request('/api/settings/plugin-packs'+(connect?'/connect':''),connect?'POST':'DELETE',connect?{id,index:Number(b.dataset.connect)}:{id});packs=r.packs;paintPacks();onExtensionsChanged();feedback(r.message);});});
  $('#followups-enabled').addEventListener('change',()=>act(async()=>{const checkbox=$('#followups-enabled'),wanted=checkbox.checked;try{const r=await request('/api/preferences','POST',{preferences:{followups:wanted}});checkbox.checked=r.preferences.followups!==false;feedback(wanted?'研究跟进建议已开启。':'研究跟进建议已关闭。');}catch(e){checkbox.checked=!wanted;throw e;}}));
  request('/api/bootstrap').then(r=>{if(!closed)$('#followups-enabled').checked=r.preferences?.followups!==false;}).catch(()=>{});
  refresh().catch(e=>feedback(e.message,true));
  return()=>{closed=true;life.abort();$('#image-key').value='';$('#zotero-key').value='';};
}

export async function renderSkillEffectiveness(host, apiFetch=fetch){
  host.innerHTML='<div class="mon-empty">正在读取技能样本…</div>';
  try{
    const r=await apiFetch('/api/learn/effectiveness');const data=await r.json();if(!r.ok)throw new Error('技能样本暂不可用');if(!host.isConnected)return;
    const used=data.skills.filter(s=>s.use_count>0),review=used.filter(s=>s.recommendation==='review');
    host.innerHTML=`<section class="skill-effectiveness"><header class="integration-section-heading"><div><span class="integration-kicker">LEARNING / EVIDENCE</span><h3>让经验接受检验</h3></div><span class="integration-state">${Number(data.tasks)} 次任务</span></header><p class="search-settings-note">${esc(data.note)}</p><div class="skill-effect-summary"><span><strong>${used.length}</strong>已使用技能</span><span><strong>${review.length}</strong>建议复核</span><span><strong>${data.window}</strong>样本保留上限</span></div>${used.length?`<div class="skill-effect-table"><div class="skill-effect-head"><span>技能</span><span>使用 / 完成</span><span>任务失败率</span></div>${used.map(s=>`<div class="skill-effect-row"><span><strong>${esc(s.name)}</strong><small>${esc(s.description||'')}${s.recommendation==='review'?' · 建议人工复核':''}</small></span><span>${s.use_count} / ${s.completed_tasks}</span><span>${s.failure_rate===null?'—':Math.round(s.failure_rate*100)+'%'}<small>${s.evidence==='insufficient'?'样本不足':'观察性关联'}</small></span></div>`).join('')}</div>`:'<div class="integration-empty">还没有已关联的任务样本。<br>后续实际使用的技能会出现在这里。</div>'}</section>`;
  }catch(e){host.textContent=e.message;}
}
