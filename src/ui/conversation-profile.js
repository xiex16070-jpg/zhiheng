import { escapeHtml } from '../agent/text.js';

let sequence = 0;

export async function renderConversationProfile(host, apiFetch, notice = '') {
  let data;
  try {
    const res = await apiFetch('/api/profile');
    if (!res.ok) throw new Error();
    data = await res.json();
  } catch {
    host.textContent = '跨会话画像读取失败，重新打开面板可重试。';
    return;
  }
  const { profile, fields } = data;
  const group = ++sequence;
  const rows = Object.entries(profile.entries).map(([key, row]) => {
    const field = fields[key];
    return `<div class="profile-row">
      <fieldset class="choice-set profile-choices"><legend>${escapeHtml(field.label)}</legend>
        <div class="choice-options">${field.choices.map(value => `<label class="choice-item"><input type="radio" name="profile-${group}-${escapeHtml(key)}" data-field="${escapeHtml(key)}" value="${escapeHtml(value)}" ${value === row.value ? 'checked' : ''}><span class="choice-face">${escapeHtml(value)}</span></label>`).join('')}</div>
      </fieldset>
      <small>${row.source === 'manual' ? '手动设置' : '来自你的自述'} · ${escapeHtml(new Date(row.at).toLocaleDateString())}</small>
      <button type="button" class="btn tiny" data-forget="${escapeHtml(key)}" aria-label="忘记${escapeHtml(field.label)}">忘记</button>
    </div>`;
  }).join('');
  const status = !data.learning ? '当前学习功能已关闭，画像暂停使用。'
    : data.scoped ? '私人分区内暂停读取与更新画像。' : '';
  host.innerHTML = `<div class="profile-heading"><h3 class="sec">跨会话画像</h3>
    <label><input type="checkbox" data-enabled ${profile.enabled ? 'checked' : ''}>启用</label></div>
    <p>在聊天中说明“我主要研究程序验证”或“我更喜欢先给一个例子”，下一次会话也能沿用。你可以在这里更正或忘记已记录的偏好。</p>
    ${rows || '<p class="profile-empty">尚未记录长期偏好。</p>'}
    <div class="profile-status" role="status">${escapeHtml([notice, status].filter(Boolean).join(' '))}</div>`;
  async function edit(change) {
    host.querySelectorAll('input,button').forEach(el => { el.disabled = true; });
    let message = '保存失败，请重试。';
    try {
      const res = await apiFetch('/api/profile', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: profile.revision, ...change }) });
      if (res.ok) message = '已保存，下次提问生效。';
      else if (res.status === 409) message = '画像已有更新，请在最新内容上重试。';
    } catch { /* Re-read to recover the controls and display the saved state. */ }
    await renderConversationProfile(host, apiFetch, message);
    const focused = change.field
      ? [...host.querySelectorAll('[data-field]')].find(el => el.dataset.field === change.field && el.checked)
      : host.querySelector('[data-enabled]');
    if (host.isConnected) (focused || host.querySelector('[data-enabled]'))?.focus({ preventScroll: true });
  }
  host.querySelector('[data-enabled]').addEventListener('change', e => edit({ enabled: e.target.checked }));
  host.querySelectorAll('[data-field]').forEach(el => el.addEventListener('change', () => {
    if (el.checked) edit({ field: el.dataset.field, value: el.value });
  }));
  host.querySelectorAll('[data-forget]').forEach(el => el.addEventListener('click', () => edit({ field: el.dataset.forget, value: null })));
}
