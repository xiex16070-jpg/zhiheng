import { icon } from './icons.js';
import { escapeHtml as esc } from '../agent/text.js';

export const artifactPreviewUrl = (path, workspaceId = 'default') => '/preview.html?' + new URLSearchParams({ path, workspace: workspaceId });
const bytes = value => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`;
const errorText = { not_found: '文件或所属项目不存在，请检查项目是否已移除。', workspace_unavailable: '此项目文件夹暂不可用，请重新连接后再预览。', local_workspace_required: '请在本机知衡工作台中打开此项目文件。', invalid_path: '文件路径不可用。', unsafe_link: '此文件是链接，无法在工作区中预览。', preview_too_large: '文件超过预览大小限制，可下载后查看。' };
let previewSequence = 0;

export function createArtifactPreview({ apiFetch = fetch, host = document.body, standalone = false } = {}) {
  const root = document.createElement('aside'); root.className = 'artifact-dock'; root.setAttribute('aria-label', '文件预览'); root.hidden = !standalone;
  root.innerHTML = `<header class="artifact-dock-head"><div class="artifact-tabs" role="tablist" aria-label="打开的文件"></div><button type="button" class="artifact-icon-button" data-close-preview aria-label="关闭文件预览">${icon('close')}</button></header>
    <div class="artifact-toolbar"><div class="artifact-file-title"><span class="artifact-format"></span><div><h2></h2><p data-artifact-meta></p></div></div><div class="artifact-actions"><button type="button" data-refresh-preview class="artifact-icon-button" aria-label="重新加载文件">${icon('refresh', { size: 17 })}</button><a data-open-window class="artifact-icon-button" target="_blank" rel="noopener noreferrer" aria-label="在新窗口打开">${icon('external', { size: 17 })}</a><a data-download class="artifact-icon-button" download aria-label="下载原文件">${icon('download', { size: 17 })}</a></div></div>
    <div class="artifact-viewbar"><div class="artifact-mode" role="group" aria-label="查看方式"><button type="button" data-mode="render" aria-pressed="true">预览</button><button type="button" data-mode="source" aria-pressed="false">源码</button></div><button type="button" class="artifact-outline-toggle" data-outline-toggle aria-expanded="false">${icon('document', { size: 15 })}目录</button><span class="artifact-readonly">只读预览</span></div>
    <p class="artifact-notice" role="status" hidden></p><div class="artifact-reading"><nav class="artifact-outline" aria-label="文档目录" hidden></nav><div class="artifact-content" tabindex="0"></div></div>`;
  host.append(root);
  const tabs = new Map(); let active = null, mode = 'render', life = null, lastFocus = null, sequence = 0;
  const content = root.querySelector('.artifact-content'), outline = root.querySelector('.artifact-outline');
  const tablist = root.querySelector('.artifact-tabs'), previewId = `artifact-preview-${++previewSequence}`;
  let tabSequence = 0;
  content.id = `${previewId}-panel`; content.setAttribute('role', 'tabpanel');

  function paintTabs() {
    // Preserve the focused button when activating a file; replacing the whole
    // list would send keyboard focus back to the page during the request.
    for (const button of [...tablist.children]) if (!tabs.has(button.dataset.artifactTab)) button.remove();
    for (const [key, item] of tabs) {
      let button = [...tablist.children].find(node => node.dataset.artifactTab === key);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'artifact-tab';
        button.id = `${previewId}-tab-${++tabSequence}`; button.setAttribute('role', 'tab');
        button.dataset.artifactTab = key; button.title = item.path;
        button.innerHTML = `${icon('document', { size: 15 })}<span>${esc(item.path.split('/').at(-1))}</span>`;
        button.setAttribute('aria-controls', content.id); tablist.append(button);
      }
      button.setAttribute('aria-selected', String(key === active)); button.tabIndex = key === active ? 0 : -1;
      if (key === active) content.setAttribute('aria-labelledby', button.id);
    }
  }
  tablist.addEventListener('keydown', event => {
    const buttons = [...tablist.querySelectorAll('[role="tab"]')], index = buttons.indexOf(event.target);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons.forEach((button, i) => { button.tabIndex = i === next ? 0 : -1; });
    buttons[next].focus();
  });
  tablist.addEventListener('focusout', event => {
    if (!tablist.contains(event.relatedTarget)) {
      for (const button of tablist.children) button.tabIndex = button.dataset.artifactTab === active ? 0 : -1;
    }
  });
  function paintDescriptor(data) {
    root.querySelector('.artifact-file-title h2').textContent = data.name;
    root.querySelector('.artifact-format').textContent = data.format.slice(0, 8);
    root.querySelector('[data-artifact-meta]').textContent = `${data.workspaceName} / ${data.path} · ${bytes(data.bytes)}`;
    root.querySelector('[data-download]').href = data.downloadUrl;
    root.querySelector('[data-open-window]')?.setAttribute('href', data.windowUrl);
    const notice = [data.notice, data.truncated ? '内容过长，当前显示前 200 KB；下载可查看完整文件。' : ''].filter(Boolean).join(' ');
    root.querySelector('.artifact-notice').textContent = notice; root.querySelector('.artifact-notice').hidden = !notice;
    const canRender = data.kind !== 'code' && data.kind !== 'unsupported';
    const canSource = typeof data.source === 'string';
    root.querySelector('[data-mode="source"]').textContent = data.kind === 'extracted' ? '提取文字' : '源码';
    if (!canSource && mode === 'source') mode = 'render';
    if (!canRender && canSource) mode = 'source';
    for (const button of root.querySelectorAll('[data-mode]')) {
      button.disabled = button.dataset.mode === 'render' ? !canRender : !canSource;
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    outline.innerHTML = (data.headings || []).map(item => `<a href="#${esc(item.id)}" data-heading="${esc(item.id)}" style="--heading-depth:${Math.min(item.depth, 4)}">${esc(item.title)}</a>`).join('');
    root.querySelector('[data-outline-toggle]').hidden = !(data.headings?.length) || mode === 'source';
    if (!data.headings?.length || mode === 'source') { outline.hidden = true; root.querySelector('[data-outline-toggle]').setAttribute('aria-expanded', 'false'); }
    content.className = 'artifact-content artifact-content-' + data.kind;
    if (mode === 'source' && canSource) {
      content.replaceChildren(); const pre = document.createElement('pre'); pre.className = 'artifact-source'; const code = document.createElement('code'); code.textContent = data.source; pre.append(code); content.append(pre);
    } else if (data.html !== undefined) {
      // Server has parsed Markdown and applied a strict static-content allowlist.
      const article = document.createElement('article'); article.className = 'artifact-prose'; article.innerHTML = data.html; content.replaceChildren(article);
    } else if (data.kind === 'image') {
      const image = document.createElement('img'); image.className = 'artifact-image'; image.alt = data.name; image.src = data.assetUrl; image.decoding = 'async'; content.replaceChildren(image);
    } else if (data.kind === 'pdf') {
      const frame = document.createElement('iframe'); frame.className = 'artifact-pdf'; frame.title = data.name; frame.src = data.assetUrl; frame.referrerPolicy = 'no-referrer'; content.replaceChildren(frame);
    } else {
      content.innerHTML = `<div class="artifact-empty">${icon('document', { size: 38 })}<h3>此格式请下载后打开</h3><p>文件已保存在项目中，可使用对应应用查看。</p><a class="artifact-primary-link" href="${esc(data.downloadUrl)}" download>下载 ${esc(data.name)}</a></div>`;
    }
    if (standalone) document.title = data.name + ' · 知衡预览';
  }
  async function load(key) {
    life?.abort(); life = new AbortController(); const currentLife = life, requestId = ++sequence;
    const item = tabs.get(key); active = key; mode = 'render'; paintTabs();
    root.querySelector('.artifact-file-title h2').textContent = item.path.split('/').at(-1);
    root.querySelector('.artifact-format').textContent = 'FILE'; root.querySelector('[data-artifact-meta]').textContent = '正在读取项目文件…';
    root.querySelector('[data-open-window]')?.setAttribute('href', artifactPreviewUrl(item.path, item.workspaceId));
    root.querySelector('[data-download]').removeAttribute('href'); outline.hidden = true;
    root.querySelector('.artifact-notice').hidden = true;
    content.setAttribute('aria-busy', 'true');
    content.innerHTML = '<div class="artifact-empty artifact-loading"><span></span><p>正在准备预览…</p></div>';
    try {
      const response = await apiFetch('/api/workspace/preview?' + new URLSearchParams({ path: item.path, workspace: item.workspaceId }), { signal: AbortSignal.any([currentLife.signal, AbortSignal.timeout(20000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(errorText[data.error] || (response.status === 401 ? '请先在知衡工作台登录，再打开此文件。' : '暂时无法读取文件，请刷新后重试。'));
      if (currentLife.signal.aborted || requestId !== sequence) return;
      item.data = data; paintDescriptor(data);
    } catch (error) {
      if (currentLife.signal.aborted || requestId !== sequence) return;
      content.innerHTML = `<div class="artifact-empty">${icon('warning', { size: 32 })}<h3>暂时无法预览</h3><p>${esc(error.message)}</p><button type="button" data-retry-preview>重新加载</button></div>`;
      root.querySelector('[data-artifact-meta]').textContent = item.path;
    } finally {
      if (requestId === sequence) content.setAttribute('aria-busy', 'false');
    }
  }
  function open({ path, workspaceId = 'default' }) {
    if (!path) return;
    if (root.hidden) lastFocus = document.activeElement;
    root.hidden = false; if (!standalone) document.body.classList.add('artifact-preview-open');
    const key = JSON.stringify([workspaceId, path]);
    if (!tabs.has(key)) { if (tabs.size >= 6) tabs.delete(tabs.keys().next().value); tabs.set(key, { path, workspaceId }); }
    load(key); if (!standalone) root.querySelector('[data-close-preview]').focus({ preventScroll: true });
  }
  function close() {
    const restoreFocus = !root.hidden && root.contains(document.activeElement);
    life?.abort(); root.hidden = true; document.body.classList.remove('artifact-preview-open');
    if (!standalone && restoreFocus && lastFocus?.isConnected && !lastFocus.closest('[inert]')) lastFocus.focus({ preventScroll: true });
  }
  root.addEventListener('click', event => {
    const button = event.target.closest('button, a'); if (!button) return;
    if (button.matches('[data-close-preview]')) close();
    if (button.matches('[data-artifact-tab]')) load(button.dataset.artifactTab);
    if (button.matches('[data-refresh-preview], [data-retry-preview]') && active) load(active);
    if (button.matches('[data-mode]')) { mode = button.dataset.mode; const data = tabs.get(active)?.data; if (data) paintDescriptor(data); }
    if (button.matches('[data-outline-toggle]')) { outline.hidden = !outline.hidden; button.setAttribute('aria-expanded', String(!outline.hidden)); }
    const headingId = button.dataset.heading || (button.getAttribute('href')?.startsWith('#artifact-') ? button.getAttribute('href').slice(1) : null);
    if (headingId) { event.preventDefault(); const target = [...content.querySelectorAll('[id]')].find(node => node.id === headingId); target?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
  });
  const escape = event => { if (event.key === 'Escape' && !root.hidden && !document.querySelector('dialog[open]') && !standalone) close(); };
  document.addEventListener('keydown', escape);
  if (standalone) { root.querySelector('[data-close-preview]').remove(); root.querySelector('[data-open-window]').remove(); }
  return { open, close, element: root, destroy() { close(); document.removeEventListener('keydown', escape); root.remove(); } };
}
