import { escapeHtml as esc } from '../agent/text.js';
import { icon } from './icons.js';
import { disclosureSummary } from './disclosure.js';
import { clearFormFeedback } from './form-feedback.js';
export function mountJudgeSettings(host,{apiFetch=fetch}={}) {
  const life = new AbortController();
  let state = null, busy = false;
  host.innerHTML = `<section class="search-settings-card judge-settings" id="judge-settings" aria-labelledby="judge-heading">
    <header class="judge-heading"><span class="judge-emblem">${icon('shield', { size: 23 })}</span><div><span class="configuration-eyebrow">EVIDENCE / REVIEW</span><h3 id="judge-heading">独立证据审核</h3><p>为引用多一道核对，让结论有迹可循。</p></div><span class="judge-state" data-judge-state>读取中</span></header>
    <form data-judge-form><fieldset class="judge-controls" disabled>
      <label class="judge-enable"><input type="checkbox" name="enabled" role="switch" aria-describedby="judge-privacy"><span class="judge-switch" aria-hidden="true"></span><span><strong>启用独立审核</strong><small id="judge-privacy">将带引用的句子与对应原文发送给下方裁判模型。</small></span>${icon('shield', { size: 20 })}</label>
      <section class="judge-form-section" aria-labelledby="judge-connection-heading"><div class="judge-section-title"><span>01</span><h4 id="judge-connection-heading">裁判连接</h4><p>选择与回答模型不同的模型</p></div>
        <div class="judge-fields"><label class="judge-field judge-field-wide"><span>接口地址</span><input name="baseUrl" type="url" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"><small>兼容 OpenAI 格式的 Base URL</small></label>
          <label class="judge-field"><span>裁判模型</span><input name="model" maxlength="160" placeholder="填写独立裁判的模型名称" autocomplete="off" spellcheck="false"></label>
          <label class="judge-field"><span>API Key <small data-judge-key-state>尚未读取</small></span><input name="apiKey" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空保留已保存密钥"></label></div>
      </section>
      <section class="judge-form-section" aria-labelledby="judge-budget-heading"><div class="judge-section-title"><span>02</span><h4 id="judge-budget-heading">调用预算</h4><p>控制单批审核的输出与等待时间</p></div>
        <div class="judge-fields"><label class="judge-field"><span>审核输出上限</span><span class="judge-number"><input type="number" name="maxOutputTokens" min="512" max="8192" value="4096" aria-describedby="judge-token-hint"><span aria-hidden="true">tokens</span></span><small id="judge-token-hint">512 – 8192 tokens</small></label>
          <label class="judge-field"><span>单批超时</span><span class="judge-number"><input type="number" name="timeoutSeconds" min="1" max="60" value="45" aria-describedby="judge-time-hint"><span aria-hidden="true">秒</span></span><small id="judge-time-hint">1 – 60 秒</small></label></div>
      </section>
      <details class="judge-disclosure"><summary>${icon('info', { size: 15 })}<span>审核范围与调用说明</span>${icon('chevron-down', { size: 14 })}</summary><p>默认关闭。每次回答最多增加两批审核调用，结论复查另行记录用量。同名模型不会作为独立裁判。模型审核是近似判断，不构成事实证明。</p></details>
    </fieldset><footer class="judge-actions"><button type="submit" class="btn primary" disabled>${icon('check', { size: 16 })}<span>保存审核配置</span></button><button type="button" class="btn" data-judge-refresh>${icon('refresh', { size: 15 })}<span>重新读取</span></button><span class="judge-save-note">密钥在本机加密保存</span></footer></form>
    <p data-judge-status role="status" aria-live="polite" class="judge-feedback">正在读取配置…</p>
  </section>`;
  const form = host.querySelector('form'), status = host.querySelector('[data-judge-status]');
  const controls = form.querySelector('fieldset'), submit = form.querySelector('[type=submit]');
  const refresh = form.querySelector('[data-judge-refresh]'), badge = host.querySelector('[data-judge-state]');
  const feedback = (message, tone = '') => { if (!life.signal.aborted) { status.textContent = message; status.dataset.tone = tone; } };
  const setBusy = value => {
    busy = value;
    form.setAttribute('aria-busy', String(value));
    controls.disabled = value || !state;
    submit.disabled = value || !state;
    refresh.disabled = value;
  };
  const paint = () => {
    form.elements.enabled.checked = state.enabled === true;
    form.elements.baseUrl.value = state.baseUrl || '';
    form.elements.model.value = state.model || '';
    form.elements.apiKey.value = '';
    form.elements.maxOutputTokens.value = state.maxOutputTokens || 4096;
    form.elements.timeoutSeconds.value = (state.timeoutMs || 45000) / 1000;
    clearFormFeedback(form);
    host.querySelector('[data-judge-key-state]').textContent = state.hasKey ? '已加密保存' : '尚未保存';
    badge.textContent = state.enabled ? '审核已开启' : '审核已关闭';
    badge.dataset.tone = state.enabled ? 'ready' : '';
  };
  const load = async () => {
    if (busy || life.signal.aborted) return;
    setBusy(true); feedback('正在读取配置…');
    try {
      const response = await apiFetch('/api/knowledge/judge', { signal: life.signal });
      if (!response.ok) throw new Error('审核配置读取失败，请重新读取。');
      const next = await response.json();
      if (life.signal.aborted) return;
      state = next; paint();
      feedback(state.enabled ? '已开启；审核结果与用量会随任务记录。' : `审核已关闭${state.hasKey ? ' · 密钥已保存，留空即可保留。' : '，可先填写并保存连接配置。'}`);
    } catch (error) { feedback(error.message, 'error'); }
    finally { setBusy(false); }
  };
  form.addEventListener('input', () => {
    if (busy || !state) return;
    badge.textContent = '有未保存更改'; badge.dataset.tone = 'draft';
    feedback('更改尚未保存；保存后用于后续审核。');
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!state || busy || life.signal.aborted) return;
    const body = { revision: state.revision, enabled: form.elements.enabled.checked,
      baseUrl: form.elements.baseUrl.value.trim(), model: form.elements.model.value.trim(),
      apiKey: form.elements.apiKey.value.trim(), maxOutputTokens: Number(form.elements.maxOutputTokens.value),
      timeoutMs: Number(form.elements.timeoutSeconds.value) * 1000 };
    setBusy(true); feedback('正在保存审核配置…');
    try {
      const response = await apiFetch('/api/knowledge/judge', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-settings-request': '1' }, signal: life.signal, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || data.error || '保存失败，请重试。');
      if (life.signal.aborted) return;
      state = data; paint(); feedback('审核配置已保存。实际审核结果与用量会随任务记录。', 'success');
    } catch (error) { feedback(error.message, 'error'); }
    finally { setBusy(false); }
  });
  refresh.addEventListener('click', load);
  load();
  return () => { life.abort(); form.elements.apiKey.value = ''; };
}
export function renderSupportReview(result) {
  if(!result.support?.length && !result.supportSummary)return '';
  const labels={supported:'模型认为支持',unsupported:'依据不足',uncertain:'尚不确定',unchecked:'未独立审核',conflict:'存在冲突',contradicted:'原文与结论冲突',invalid_reference:'引用无效',uncited:'缺少引用',unassessed:'未独立审核',withheld:'风险内容已隔离'};
  const issues=(result.support || []).filter(row=>row.verdict!=='supported');
  return `<details class="support-review result-disclosure">${disclosureSummary('逐句证据审核', { symbol: 'shield', meta: issues.length ? `${issues.length} 句待核对` : '查看结果' })}<div class="disclosure-body"><p>自动审核是近似判断，不构成事实证明。${result.supportSummary?.reason ? esc(({judge_not_configured:'尚未配置裁判',judge_not_independent:'裁判与回答模型相同，未执行独立审核',model_opinion_not_proof:'模型意见不构成证明',invalid_judge_response:'裁判返回格式无效',judge_timeout_or_cancelled:'审核超时或已取消',judge_unavailable:'裁判暂不可用',judge_output_limit:'审核达到输出上限，本次未给出判定，可在设置中调整审核预算',no_safe_cited_statements:'没有可安全核对的带引用句子'})[result.supportSummary.reason] || '此次审核未完成') : ''}</p>${(result.support || []).map(row=>`<div class="support-statement"><strong>${esc(labels[row.verdict] || '未独立审核')}</strong><p>${esc(row.sentence)}</p><small>${esc(row.reason || '')}</small></div>`).join('')}</div></details>`;
}

export function decorateSupport(answer, support=[]) {
  const normalize=text=>String(text).replace(/\[\[[^\]]+\]\]|[*_`#>]/g,'').replace(/^\s*[-\d.、]+\s*/,'').replace(/\s+/g,'');
  for(const row of support.filter(item=>['unsupported','contradicted'].includes(item.verdict))) {
    const text=normalize(row.sentence);if(text.length<6)continue;
    const paragraph=[...answer.querySelectorAll('p,li,blockquote')].find(node=>normalize(node.textContent).includes(text));
    if(!paragraph || paragraph.querySelector('.support-warning'))continue;
    const badge=document.createElement('small');badge.className='support-warning';badge.textContent=row.verdict==='contradicted'?'与原文冲突':'依据不足';badge.title='独立模型审核意见，可展开逐句证据审核核对；并非形式证明。';paragraph.append(badge);
  }
}
