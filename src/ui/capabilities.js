import { showDialog } from './dialog.js';
import { icon } from './icons.js';
import { escapeHtml as esc } from '../agent/text.js';
import { animateIn } from './motion.js';
import { CONFIGURATION_SECTIONS } from './configuration-sections.js';

const states = { available: '内置可用', configured: '已配置', needs_setup: '待配置', disabled: '已关闭' };
const symbols = { research: 'book', execution: 'inference', delivery: 'layers', connections: 'workspace' };

// Configuration navigation and the settings dock share their section directory.
// These are destinations, not claims that a provider or paid service is enabled.
const configurationLinks = [
  { id: 'model', label: '模型与协议', icon: 'settings', action: 'model', keywords: '后端 API 视觉 本地 Qwen' },
  ...CONFIGURATION_SECTIONS.map(section => ({ ...section, action: `settings-${section.id}` })),
  { id: 'joint', label: '联合研究', icon: 'branch', action: 'settings-joint' },
];

function configurationNavigation() {
  return `<details class="capability-configuration" open><summary><span>${icon('settings', { size: 17 })}<strong>配置直达</strong><small>模型、研究与执行环境</small></span>${icon('chevron-down', { size: 15 })}</summary>
    <nav class="capability-config-grid" aria-label="功能配置导航">${configurationLinks.map(item => `<button type="button" data-config-destination="${esc(item.id)}" data-navigate="${esc(item.action)}">${icon(item.icon, { size: 17 })}<span>${esc(item.label)}</span>${icon('chevron-right', { size: 13 })}</button>`).join('')}</nav><p class="capability-footnote" data-config-empty hidden>没有匹配的配置分区。</p>
  </details>`;
}

// Original vector artwork: three paths converge into one traceable result.
// Static geometry is the fallback; the short reveal never loops or tracks tokens.
function studioArtwork() {
  return `<svg class="capability-art" viewBox="0 0 260 180" fill="none" aria-hidden="true" focusable="false">
    <path class="studio-grid" d="M20 30h220M20 60h220M20 90h220M20 120h220M20 150h220M40 15v150M70 15v150M100 15v150M130 15v150M160 15v150M190 15v150M220 15v150"/>
    <circle class="studio-orbit" cx="132" cy="90" r="61"/><circle class="studio-orbit" cx="132" cy="90" r="42"/>
    <g class="studio-paths"><path d="M40 42h30c34 0 20 48 62 48h78"/><path d="M40 90h170"/><path d="M40 138h30c34 0 20-48 62-48h78"/></g>
    <g class="studio-points"><circle cx="40" cy="42" r="5"/><circle cx="40" cy="90" r="5"/><circle cx="40" cy="138" r="5"/><circle cx="132" cy="90" r="9"/><rect x="207" y="78" width="24" height="24" rx="7"/></g>
    <path class="studio-check" d="m213 90 4 4 8-8"/>
  </svg>`;
}

