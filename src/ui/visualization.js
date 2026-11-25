import { icon } from './icons.js';
import { escapeHtml } from '../agent/text.js';

export function renderVisualization(host, artifact, { fetch: request, url }) {
  if ([...host.querySelectorAll('.visualization-card')].some(c => c.dataset.path === artifact.path)) return;
  const card = document.createElement('section');
  card.className = 'visualization-card'; card.dataset.path = artifact.path;
  card.innerHTML = `<header><span>${icon('layers', { size: 18 })}<strong>${escapeHtml(artifact.title || '研究可视化')}</strong><small>可交互图解</small></span><button class="btn tiny viz-expand" aria-pressed="false">展开</button><a class="btn tiny" href="${escapeHtml(url)}" download>${icon('download', { size: 14 })} 下载</a></header><div class="viz-status" role="status">正在载入图解…</div>`;
  const frame = document.createElement('iframe'); frame.title = artifact.title || '研究可视化';
  frame.setAttribute('sandbox', 'allow-scripts'); frame.referrerPolicy = 'no-referrer'; frame.loading = 'lazy';
  frame.style.height = `${Math.max(180, Math.min(800, artifact.height || 420))}px`;
  card.querySelector('.viz-expand').addEventListener('click', e => {
    const expanded = card.classList.toggle('expanded');
    e.currentTarget.textContent = expanded ? '收起' : '展开'; e.currentTarget.setAttribute('aria-pressed', String(expanded));
  });
  host.append(card);
  request(url).then(async response => {
    if (!response.ok) throw new Error('请切换到创建此产物的工作区后重试。');
    const raw = await response.arrayBuffer();
    if (raw.byteLength > 600000) throw new Error('预览超过大小限制。');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].map(x => x.toString(16).padStart(2, '0')).join('');
    if (hash !== artifact.sha256) throw new Error('产物已被修改，预览已停止。请重新生成或下载检查。');
    const html = new TextDecoder().decode(raw);
    if (html.length > 600000) throw new Error('预览超过大小限制。');
    // srcdoc never receives application privileges; no allow-same-origin or popups.
    frame.srcdoc = html;
    card.querySelector('.viz-status').remove(); card.append(frame);
  }).catch(error => { card.querySelector('.viz-status').textContent = error.message; });
}
