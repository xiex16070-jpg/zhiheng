/**
 * 原文阅读器：教材全文、论文摘要与上传文档共用。
 * 按字符区间高亮命中句，并滚动到视野中央。
 */

import { escapeHtml } from '../agent/text.js';
import { prefersReducedMotion } from './motion.js';
import { icon } from './icons.js';
import { authorityLabel } from './joint-research.js';
import { sourceLocationLabel } from './source-location.js';
import { mountPublicationReview, reviewableCitation } from './publication-review.js';

const cache = new Map();

async function loadSource(ref, signal, fresh = false) {
  if (fresh) cache.delete(ref);
  if (cache.has(ref)) return cache.get(ref);
  const res = await (window.apiFetch || fetch)(`/api/source/${encodeURIComponent(ref)}`, { signal });
  if (!res.ok) {
    const message = res.status === 404 || res.status === 403 ? '资料不存在或不可访问。' :
      res.status === 401 ? '登录状态已失效，请刷新工作台后重试。' : '原文暂时无法读取，请重试。';
    throw Object.assign(new Error(message), { status: res.status });
  }
  const data = await res.json();
  if (signal.aborted) throw new DOMException('已取消', 'AbortError');
  cache.set(ref, data);
  return data;
}

export function createReader({ layoutEl, headEl, bodyEl, footEl }) {
  const panel = headEl.closest('.reader');
  const narrow = window.matchMedia('(max-width: 1180px)');
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const background = new Map();
  let generation = 0;
  let pending = null;
  let opened = false;
  let returnFocus = null;

  const titleId = `${panel.id || 'source-reader'}-title`;
  headEl.innerHTML = `<div><h3 id="${titleId}">原文阅读</h3><p class="reader-subtitle icon-label"></p></div>
    <button class="reader-close" type="button" aria-label="关闭原文阅读" title="关闭原文阅读（Esc）">${icon('close', { size: 16 })}</button>`;
  const titleEl = headEl.querySelector('h3');
  const subtitleEl = headEl.querySelector('.reader-subtitle');
  const closeButton = headEl.querySelector('.reader-close');
  panel.setAttribute('aria-labelledby', titleId);
  panel.setAttribute('aria-hidden', 'true');
  panel.inert = true;
  bodyEl.tabIndex = 0;
  bodyEl.setAttribute('aria-label', '原文内容');

  const backdrop = document.createElement('button');
  backdrop.className = 'reader-backdrop';
  backdrop.type = 'button';
  backdrop.tabIndex = -1;
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.inert = true;
  layoutEl.appendChild(backdrop);

  function restoreBackground() {
    for (const [element, inert] of background) element.inert = inert;
    background.clear();
  }

  function syncMode() {
    restoreBackground();
    panel.setAttribute('role', narrow.matches ? 'dialog' : 'complementary');
    panel.toggleAttribute('aria-modal', opened && narrow.matches);
    if (opened && narrow.matches) {
      panel.setAttribute('aria-modal', 'true');
      const peers = [...layoutEl.children, ...(layoutEl.parentElement?.children || [])];
      for (const element of peers) {
        if (element === panel || element === backdrop || element === layoutEl) continue;
        background.set(element, element.inert);
        element.inert = true;
      }
      if (!panel.contains(document.activeElement)) closeButton.focus({ preventScroll: true });
    }
  }

  function close() {
    if (!opened) return;
    generation += 1;
    pending?.abort();
    pending = null;
    opened = false;
    const shouldRestoreFocus = panel.contains(document.activeElement) || document.activeElement === backdrop;
    layoutEl.classList.remove('reader-open');
    restoreBackground();
    if (shouldRestoreFocus) {
      const target = returnFocus?.isConnected && returnFocus !== document.body && !returnFocus.disabled && !returnFocus.closest('[inert]')
        ? returnFocus : layoutEl.querySelector('#input');
      target?.focus({ preventScroll: true });
    }
    panel.inert = true;
    panel.setAttribute('aria-hidden', 'true');
    panel.removeAttribute('aria-modal');
    panel.removeAttribute('aria-busy');
    backdrop.inert = true;
  }

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  narrow.addEventListener('change', syncMode);
  reduced.addEventListener('change', () => {
    if (reduced.matches) bodyEl.scrollTo({ top: bodyEl.scrollTop, behavior: 'instant' });
  });
  document.addEventListener('keydown', (event) => {
    if (!opened || document.querySelector('.modal-mask')) return;
    if (event.key === 'Escape' && (narrow.matches || panel.contains(document.activeElement))) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !narrow.matches) return;
    const focusable = [...panel.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
      .filter((element) => element.tabIndex >= 0 && !element.disabled && !element.closest('[inert]') && element.getClientRects().length);
    const first = focusable[0] || closeButton;
    const last = focusable.at(-1) || closeButton;
    if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  });

  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const isCurrent = (version) => opened && version === generation && panel.isConnected;

  async function locate(version) {
    await nextFrame();
    if (!isCurrent(version)) return;
    // Use the actual panel/grid transitions, including cancellation on rapid
    // reversal. No timer tied to a stylesheet duration or a streaming token.
    if (!prefersReducedMotion()) {
      const animations = [panel, layoutEl].flatMap((element) => element.getAnimations?.() || []);
      await Promise.allSettled(animations.map((animation) => animation.finished));
      await nextFrame();
    }
    if (!isCurrent(version)) return;
    const target = bodyEl.querySelector('mark');
    if (!target) {
      bodyEl.scrollTop = 0;
      return;
    }
    const box = bodyEl.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    bodyEl.scrollTo({
      top: Math.max(0, rect.top - box.top + bodyEl.scrollTop - bodyEl.clientHeight / 2),
      behavior: prefersReducedMotion() ? 'instant' : 'smooth',
    });
    if (!prefersReducedMotion()) target.classList.add('flash');
  }

  async function open(ref, highlight) {
    const hadPanelFocus = panel.contains(document.activeElement);
    const version = ++generation;
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    if (!panel.contains(document.activeElement) && document.activeElement !== backdrop) returnFocus = document.activeElement;
    const wasOpen = opened;
    opened = true;
    panel.inert = false;
    backdrop.inert = false;
    panel.setAttribute('aria-hidden', 'false');
    panel.setAttribute('aria-busy', 'true');
    titleEl.textContent = '正在打开原文';
    subtitleEl.textContent = '正在加载来源…';
    bodyEl.innerHTML = '<div class="reader-loading" role="status"><span class="spin" aria-hidden="true"></span><span>正在加载原文…</span></div>';
    bodyEl.scrollTop = 0;
    footEl.textContent = '';
    layoutEl.classList.add('reader-open');
    syncMode();
    if (!wasOpen || hadPanelFocus) closeButton.focus({ preventScroll: true });
    let src;
    try {
      if (highlight?.kind === 'external' && highlight.sourceText) {
        src = {
          kind: 'external',
          title: highlight.title || highlight.source || '外部依据',
          subtitle: highlight.sourceUrl || highlight.source || '',
          content: String(highlight.sourceText),
          keywords: '',
          sourceUrl: highlight.sourceUrl,
          authority: highlight.authority,
        };
      } else {
        src = await loadSource(ref, controller.signal, highlight?.fresh === true);
      }
    } catch (err) {
      if (!isCurrent(version) || controller.signal.aborted) return;
      titleEl.textContent = '无法打开原文';
      subtitleEl.textContent = '答案与引用仍保留在对话中';
      bodyEl.innerHTML = `<div class="reader-error"><p class="reader-status" role="status">${icon('warning', { size: 16 })}<span>${escapeHtml(err.message)}</span></p><div class="reader-error-actions"><button type="button" class="btn" data-source-retry>重新读取</button><button type="button" class="btn" data-source-return>返回答案</button></div></div>`;
      bodyEl.querySelector('[data-source-retry]').addEventListener('click', () => open(ref, { ...highlight, fresh: true }));
      bodyEl.querySelector('[data-source-return]').addEventListener('click', close);
      footEl.innerHTML = '';
      panel.removeAttribute('aria-busy');
      pending = null;
      return;
    }

    if (!isCurrent(version) || controller.signal.aborted) return;
    pending = null;
    panel.removeAttribute('aria-busy');

    const content = String(src.content || '');
    const validHighlight = highlight?.locatable !== false && Number.isInteger(highlight?.start) && Number.isInteger(highlight?.end) &&
      highlight.start >= 0 && highlight.end > highlight.start && highlight.end <= content.length;
    const hs = validHighlight ? highlight.start : -1;
    const he = validHighlight ? highlight.end : -1;
    const kindLabel = src.recordType === 'textbook-section' ? '教材全文' : src.kind === 'paper' ? '论文' : src.kind === 'external' ? '外部来源' : '文档';

    titleEl.textContent = src.title || '原文';
    subtitleEl.innerHTML = `${icon(src.kind === 'paper' ? 'book' : src.kind === 'external' ? 'external' : 'document', { size: 12 })}<span>${escapeHtml(src.subtitle || '')} · ${kindLabel}</span>`;

    const original = document.createElement('div');
    original.className = 'reader-original';
    if (validHighlight) {
      const mark = document.createElement('mark');
      mark.textContent = content.slice(hs, he);
      original.append(content.slice(0, hs), mark, content.slice(he));
    } else {
      original.textContent = content || '（无正文）';
    }
    bodyEl.replaceChildren(original);
    let sourceUrl = '';
    try { const url = new URL(src.sourceUrl); if (['https:', 'http:'].includes(url.protocol)) sourceUrl = url.href; } catch { /* No external origin for uploaded documents. */ }
    if (sourceUrl && src.authority) {
      const a = src.authority;
      bodyEl.insertAdjacentHTML('afterbegin', `<div class="reader-authority"><strong>${escapeHtml(authorityLabel(src))}</strong><p>${escapeHtml([a.authors, a.venue || a.origin].filter(Boolean).join(' · '))}</p><p>${a.evidenceLevel === 'abstract' ? '此处为检索接口返回的摘要，未读取论文全文。' : '此处为实际取得的网页摘录，可能未覆盖完整页面。'}${a.type === 'academic' || a.type === 'preprint' ? '同行评审状态未自动核实。' : ''}</p><p>取得时间：${escapeHtml(String(a.retrievedAt || '').slice(0, 10))}${a.updatedAt ? ' · 更新：' + escapeHtml(a.updatedAt) : ''}</p><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">打开来源页面 ${icon('external', { size: 12 })}</a></div>`);
    } else if (sourceUrl) {
      const edition = [src.sourceEdition, src.sourceEditionDate].filter(Boolean).join(' · ');
      bodyEl.insertAdjacentHTML('afterbegin', `<div class="reader-provenance">${escapeHtml(src.sourceTitle || '专业资料')} · ${escapeHtml(src.license || '')}${edition ? `<br />教材版次：${escapeHtml(edition)}` : ''}${src.sourceRevision ? `<br />源文件快照：${escapeHtml(src.sourceRevision.slice(0, 10))}` : ''}${src.translationStatus === 'alpha' ? '<br />中文译本 alpha；保留原文与代码，本次未重新运行证明编译。' : ''}<br /><a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看固定版本原文 ${icon('external', { size: 12 })}</a></div>`);
    }

    if (reviewableCitation(src)) {
      const review = document.createElement('div'); review.className = 'reader-provenance';
      bodyEl.prepend(review);
      void mountPublicationReview(review, ref, highlight?.reviewContext);
    }
    footEl.innerHTML = `<span>${escapeHtml(sourceLocationLabel(src, highlight))}</span><span>${escapeHtml(src.keywords || '')}</span>`;

    void locate(version);
  }

  function clear() {
    close();
    cache.clear();
  }

  return { open, close, clear };
}