export function createCapabilityNavigator({ apiFetch = fetch, button, onNavigate, onCompose }) {
  let dialog = null, life = null, group = 'all', query = '', data = null, loading = false;
  const navigate = action => {
    const current = dialog;
    if (!current) return;
    current.addEventListener('close', () => onNavigate(action), { once: true });
    current.close();
  };
  function render() {
    if (!dialog) return;
    const term = query.toLocaleLowerCase();
    const matchedConfiguration = new Set(configurationLinks.filter(item => !term || `${item.label} ${item.id} ${item.keywords || ''}`.toLocaleLowerCase().includes(term)).map(item => item.id));
    for (const button of dialog.querySelectorAll('[data-config-destination]')) button.hidden = !matchedConfiguration.has(button.dataset.configDestination);
    dialog.querySelector('[data-config-empty]').hidden = matchedConfiguration.size > 0;
    if (term && matchedConfiguration.size) dialog.querySelector('.capability-configuration').open = true;
    if (!data) return;
    const list = dialog.querySelector('[data-capability-list]');
    const filtered = data.items.filter(i => (group === 'all' || i.group === group) &&
      (!term || `${i.title} ${i.description} ${i.note} ${i.tools.join(' ')}`.toLocaleLowerCase().includes(term)));
    list.innerHTML = filtered.length ? filtered.map(item => `<article class="capability-card" data-capability="${esc(item.id)}" data-state="${esc(item.state)}">
      <div class="capability-card-top"><span class="capability-mark">${icon(symbols[item.group], { size: 21 })}</span><span class="capability-state state-${esc(item.state)}">${esc(states[item.state])}</span></div>
      <h3>${esc(item.title)}</h3><p>${esc(item.description)}</p>
      <details class="capability-limit"><summary>使用范围 ${icon('chevron-down',{size:12})}</summary><p>${esc(item.note)}</p></details>
      <footer>${['available','configured'].includes(item.state) ? `<button class="capability-use" data-use="${esc(item.id)}" type="button">写入提问 ${icon('chevron-right',{size:14})}</button>` : '<span class="capability-await">完成配置后使用</span>'}<button class="capability-configure" data-navigate="${esc(item.action)}" type="button" aria-label="${item.action.startsWith('settings-') || item.action === 'model' ? '配置' : '打开'}${esc(item.title)}">${icon('external',{size:14})}<span>${item.action.startsWith('settings-') || item.action === 'model' ? '配置' : '打开'}</span></button></footer>
    </article>`).join('') : `<div class="capability-empty">${term && matchedConfiguration.size ? '匹配到上方配置入口，可直接打开。' : '没有匹配的能力。试试“文献”“文件”或“MCP”。'}</div>`;
    dialog.querySelector('[data-capability-count]').textContent = term ? `${filtered.length} 项能力 · ${matchedConfiguration.size} 项配置` : `${filtered.length} 项能力`;
    dialog.querySelector('[data-capability-note]').textContent = data.note;
    dialog.querySelector('[data-capability-ready]').textContent = data.counts.available;
    dialog.querySelector('[data-capability-configured]').textContent = data.counts.configured;
    dialog.querySelector('[data-capability-pending]').textContent = data.counts.needs_setup + data.counts.disabled;
  }
  async function refresh() {
    if (loading || !dialog) return;
    loading = true;
    const current = dialog, refreshButton = current.querySelector('[data-capability-refresh]');
    refreshButton.disabled = true;
    try {
      const response = await apiFetch('/api/capabilities', { signal: AbortSignal.any([life.signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) throw new Error('能力状态暂不可用，请稍后刷新。');
      const next = await response.json();
      if (dialog !== current) return;
      data = next; render();
    } catch (error) {
      if (dialog === current && !life.signal.aborted) current.querySelector('[data-capability-note]').textContent = error.message;
    } finally { if (dialog === current) { loading = false; refreshButton.disabled = false; } }
  }
  function open() {
    if (dialog?.open) { dialog.querySelector('[data-capability-search]').focus(); return; }
    // Do not steal keyboard focus from an existing approval or configuration dialog.
    if (document.querySelector('dialog[open]')) return;
    group = 'all'; query = ''; data = null; loading = false; life = new AbortController();
    dialog = document.createElement('dialog'); dialog.className = 'modal-mask capability-dialog';
    dialog.innerHTML = `<section class="modal capability-workbench" data-slot="capability-navigator">
      <div class="modal-head"><h2>${icon('compass',{size:19})} 能力导航</h2><div class="capability-head-actions"><button type="button" data-capability-refresh class="btn tiny">${icon('refresh',{size:14})}刷新</button><button type="button" data-close aria-label="关闭能力导航">${icon('close')}</button></div></div>
      <div class="capability-body"><header class="capability-hero"><div><span class="capability-eyebrow">ZHIHENG / CAPABILITY ATLAS</span><h2>选择能力，<br>开始下一步。</h2><p>从可靠的证据出发，把研究交付为清晰的结果。</p><div class="capability-metrics"><span><b data-capability-ready>—</b>内置可用</span><span><b data-capability-configured>—</b>已配置</span><span><b data-capability-pending>—</b>待准备</span></div></div>${studioArtwork()}</header>
      <div class="capability-shortcuts" aria-label="快速导航"><button type="button" data-navigate="workspace">${icon('folder',{size:17})}工作区${icon('chevron-right',{size:13})}</button><button type="button" data-navigate="activity">${icon('activity',{size:17})}任务中心${icon('chevron-right',{size:13})}</button><button type="button" data-navigate="learning">${icon('learning',{size:17})}学习与记忆${icon('chevron-right',{size:13})}</button></div>
      ${configurationNavigation()}
      <label class="capability-search">${icon('search',{size:18})}<input data-capability-search type="search" placeholder="搜索能力或配置，例如 PDF、独立审核、MCP…" maxlength="120" aria-label="搜索能力与配置"><kbd>Ctrl Shift K</kbd></label>
      <div class="capability-filterbar"><nav class="capability-filters" aria-label="能力分类">${[['all','全部'],['research','阅读与求证'],['execution','计划与执行'],['delivery','产物与表达'],['connections','连接与扩展']].map(([id,title])=>`<button type="button" data-group="${id}" aria-pressed="${id==='all'}">${title}</button>`).join('')}</nav><span data-capability-count>读取中</span></div>
      <div class="capability-cards" data-capability-list><div class="capability-empty">正在读取本机能力配置…</div></div>
      <p class="capability-footnote" data-capability-note role="status">只读取本机配置，不会启动外部服务。</p>
      <p class="capability-boundary">桌面控制、平台账号连接与专属云端画布未内置。可通过明确授权的插件扩展；不会继承其他应用的登录状态。</p></div>
    </section>`;
    const current = dialog, currentLife = life;
    showDialog(dialog, { initialFocus: dialog.querySelector('[data-capability-search]'), onClose: () => { currentLife.abort(); if (dialog === current) { dialog = null; data = null; } } });
    dialog.addEventListener('input', e => { if (e.target.matches('[data-capability-search]')) { query = e.target.value.trim(); render(); } });
    dialog.addEventListener('click', e => {
      const groupButton = e.target.closest('[data-group]');
      if (groupButton) { group = groupButton.dataset.group; for (const b of current.querySelectorAll('[data-group]')) b.setAttribute('aria-pressed', String(b === groupButton)); render(); }
      const destination = e.target.closest('[data-navigate]');
      if (destination) navigate(destination.dataset.navigate);
      const use = e.target.closest('[data-use]');
      if (use) {
        const item = data.items.find(i => i.id === use.dataset.use);
        if (item) { current.addEventListener('close', () => onCompose(item.prompt), { once: true }); current.close(); }
      }
    });
    dialog.querySelector('[data-capability-refresh]').addEventListener('click', refresh);
    animateIn(dialog.querySelector('.capability-hero'), { kind: 'citation' });
    refresh();
  }
  const shortcut = event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && event.shiftKey && !event.altKey && !event.isComposing) {
      if (document.querySelector('dialog[open]') && !dialog?.open) return;
      event.preventDefault(); open();
    }
  };
  button?.addEventListener('click', open); document.addEventListener('keydown', shortcut);
  return { open, close() { dialog?.close(); button?.removeEventListener('click', open); document.removeEventListener('keydown', shortcut); } };
}
