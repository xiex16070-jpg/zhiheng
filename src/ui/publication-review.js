const labels = {
  no_notice: '已查来源未报告撤稿或更正', retracted: '有撤稿记录', corrected: '有更正记录',
  conflict: '来源冲突，有撤稿记录待核对', unknown: '出版状态未知',
};
const issues = {
  missing_doi: '缺少可确认的 DOI', unchecked: '尚未查询', timeout: '查询超时', not_found: '未收录此 DOI',
  invalid_response: '记录无法核实', unavailable: '接口暂不可用', disabled: '文献来源已关闭', identifier_changed: 'DOI 已变化',
};
const date = value => new Date(value).toLocaleString('zh-CN', { hour12: false });

export function reviewableCitation(source) {
  return source.recordType !== 'textbook-section' &&
    (source.kind !== 'external' || ['academic', 'preprint'].includes(source.authority?.type));
}

function summary(review) {
  const parts = [labels[review.status] || labels.unknown];
  if (review.reason) parts.push(issues[review.reason] || '需回源核对');
  if (review.incomplete) parts.push('部分接口未完成');
  if (review.stale) parts.push('缓存已过期');
  if (review.previous) parts.push(`此前${labels[review.previous.status]}（${date(review.previous.checkedAt)}）`);
  return parts.join(' · ');
}

function reviewUrl(ref, context = {}) {
  const params = new URLSearchParams();
  if (ref) params.set('ref', ref);
  for (const key of ['taskId', 'conversationId', 'messageId']) if (context[key]) params.set(key, context[key]);
  return '/api/literature/status?' + params;
}

const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-publication-review': '1' },
  body: JSON.stringify(body) });

export async function showCitationReviews(entries, context, note, apiFetch, renew) {
  if (!entries.length) return;
  const reviews = new Map();
  function paint() {
    const alerts = [], unknown = [];
    for (const { ref, index, badge } of entries) {
      const review = reviews.get(ref);
      badge.textContent = review ? summary(review) : '出版状态未知 · 暂时无法读取复核记录';
      if (review && (review.stale || review.incomplete || review.previous || ['retracted', 'corrected', 'conflict'].includes(review.status))) {
        alerts.push(`[${index + 1}] ${badge.textContent}`);
      } else if (!review || review.status === 'unknown') unknown.push(index + 1);
    }
    if (unknown.length) alerts.push(`引用 ${unknown.map(n => '[' + n + ']').join('、')} 出版状态未知，可打开来源复核。`);
    note.hidden = !alerts.length;
    note.textContent = alerts.join('　');
  }
  for (const { ref, badge } of entries) {
    badge.dataset.reviewPath = reviewUrl(ref, context);
    badge.setAttribute('data-review-compact', '');
    badge.addEventListener('publication-reviewed', event => { reviews.set(ref, event.detail); paint(); });
  }
  async function load(refs, mode) {
    const response = await apiFetch(reviewUrl(null, context), post({ refs, mode }));
    if (!response.ok) throw new Error('review_unavailable');
    for (const { ref, review } of (await response.json()).reviews) reviews.set(ref, review);
    paint();
  }
  try {
    const refs = [...new Set(entries.map(entry => entry.ref))];
    for (let i = 0; i < refs.length; i += 32) await load(refs.slice(i, i + 32), 'read');
    const expired = [...reviews].filter(([, review]) => review.tracking && review.stale).map(([ref]) => ref);
    if (renew) for (let i = 0; i < expired.length; i += 32) await load(expired.slice(i, i + 32), 'use');
  } catch { paint(); }
}

export async function mountPublicationReview(host, ref, context, { apiFetch = window.apiFetch || fetch, initialReview } = {}) {
  const url = reviewUrl(ref, context);
  host.dataset.reviewPath = url;
  const text = document.createElement('span');
  host.replaceChildren(text);
  text.textContent = '正在读取出版状态…';
  async function load(mode = 'read', doi, cachedReview) {
    try {
      let review = cachedReview;
      if (!review) {
        const response = await apiFetch(url, mode === 'read' ? {} : post({ mode, confirmDoi: doi }));
        if (!response.ok) throw new Error('lookup_failed');
        review = await response.json();
      }
      const label = summary(review);
      text.textContent = label;
      for (const badge of document.querySelectorAll('[data-review-compact]')) {
        if (badge.dataset.reviewPath === url) badge.dispatchEvent(new CustomEvent('publication-reviewed', { detail: review }));
      }
      host.replaceChildren(text);
      if (review.doi) {
        const id = document.createElement('small'); id.textContent = ' DOI ' + review.doi;
        host.append(id);
      }
      if (review.sources?.length) {
        const details = document.createElement('details'), toggle = document.createElement('summary');
        toggle.textContent = `${review.cached ? '缓存查询' : '本次查询'} · ${date(review.checkedAt)} · 有效至 ${date(review.expiresAt)}`;
        details.append(toggle);
        for (const source of review.sources) {
          const line = document.createElement('p');
          const note = source.notices?.map(n => [n.type, n.source, n.noticeDoi].filter(Boolean).join(' · ')).join('，');
          line.textContent = [source.name, date(source.checkedAt), issues[source.issue] || note ||
            (source.name === 'OpenAlex' ? '未标记撤稿' : '未报告撤稿或更正'), source.httpStatus && 'HTTP ' + source.httpStatus].filter(Boolean).join(' · ');
          details.append(line);
        }
        host.append(details);
      }
      if (review.doi) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn tiny';
        button.textContent = review.tracking ? '停止此 DOI 的后续复核' : '允许联网复核此 DOI，过期后在阅读或引用时再查';
        button.title = '仅向已启用的 Crossref、Europe PMC、OpenAlex 发送此 DOI。';
        button.addEventListener('click', () => { button.disabled = true; text.textContent = '正在更新复核记录…'; void load(review.tracking ? 'stop' : 'track', review.doi); });
        host.append(button);
      }
      if (mode === 'read' && review.tracking && review.stale && host.isConnected) {
        await load('use');
      }
    } catch {
      text.textContent = '出版状态未知 · 暂时无法读取复核记录';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn tiny'; retry.textContent = '重新读取';
      retry.addEventListener('click', () => { retry.disabled = true; void load(); });
      host.replaceChildren(text, retry);
    }
  }
  await load('read', null, initialReview);
}
