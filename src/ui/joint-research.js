import { icon } from './icons.js';
import { escapeHtml } from '../agent/text.js';

export function jointControlsMarkup() {
  return `<section class="joint-card" aria-labelledby="joint-heading" id="joint-settings">
    <header class="joint-heading"><div class="joint-emblem" aria-hidden="true">${icon('inference', { size: 24 })}</div>
      <div><span class="joint-eyebrow">EVIDENCE / RESEARCH</span><h2 id="joint-heading">联合研究</h2><p>让本地知识与外部研究相互参照</p></div>
      <label class="joint-toggle" title="开启联合研究"><input type="checkbox" role="switch" name="jointResearch" id="joint-enabled" aria-label="联合研究" aria-describedby="joint-privacy" disabled><span class="pref-switch" aria-hidden="true"></span></label>
    </header>
    <p class="joint-privacy" id="joint-privacy">开启后按本次问题联网检索，不附带上传文档原文或历史对话。</p>
    <fieldset id="joint-controls" disabled><legend class="sr-only">联合研究配置</legend>
      <div class="joint-balance"><div>${icon('book', { size: 16 })}<span>本地知识库</span><strong id="joint-local-value">70<span>%</span></strong></div>
        <span class="joint-balance-mark" aria-hidden="true">／</span>
        <div>${icon('external', { size: 16 })}<span>权威外部来源</span><strong id="joint-external-value">30<span>%</span></strong></div></div>
      <label class="sr-only" for="joint-weight">本地证据目标占比</label>
      <input class="joint-slider" id="joint-weight" name="localWeight" type="range" min="10" max="90" step="10" value="70" aria-describedby="joint-weight-help">
      <div class="joint-presets" role="group" aria-label="证据比例预设">
        <button type="button" data-joint-weight="70">本地优先<small>70 / 30</small></button>
        <button type="button" data-joint-weight="50">均衡参考<small>50 / 50</small></button>
        <button type="button" data-joint-weight="30">外部优先<small>30 / 70</small></button>
      </div>
      <p class="joint-caption" id="joint-weight-help">比例用于选择相关证据，不代表可信度。实际数量随可用资料调整。</p>
      <fieldset class="joint-focus"><legend>外部研究范围</legend><div class="joint-focus-options">
        ${[['mixed', '综合研究'], ['academic', '学术论文'], ['official', '政府与机构'], ['technical', '技术与标准']].map(([value, text]) => `<label><input type="radio" name="authorityFocus" value="${value}"><span>${text}</span></label>`).join('')}
      </div></fieldset>
      <label class="joint-preprints"><input name="includePreprints" type="checkbox" checked><span>纳入预印本</span><small>单独标注，评审状态不作推定</small></label>
    </fieldset>
    <div class="joint-availability" id="joint-availability"></div>
    <details class="joint-policy"><summary>来源与核验原则 ${icon('chevron-down', { size: 12 })}</summary>
      <p>优先官方机构、学术出版与技术标准。论文通过 OpenAlex、Europe PMC、arXiv 检索；官方网站需已配置网页搜索。付费全文无法读取时，只使用实际取得的摘要。</p>
      <p>按论文标识和标题去重，标记预印本、日期与内容范围。关键结论要求多源对照，证据不足或相互冲突时明确说明。来源数量不等于结论已核实。</p>
    </details>
    <span id="joint-save-status" class="joint-save-status" role="status" aria-live="polite"></span>
  </section>`;
}

export function paintJointWeight(host, weight) {
  host.querySelector('#joint-local-value').innerHTML = `${weight}<span>%</span>`;
  host.querySelector('#joint-external-value').innerHTML = `${100 - weight}<span>%</span>`;
  const input = host.querySelector('#joint-weight');
  input.value = weight;
  input.style.setProperty('--local-share', `${(weight - 10) / 80 * 100}%`);
  input.setAttribute('aria-valuetext', `本地 ${weight}%，外部 ${100 - weight}%`);
  for (const button of host.querySelectorAll('[data-joint-weight]')) button.setAttribute('aria-pressed', String(Number(button.dataset.jointWeight) === weight));
}

