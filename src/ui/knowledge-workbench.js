import { activateWorkbenchPanel, showWorkbenchPanel } from './workbench-panels.js';
import { icon } from './icons.js';
import { escapeHtml as esc } from '../agent/text.js';

const labels = { candidate: '待核对', verified: '对话已确认', invalidated: '已暂停使用', withdrawn: '已撤回', quarantined: '风险隔离' };
const semantic = { pending: '待语义复查', supported: '模型认为有支持', unsupported: '模型认为支持不足', uncertain: '模型无法确认', injection: '潜在注入风险', conflict: '与同源结论冲突' };
const reasonLabels = { source_changed: '原文版本已变化', source_removed: '原文已移除', dialogue_unavailable_or_changed: '原对话已删除或改写', sources_current: '关联原文版本有效', awaiting_check: '等待回源检查', user_released_quarantine: '已解除隔离，等待回源核对' };
const date = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '尚未复查';

/** Independently mounted library section. No mutable model text is injected as HTML. */
export function openKnowledgeWorkbench({ apiFetch = fetch, onImport, onResearch, onSource, initialTab } = {}) {
  // Ordinary reopening preserves the current tab and draft filters. Explicit
  // destinations from capability navigation also work on an existing dock.
  const destination = ['documents', 'conclusions'].includes(initialTab) ? initialTab : null;
  const selectExistingTab = () => {
    if (!destination) return;
    const button = document.querySelector(`dialog.knowledge-mask [data-page="${destination}"]`);
    button?.click();
    button?.focus({ preventScroll: true });
  };
  if (activateWorkbenchPanel('knowledge')) { selectExistingTab(); return; }
  const existing = document.querySelector('dialog.knowledge-mask[open]');
  if (existing) { if (destination) selectExistingTab(); else existing.querySelector('[data-close]').focus(); return; }
  const dialog = document.createElement('dialog'); dialog.className = 'modal-mask knowledge-mask';
  dialog.innerHTML = `<section class="modal knowledge-workbench">
    <header class="modal-head knowledge-masthead"><div class="knowledge-mark">${icon('layers', { size: 27 })}</div><div><span class="knowledge-eyebrow">KNOWLEDGE / EVIDENCE</span><h2>知识库工作台</h2><p>资料在此汇合，结论始终可追溯。</p></div><button type="button" data-close aria-label="关闭知识库工作台">${icon('close')}</button></header>
    <div class="knowledge-shell"><nav class="knowledge-nav" aria-label="知识库分区"><button type="button" data-page="documents" aria-pressed="false">${icon('folder')}<span>资料<small>原始文档与分区</small></span><b data-doc-count>—</b></button><button type="button" data-page="conclusions" aria-pressed="false">${icon('shield')}<span>验证结论<small>对话沉淀与回源核对</small></span><b data-conclusion-count>—</b></button><div class="knowledge-nav-note">${icon('branch', { size: 20 })}<strong>保留推理的来路</strong><p>候选不会成为事实。已确认结论也只帮助定位原文，引用仍来自有效的原始资料。</p></div></nav>
    <div class="knowledge-main"><div class="knowledge-toolbar"><label class="knowledge-search">${icon('search', { size: 16 })}<input type="search" aria-label="查找资料或结论" placeholder="查找资料或结论"></label><button type="button" class="btn tiny" data-knowledge-refresh>${icon('refresh', { size: 15 })}刷新</button><button type="button" class="btn primary" data-knowledge-import>${icon('upload', { size: 15 })}导入资料</button></div><p class="knowledge-status" role="status" aria-live="polite">正在读取知识库…</p><div class="knowledge-body"></div></div></div></section>`;
  let state = null, tab = initialTab === 'conclusions' ? 'conclusions' : 'documents', status = '', generation = 0;
  const life = new AbortController(), body = dialog.querySelector('.knowledge-body'), statusNode = dialog.querySelector('.knowledge-status');
  const close = showWorkbenchPanel(dialog,'knowledge');
  dialog.querySelector('[data-knowledge-import]').hidden = !onImport;

  function sourceMarkup(source) {
    return `<li><div><strong>${esc(source.docName || '原始文档')}</strong><code title="引用片段版本">${esc(source.sourceVersion.slice(0, 12))}</code></div><blockquote>${esc(source.quote)}</blockquote>${onSource ? `<button type="button" class="btn tiny" data-source="${esc(source.ref)}">${icon('eye', { size: 14 })}阅读原文</button>` : ''}</li>`;
  }
  function card(entry) {
    const active = !['withdrawn', 'quarantined'].includes(entry.status);
    // A verified entry the model now disputes goes back through the same human check.
    const recheckable = active && (entry.status !== 'verified' || Boolean(entry.attention));
    const attention = entry.attention ? `<p class="knowledge-attention" role="status">${icon('shield', { size: 13 })}${entry.attention.reason === 'model_conflict' ? '模型认为它与引用同一原文的其他结论冲突' : '模型对你的确认有异议'}：请展开原文复核后重新确认或撤回。人工确认仍然有效。</p>` : '';
    const related = entry.related?.length ? `<p class="knowledge-related">另有 ${entry.related.length} 条结论引用同一原文，可对照检查是否矛盾。</p>` : '';
    return `<article class="knowledge-conclusion" data-entry="${esc(entry.id)}"><div class="knowledge-card-top"><span class="knowledge-state is-${esc(entry.status)}">${icon(entry.status === 'verified' ? 'check' : entry.status === 'quarantined' ? 'shield' : 'clock', { size: 13 })}${labels[entry.status]}</span><time>${esc(date(entry.createdAt))}</time></div><h3>${esc(entry.claim)}</h3>${attention}${related}
      <div class="knowledge-proof-status"><span>${icon('document', { size: 13 })}${esc(reasonLabels[entry.sourceCheck?.reason] || (entry.sourceCheck?.status === 'current' ? '原文版本有效' : '需要回源核对'))}</span><span>${icon('spark', { size: 13 })}${semantic[entry.semanticCheck?.status] || '待语义复查'}</span></div>
      <details class="knowledge-source-details"><summary>${entry.sources.length} 个关联原文片段 ${icon('chevron-down', { size: 14 })}</summary><ol>${entry.sources.map(sourceMarkup).join('')}</ol><p>以上是关联片段，不代表结论的每个断言都已被支持。请核对适用条件、推断步骤和反例。</p>${recheckable ? `<label class="knowledge-ack"><input type="checkbox" data-ack="${esc(entry.id)}"><span>我已核对原文与这条结论的适用范围</span></label>` : ''}</details>
      <footer>${recheckable ? `<button type="button" class="btn primary tiny" data-action="verify" disabled>${entry.status === 'verified' ? '重新确认' : '确认结论'}</button>` : entry.status === 'verified' ? `<span class="knowledge-confirmed">人工确认 · ${entry.confirmation?.modelDisagreement ? '模型仍有异议' : '引用仍须回源'}</span>` : ''}${active ? '<button type="button" class="btn tiny" data-action="recheck">复查来源</button>' : ''}${entry.status === 'quarantined' ? '<button type="button" class="btn tiny" data-action="release" title="只转为待核对；仍需回源确认后才会被检索使用">解除隔离</button>' : ''}${entry.status !== 'withdrawn' ? '<button type="button" class="btn tiny" data-action="withdraw">撤回</button>' : ''}${onResearch && active ? '<button type="button" class="btn tiny" data-research>继续研究</button>' : ''}</footer></article>`;
  }
  function paint() {
    for (const button of dialog.querySelectorAll('[data-page]')) button.setAttribute('aria-pressed', String(button.dataset.page === tab));
    if (!state) return;
    dialog.querySelector('[data-doc-count]').textContent = state.documents.length;
    dialog.querySelector('[data-conclusion-count]').textContent = state.entries.length;
    const q = dialog.querySelector('input[type=search]').value.trim().toLowerCase();
    statusNode.textContent = '';
    if (tab === 'documents') {
      const docs = state.documents.filter(d => !q || d.name.toLowerCase().includes(q));
      body.innerHTML = `<div class="knowledge-section-heading"><div><h3>原始资料</h3><p>${state.documents.length} 份文档 · ${state.sections.length} 个自定义分区</p></div>${onResearch ? `<button type="button" class="btn tiny" data-start-research>${icon('compass', { size: 15 })}开始研究</button>` : ''}</div>
        ${state.sections.length ? `<div class="knowledge-section-chips">${state.sections.map(s => `<span>${icon('layers', { size: 13 })}${esc(s.name)}<b>${s.docIds.length}</b></span>`).join('')}</div>` : ''}
        <div class="knowledge-docs">${docs.map(doc => `<article><span class="knowledge-doc-icon">${icon('document', { size: 22 })}</span><div><h4>${esc(doc.name)}</h4><small>${esc(doc.kind.toUpperCase())} · ${Number(doc.chunkCount || 0)} 段 · ${Number(doc.charCount || 0).toLocaleString()} 字</small></div>${onResearch ? `<button type="button" class="btn tiny" data-document="${esc(doc.id)}" aria-label="围绕${esc(doc.name)}研究">${icon('chevron-right', { size: 16 })}</button>` : ''}</article>`).join('') || `<div class="knowledge-empty">${icon('folder', { size: 38 })}<h3>${q ? '没有匹配的资料' : '从第一份资料开始'}</h3><p>${q ? '尝试更短的关键词。' : '导入文档后，可围绕原文研究，并将核对过的结论收进独立分区。'}</p></div>`}</div>`;
    } else {
      const entries = state.entries.filter(e => (!status || e.status === status) && (!q || e.claim.toLowerCase().includes(q)));
      body.innerHTML = `<div class="knowledge-section-heading"><div><h3>验证结论</h3><p>对话候选 → 回源与语义复查 → 人工确认</p></div><button type="button" class="btn tiny" data-review-all>${icon('refresh', { size: 15 })}复查来源</button></div><div class="knowledge-filters" role="group" aria-label="结论状态">${[['', '全部'], ...Object.entries(labels)].map(([key, label]) => `<button type="button" data-status="${key}" aria-pressed="${status === key}">${label}<b>${key ? state.counts[key] : state.entries.length}</b></button>`).join('')}</div>
        <p class="knowledge-review-note">${icon('shield', { size: 14 })}每次最多复查 12 条关联来源。语义复查使用学习审查预算；未运行时显示待复查。模型意见不等于事实证明。</p><div class="knowledge-conclusions">${entries.map(card).join('') || `<div class="knowledge-empty">${icon('branch', { size: 38 })}<h3>${state.entries.length ? '此范围暂无结论' : '让研究积累为可复用的认识'}</h3><p>启用学习后，有本地原文引用的完整回答会生成候选。核对来源并确认后，后续检索可沿结论索引找到原文。</p></div>`}</div><p class="knowledge-last-review">最近来源复查：${esc(date(state.maintenance?.lastRunAt))} · ${state.maintenance?.checked || 0} 条</p>`;
    }
  }
  async function reload() {
    const current = ++generation; statusNode.textContent = '正在读取知识库…';
    try {
      const response = await apiFetch('/api/knowledge/conclusions', { signal: life.signal }); const value = await response.json();
      if (!response.ok) throw new Error(value.message || '知识库暂不可用。');
      if (current !== generation || life.signal.aborted) return;
      state = value; statusNode.textContent = ''; paint();
    } catch (error) { if (!life.signal.aborted) statusNode.textContent = error.message; }
  }
  async function action(button, endpoint, payload) {
    button.disabled = true; statusNode.textContent = '正在核对…';
    try {
      const response = await apiFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-settings-request': '1' }, body: JSON.stringify(payload), signal: life.signal });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || '操作未完成。');
      await reload();
    } catch (error) { if (!life.signal.aborted) { statusNode.textContent = error.message; button.disabled = false; } }
  }
  dialog.addEventListener('input', event => { if (event.target.matches('input[type=search]')) paint(); });
  dialog.addEventListener('change', event => { if (event.target.matches('[data-ack]')) event.target.closest('[data-entry]').querySelector('[data-action=verify]').disabled = !event.target.checked; });
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.dataset.page) { tab = button.dataset.page; status = ''; paint(); }
    if (button.hasAttribute('data-status')) { status = button.dataset.status; paint(); }
    if (button.hasAttribute('data-knowledge-refresh')) reload();
    if (button.hasAttribute('data-knowledge-import')) { close(); onImport?.(); }
    if (button.hasAttribute('data-review-all')) action(button, '/api/knowledge/conclusions/review', {});
    const entry = state?.entries.find(e => e.id === button.closest('[data-entry]')?.dataset.entry);
    if (button.dataset.action && entry) action(button, `/api/knowledge/conclusions/${encodeURIComponent(entry.id)}/action`, { action: button.dataset.action, revision: entry.revision });
    if (button.dataset.source && entry) { const source = entry.sources.find(s => s.ref === button.dataset.source); if (source) { close(); onSource?.(source); } }
    if (button.hasAttribute('data-research') && entry) {
      const docIds = [...new Set(entry.sources.map(source => source.docId))];
      close(); onResearch?.({ question: `请回到原文复查这条结论的适用范围、证据与反例：${entry.claim}`, refs: entry.sources.map(s => s.ref), docIds,
        ...(docIds.length === 1 ? { docId: docIds[0] } : {}), conclusionId: entry.id });
    }
    if (button.hasAttribute('data-start-research')) { close(); onResearch?.({ question: '' }); }
    if (button.dataset.document) {
      const doc = state?.documents.find(item => item.id === button.dataset.document);
      if (!doc?.firstRef) { statusNode.textContent = '这份资料还没有可定位的原文片段，请刷新。'; return; }
      close(); onResearch?.({ question: '请围绕这份资料，提出一个值得深入核对的研究问题。', docId: doc.id, focusRef: doc.firstRef, refs: [doc.firstRef] });
    }
  });
  dialog.addEventListener('workbench:activate',reload);
  reload();
  return { close, refresh: reload, element: dialog };
}
