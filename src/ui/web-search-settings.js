import { icon } from './icons.js';
import { animateState } from './motion.js';

export function mountWebSearchSettings(host, { apiFetch = fetch, onChanged = () => {} } = {}) {
  host.innerHTML = `<section class="search-settings-card" id="web-search-settings" aria-labelledby="web-search-heading">
    <header class="search-settings-heading"><span class="search-settings-emblem" aria-hidden="true">${icon('search', { size: 23 })}</span>
      <div><span class="search-settings-eyebrow">WEB / SOURCES</span><h3 id="web-search-heading">网站与学术搜索</h3><p>独立保存，多源并行，交叉查证</p></div>
      <span id="web-search-badge" class="search-settings-badge">读取中</span></header>
    <form id="web-search-form" autocomplete="off">
      <fieldset class="search-settings-fields" disabled>
        <legend class="sr-only">网站搜索服务配置</legend>
        <div class="search-provider-options" role="group" aria-label="搜索服务">
          <label><input type="radio" name="search-provider" value="tavily" checked><span><strong>Tavily</strong><small>研究检索</small></span></label>
          <label><input type="radio" name="search-provider" value="serper"><span><strong>Serper</strong><small>Google 搜索</small></span></label>
          <label id="web-search-bing-option" hidden><input type="radio" name="search-provider" value="bing"><span><strong>Bing</strong><small>现有配置</small></span></label>
          <label><input type="radio" name="search-provider" value="openalex"><span><strong>OpenAlex</strong><small>学术图谱</small></span></label>
          <label><input type="radio" name="search-provider" value="europepmc"><span><strong>Europe PMC</strong><small>无需密钥</small></span></label>
        </div>
        <div class="search-key-label"><label for="web-search-key">API Key</label><span id="web-search-key-state"></span></div>
        <div class="search-key-input"><input id="web-search-key" type="password" autocomplete="new-password" name="search-api-key" spellcheck="false" autocapitalize="off" maxlength="512" aria-describedby="web-search-key-help" placeholder="输入 Tavily API Key">
          <button type="button" id="web-search-reveal" aria-label="显示正在填写的密钥" aria-pressed="false">${icon('eye', { size: 17 })}</button></div>
        <p id="web-search-key-help" class="search-settings-note">密钥加密保存在本机，保存后立即生效。</p>
        <div class="search-settings-options">
          <label><input type="checkbox" id="web-search-enabled" checked><span>启用当前服务</span></label>
          <label><input type="checkbox" id="web-search-fetch" checked><span>读取网页正文</span></label>
        </div>
        <div class="search-settings-actions"><button type="button" class="btn search-test" id="web-search-test">${icon('activity', { size: 15 })}<span>测试连接</span></button>
          <button type="submit" class="btn search-save" id="web-search-save">${icon('check', { size: 15 })}<span>保存配置</span></button>
          <button type="button" class="search-remove" id="web-search-remove" hidden>移除密钥</button></div>
      </fieldset>
    </form>
    <div class="search-settings-feedback" id="web-search-feedback" role="status" aria-live="polite" aria-atomic="true">正在读取搜索配置…</div>
    <p class="search-settings-note" id="web-search-overview"></p>
    <button type="button" class="btn tiny" id="web-search-reload" hidden>重新读取配置</button>
  </section>`;
  const $ = s => host.querySelector(s);
  const key = $('#web-search-key'), fields = $('.search-settings-fields'), badge = $('#web-search-badge');
  const lifetime = new AbortController();
  const drafts = new Map();
  let state = null, busy = '', closed = false;
  const provider = () => $('[name=search-provider]:checked').value;
  const selectedState = () => state?.settings.connections?.[provider()] || {};
  const hasSavedKey = () => Boolean(selectedState().configured);
  function feedback(text, tone = '') {
    if (closed) return;
    $('#web-search-feedback').textContent = text;
    $('#web-search-feedback').dataset.tone = tone;
  }
  function paint() {
    if (closed) return;
    const settings = state?.settings;
    fields.disabled = Boolean(busy) || !state?.canManage;
    const optional = ['openalex', 'europepmc'].includes(provider());
    const usable = optional || hasSavedKey() || Boolean(key.value.trim());
    $('#web-search-save').disabled = !usable;
    $('#web-search-test').disabled = !usable;
    $('#web-search-remove').hidden = !hasSavedKey();
    $('.search-key-label').hidden = $('.search-key-input').hidden = provider() === 'europepmc';
    $('#web-search-key-help').replaceChildren();
    $('#web-search-key-help').textContent = provider() === 'europepmc' ? '无需注册或 API Key。HTTP 503 表示服务暂不可用；可单独测试或关闭。'
      : provider() === 'openalex' ? '匿名请求额度较低。免费 Key 可在 OpenAlex 账户设置获取；429 也可能表示额度已用尽。 '
      : '每个引擎独立加密保存，切换不会覆盖。多个引擎开启后并行检索并去重。';
    if (provider() === 'openalex') { const link = document.createElement('a'); link.href = 'https://openalex.org/settings/api'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '获取 OpenAlex Key ↗'; $('#web-search-key-help').append(link); }
    $('#web-search-key-state').textContent = key.value.trim() ? '新密钥 · 待保存' : hasSavedKey() ? '已保存 · 留空保留' : '尚未填写';
    key.placeholder = hasSavedKey() ? '已保存密钥；留空保留，无需重输' : provider() === 'openalex' ? '可选：填写 OpenAlex API Key' : `输入 ${provider() === 'tavily' ? 'Tavily' : provider() === 'serper' ? 'Serper' : 'Bing'} API Key`;
    badge.textContent = busy === 'test' ? '测试中' : busy === 'save' ? '保存中' : busy === 'remove' ? '移除中' : !state ? '未载入' : settings.unreadable ? '无法读取' : selectedState().enabled && (hasSavedKey() || optional) ? '已启用' : hasSavedKey() || optional ? '已关闭' : '待配置';
    badge.dataset.tone = selectedState().enabled && (hasSavedKey() || optional) ? 'ready' : '';
    $('#web-search-overview').textContent = `已启用网站引擎：${settings?.activeProviders?.join(' + ') || '尚未配置'}。密钥保存在服务端本机，输入框留空是正常的。`;
    for (const radio of host.querySelectorAll('[name=search-provider]')) {
      const row = settings?.connections?.[radio.value];
      radio.closest('label').dataset.saved = String(Boolean(row?.configured));
    }
    host.setAttribute('aria-busy', String(Boolean(busy)));
    for (const [id, action, label] of [['#web-search-test', 'test', '测试连接'], ['#web-search-save', 'save', '保存配置']]) {
      $(id).querySelector('span').textContent = busy === action ? (action === 'test' ? '正在测试…' : '正在保存…') : label;
      $(id).querySelector('svg').classList.toggle('spin', busy === action);
    }
  }
  function update(view, { clearKey = false } = {}) {
    state = view;
    const settings = view.settings;
    const selected = [...host.querySelectorAll('[name=search-provider]')].find(r => r.value === settings.provider);
    if (selected) selected.checked = true;
    $('#web-search-bing-option').hidden = !settings.connections?.bing?.configured;
    $('#web-search-enabled').checked = selectedState().configured || ['openalex', 'europepmc'].includes(provider()) ? selectedState().enabled : true;
    $('#web-search-fetch').checked = settings.fetchEnabled;
    if (clearKey) { key.value = ''; key.type = 'password'; $('#web-search-reveal').setAttribute('aria-pressed', 'false'); $('#web-search-reveal').setAttribute('aria-label', '显示正在填写的密钥'); }
    onChanged(view.capabilities);
    paint();
  }
  async function request(path, { method = 'GET', body, cancellable = true } = {}) {
    const timeout = AbortSignal.timeout(path.endsWith('/test') ? 25000 : 10000);
    const response = await apiFetch(path, { method, signal: cancellable ? AbortSignal.any([lifetime.signal, timeout]) : timeout,
      headers: { ...(body ? { 'content-type': 'application/json', 'x-settings-request': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '操作未完成，请稍后重试。');
    return result;
  }
  async function load() {
    if (busy || closed) return;
    busy = 'load'; paint(); feedback('正在读取搜索配置…'); $('#web-search-reload').hidden = true;
    try {
      const view = await request('/api/settings/web-search');
      if (closed) return;
      update(view, { clearKey: true });
      feedback(!view.canManage ? '请在运行服务的本机打开设置，以修改或测试搜索配置。'
        : view.settings.unreadable ? '本机保存的配置无法读取，请重新填写 API Key 后保存。'
        : view.settings.configured ? '已读取配置。可测试现有密钥，或填写新密钥后保存。' : '填写 API Key 后，可先测试连接再保存。');
    } catch { if (!closed) { feedback('配置读取失败，请重新读取后重试。', 'error'); $('#web-search-reload').hidden = false; } }
    finally { busy = ''; paint(); }
  }
  $('#web-search-reload').addEventListener('click', load);
  key.addEventListener('input', () => { drafts.set(provider(), key.value); paint(); feedback('新密钥尚未保存，可先测试连接。'); });
  for (const radio of host.querySelectorAll('[name=search-provider]')) radio.addEventListener('change', () => {
    key.value = drafts.get(provider()) || ''; key.type = 'password'; $('#web-search-reveal').setAttribute('aria-pressed', 'false');
    $('#web-search-enabled').checked = selectedState().configured || ['openalex', 'europepmc'].includes(provider()) ? selectedState().enabled : true;
    paint(); feedback(hasSavedKey() ? '已读取该服务的保存状态，密钥无需重新输入。' : '可单独配置此服务，其他服务的配置保留。');
  });
  for (const id of ['#web-search-enabled', '#web-search-fetch']) $(id).addEventListener('change', () => feedback('更改尚未保存。'));
  $('#web-search-reveal').addEventListener('click', () => {
    const show = key.type === 'password';
    key.type = show ? 'text' : 'password';
    $('#web-search-reveal').setAttribute('aria-pressed', String(show));
    $('#web-search-reveal').setAttribute('aria-label', show ? '隐藏正在填写的密钥' : '显示正在填写的密钥');
  });
  $('#web-search-test').addEventListener('click', async () => {
    if (busy || !state?.canManage) return;
    busy = 'test'; paint(); feedback('正在向搜索服务发送测试查询…');
    try {
      const result = await request('/api/settings/web-search/test', { method: 'POST', body: { provider: provider(), ...(key.value.trim() ? { apiKey: key.value.trim() } : {}) } });
      if (!closed) {
        feedback(`${result.message}${result.ok ? ` 返回 ${result.resultCount} 条 · ${result.elapsedMs} ms` : ''}${key.value.trim() ? ' 新密钥尚未保存。' : ''}`, result.ok ? 'success' : 'error');
        if (result.ok) animateState($('#web-search-feedback'));
      }
    } catch (err) { feedback(err.name === 'TimeoutError' ? '连接测试超时，请检查网络后重试。' : err.message || '连接测试失败，请重试。', 'error'); }
    finally { busy = ''; paint(); }
  });
  async function save(remove = false) {
    if (busy || !state?.canManage) return;
    busy = remove ? 'remove' : 'save'; paint(); feedback(remove ? '正在移除已保存的密钥…' : '正在保存搜索配置…');
    try {
      const body = remove ? { provider: provider(), revision: state.settings.revision } : { provider: provider(), apiKey: key.value.trim(),
        enabled: $('#web-search-enabled').checked, fetchEnabled: $('#web-search-fetch').checked, revision: state.settings.revision };
      const view = await request('/api/settings/web-search', { method: remove ? 'DELETE' : 'POST', body, cancellable: false });
      drafts.delete(provider());
      if (closed) onChanged(view.capabilities);
      else { update(view, { clearKey: true }); feedback(remove ? '当前服务密钥已移除，其他服务的配置保留。' : '配置已保存，后续提问立即生效。', 'success'); animateState($('#web-search-feedback')); }
    } catch (err) { feedback(err.message || '保存结果未确认，请重新打开设置核对。', 'error'); $('#web-search-reload').hidden = false; }
    finally { busy = ''; paint(); }
  }
  $('#web-search-form').addEventListener('submit', event => { event.preventDefault(); save(); });
  $('#web-search-remove').addEventListener('click', () => save(true));
  load();
  return () => { closed = true; lifetime.abort(); drafts.clear(); key.value = ''; key.type = 'password'; };
}