export function paintJointControls(host, preferences, { ready, capabilities, status }) {
  const enabled = preferences?.jointResearch === true;
  const toggle = host.querySelector('#joint-enabled');
  toggle.disabled = !ready;
  toggle.checked = enabled;
  host.querySelector('.joint-card').dataset.enabled = String(enabled);
  host.querySelector('#joint-controls').disabled = !ready || !enabled;
  paintJointWeight(host, Number(preferences?.localWeight) || 70);
  const focus = preferences?.authorityFocus || 'mixed';
  for (const input of host.querySelectorAll('[name=authorityFocus]')) input.checked = input.value === focus;
  host.querySelector('[name=includePreprints]').checked = preferences?.includePreprints !== false;
  const availability = host.querySelector('#joint-availability');
  availability.textContent = capabilities
    ? `${capabilities.academic ? '学术接口已启用' : '学术接口未启用'} · ${capabilities.websites ? '网站搜索已配置' : '网站搜索未配置'}${focus === 'official' && !capabilities.websites ? '，当前无法检索政府与机构报告' : ''}`
    : '正在读取来源配置';
  const message = host.querySelector('#joint-save-status');
  message.dataset.kind = status.kind;
  const text = status.kind === 'error' ? status.message || '设置未能保存，请重试' : status.kind === 'saving' ? '正在保存…' : status.kind === 'saved' ? '已保存，后续提问生效' : '';
  if (message.textContent !== text) message.textContent = text;
}

export function authorityLabel(source) {
  const a = source?.authority;
  if (!a) return '';
  const label = { preprint: '预印本', academic: '学术研究', official: '官方机构', technical: '技术标准', reference: '参考资料', news: '新闻报道' }[a.type] || '外部研究';
  return `${label} · ${a.evidenceLevel === 'abstract' ? '摘要' : '网页摘录'} · ${a.publishedAt || '日期未提供'}`;
}

export function appendJointReport(container, report) {
  if (!report?.enabled) return;
  const section = document.createElement('details');
  section.className = 'joint-result';
  const local = Number(report.counts?.local) || 0, external = Number(report.counts?.external) || 0;
  const audit = report.audit || {};
  const partial = !external || report.status === 'partial';
  section.innerHTML = `<summary>${icon('inference', { size: 16 })}<strong>联合研究</strong><span>本地 ${local} · 外部 ${external}</span><span class="joint-result-state">${!external ? '仅本地资料' : partial ? '部分来源可用' : '已选取证据'}</span>${icon('chevron-down', { size: 13 })}</summary>
    <div class="joint-result-body"><p>目标占比 ${Number(report.requested?.local) || 70}% / ${Number(report.requested?.external) || 30}%。回答实际引用本地 ${Number(audit.localCited) || 0} 条、外部 ${Number(audit.externalCited) || 0} 条。</p>
    <p>${(Number(audit.distinctExternalWorks) || 0) < 2 ? '尚未取得至少两项不同外部研究的引用，不能视为独立交叉验证。' : `引用了 ${Number(audit.distinctExternalWorks)} 项外部资料，仍需核验研究独立性与结论一致性。`}</p>
    <ul>${(report.providers || []).map(p => `<li><span>${escapeHtml(p.name)}</span><span>${escapeHtml({ ok: '已取得材料', empty: '无合适材料', unavailable: '暂不可用', unconfigured: '未配置', disabled: '未启用' }[p.status] || '未知')} · ${Number(p.count) || 0}${p.reason?.startsWith('HTTP ') ? ' · ' + escapeHtml(p.reason) : ''}${p.hint ? `<small class="joint-provider-hint">${escapeHtml(p.hint)}${Number(p.retryAfter) > 0 ? ` 等待约 ${Number(p.retryAfter)} 秒。` : ''}</small>` : ''}</span></li>`).join('')}</ul>
    <p class="joint-caption">来源筛选和引用定位已执行，未自动验证每项结论的语义支持关系。</p></div>`;
  container.append(section);
}
