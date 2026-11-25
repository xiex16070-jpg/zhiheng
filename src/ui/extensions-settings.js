import { icon } from './icons.js';
import { escapeHtml as esc } from '../agent/text.js';

export function mountExtensions(host, { apiFetch = fetch } = {}) {
  host.innerHTML = `<section class="search-settings-card extensions-card" id="extensions-settings" aria-labelledby="extensions-title">
    <header class="search-settings-heading"><span class="search-settings-emblem">${icon('workspace', { size: 22 })}</span><div><span class="search-settings-eyebrow">AGENT / CAPABILITIES</span><h3 id="extensions-title">能力与插件</h3><p>文档制作 · 浏览器操作 · MCP 扩展</p></div></header>
    <div class="capability-grid" id="capability-grid"></div><div class="extension-list" id="extension-list"></div>
    <div class="extension-shortcuts"><button type="button" class="btn" id="extension-browser">${icon('plus', { size: 15 })}启用浏览器工具</button><button type="button" class="btn" id="extension-reload">${icon('refresh', { size: 15 })}刷新状态</button></div>
    <details class="extension-preset" id="context7-setup"><summary><strong>Context7 · 版本化技术文档</strong><span id="context7-state">读取状态…</span>${icon('chevron-down', { size: 14 })}</summary>
      <div class="extension-item-body"><form id="context7-form" autocomplete="off">
        <p class="search-settings-note">在提问中写明库名与版本，例如「Vue 3.5 的 watch 如何清理副作用？」可查版本取决于 Context7 收录的文档。</p>
        <label class="extension-field">Context7 API Key（可选）<input id="context7-key" type="password" maxlength="2048" autocomplete="new-password" spellcheck="false" aria-describedby="context7-key-hint"></label>
        <p class="search-settings-note" id="context7-key-hint"><span id="context7-credential-state">可先尝试匿名连接。</span> <a href="https://context7.com/dashboard" target="_blank" rel="noopener noreferrer">在 Context7 管理 Key 与配额</a></p>
        <label class="extension-enabled" id="context7-clear-row" hidden><input id="context7-clear" type="checkbox">改用匿名连接；验证成功后清除已保存的 Key</label>
        <p class="search-settings-note" id="context7-sharing">连接时读取工具目录。查询前会逐次请你审批，获批的库名、版本和问题将发送给 Context7。请只发送可公开的技术问题。</p>
        <label class="extension-enabled"><input id="context7-consent" type="checkbox" aria-describedby="context7-sharing">同意连接 mcp.context7.com</label>
        <div class="search-settings-actions"><button type="submit" class="btn search-save" id="context7-discover" disabled>连接并发现工具</button><button type="button" class="btn" id="context7-permissions" hidden>管理工具权限</button></div>
        <div class="search-settings-feedback" id="context7-feedback" role="status" aria-live="polite"></div>
      </form></div>
    </details>
    <details class="extension-add"><summary>连接 MCP 插件 ${icon('plus', { size: 15 })}</summary>
      <form id="extension-form" autocomplete="off"><div class="search-provider-options" role="group" aria-label="MCP 连接方式"><label><input type="radio" name="extension-kind" value="http" checked><span><strong>HTTP 服务</strong><small>Streamable HTTP</small></span></label><label><input type="radio" name="extension-kind" value="stdio"><span><strong>本地进程</strong><small>stdio</small></span></label></div>
        <label class="extension-field">插件名称<input id="extension-name" maxlength="80" required placeholder="例如：我的桌面工具"></label>
        <div id="extension-http"><label class="extension-field">MCP 地址<input id="extension-url" type="url" maxlength="500" placeholder="https://example.com/mcp"></label><label class="extension-field">访问令牌（可选）<input id="extension-token" type="password" autocomplete="new-password" maxlength="2048"></label></div>
        <div id="extension-stdio" hidden><label class="extension-field">可执行文件绝对路径<input id="extension-command" maxlength="500" placeholder="C:\\Program Files\\nodejs\\node.exe"></label><label class="extension-field">参数数组<textarea id="extension-args" rows="2" maxlength="8000" placeholder='["D:/tools/my-mcp-server.mjs"]'></textarea></label><label class="extension-field">环境变量（可选，加密保存）<textarea id="extension-env" rows="2" maxlength="8000" spellcheck="false" placeholder='{"SERVICE_API_KEY":"..."}'></textarea></label></div>
        <p class="search-settings-note" id="extension-trust-note">连接将发现服务支持的工具与资源。保存后分别启用，实际调用仍需审批。</p><button type="submit" class="btn search-save">连接并发现能力</button></form>
    </details><div id="extension-feedback" class="search-settings-feedback" role="status" aria-live="polite">读取能力状态…</div>
  </section>`;
  const $ = s => host.querySelector(s), life = new AbortController();
  let state, busy = false, closed = false;
  const feedback = (text, error = false) => { if (!closed) { $('#extension-feedback').textContent = text; $('#extension-feedback').dataset.tone = error ? 'error' : 'success'; } };
  const context7Entry = () => state?.entries.find(entry => entry.preset === 'context7');
  function syncContext7() {
    const entry = context7Entry(), savedKey = entry?.tokenConfigured === true;
    $('#context7-state').textContent = !state ? '状态未读取' : !entry ? '未连接' : entry.enabled ? '已启用' : '已连接 · 未启用';
    $('#context7-key').placeholder = savedKey ? '留空保留已保存的 Key' : '留空尝试匿名连接';
    $('#context7-credential-state').textContent = savedKey ? 'Key 已保存。填写新 Key 并验证即可更换。' : '可先尝试匿名连接。';
    $('#context7-clear-row').hidden = !savedKey;
    if (!savedKey) $('#context7-clear').checked = false;
    $('#context7-key').disabled = busy || $('#context7-clear').checked;
    $('#context7-clear').disabled = $('#context7-consent').disabled = busy;
    $('#context7-discover').disabled = busy || !state || !$('#context7-consent').checked;
    $('#context7-discover').textContent = entry ? '验证并保存连接' : '连接并发现工具';
    $('#context7-permissions').hidden = !entry;
  }
  async function request(method = 'GET', body) {
    const r = await apiFetch('/api/settings/extensions', { method, signal: AbortSignal.any([life.signal, AbortSignal.timeout(50000)]), headers: body ? { 'content-type': 'application/json', 'x-settings-request': '1' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await r.json(); if (!r.ok) throw new Error(data.message || '插件操作失败'); return data;
  }
  function paint() {
    if (closed || !state) return;
    const c = state.capabilities;
    $('#capability-grid').innerHTML = [['PDF 报告',c.pdf,'中文、表格、图片'],['Word 文档',c.docx,'新建可编辑 DOCX'],['浏览器操作',c.browser,'隔离会话 · 逐次审批'],['MCP 网关',c.mcpGateway,'工具与只读资源'],['技能库',c.skills,'任务流程与知识'],['原生桌面',false,'不接管私人桌面或登录态']].map(([name,ready,note]) => `<div class="capability-cell" data-ready="${ready}"><strong>${esc(name)}</strong><small>${esc(note)}</small><span>${ready ? '引擎可用' : name === '原生桌面' ? '未内置' : '未就绪'}</span></div>`).join('');
    $('#extension-browser').disabled = busy || !c.browser || state.entries.some(e => e.id === 'browser');
    $('#extension-list').innerHTML = state.entries.map(e => `<details class="extension-item" data-id="${esc(e.id)}">
      <summary><strong>${esc(e.name)}${e.preset === 'context7' ? ' · 工具权限' : ''}</strong><span>${e.enabled ? '已启用' : '已关闭'} · ${e.tools.filter(t => t.allowed).length} 项工具${e.resourcesEnabled ? ' · 只读资源' : ''}</span>${icon('chevron-down', { size: 14 })}</summary>
      <div class="extension-item-body"><p>${esc(e.target)}</p><label class="extension-enabled"><input type="checkbox" data-enabled ${e.enabled ? 'checked' : ''}>启用此插件</label>
      ${e.preset === 'context7' ? '<p class="search-settings-note">勾选允许使用的文档工具并启用插件。每次外发查询都要单独审批。</p>' : ''}
      ${e.kind !== 'browser' && e.preset !== 'context7' ? `<label class="integration-toggle"><input type="checkbox" data-resources ${e.resourcesEnabled ? 'checked' : ''} ${e.serverCapabilities?.resources ? '' : 'disabled'}><span><strong>允许读取资源目录与正文</strong><small>${e.serverCapabilities?.resources ? '仅当前任务已发现的资源；可单独预先授权只读访问，模板不展开任意地址。' : '服务尚未声明资源能力；重新连接后可更新检测结果。'}</small></span></label>` : ''}
      ${e.kind !== 'browser' && e.preset !== 'context7' && e.serverCapabilities?.resources ? `<label class="integration-toggle"><input type="checkbox" data-resource-readonly ${e.readOnlyResources ? 'checked' : ''}><span><strong>预先授权只读资源访问</strong><small>限已启用的此连接；修改、下载和其他操作继续审批。</small></span></label>` : ''}
      <div class="extension-tool-list">${e.tools.map(t => `<label><input type="checkbox" data-tool="${esc(t.name)}" ${t.allowed ? 'checked' : ''}><span><strong>${esc(t.name)}</strong><small>${esc(t.description)}</small></span></label>${t.readOnly && e.preset !== 'context7' ? `<label class="extension-readonly"><input type="checkbox" data-readonly-tool="${esc(t.name)}" ${e.readOnlyTools?.includes(t.name) ? 'checked' : ''}><span>预先授权此只读工具</span></label>` : ''}` ).join('')}</div>
      <div class="search-settings-actions"><button type="button" class="btn" data-action="save">保存权限</button>${e.preset === 'context7' ? '' : '<button type="button" class="btn" data-action="test">重新连接</button>'}<button type="button" class="search-remove" data-action="remove">移除插件</button></div></div></details>`).join('') || '<p class="search-settings-note">尚未启用外部插件。文档生成工具可直接在对话中使用。</p>';
    syncContext7();
  }
  async function act(body, remove = false) {
    if (busy || !state) return;
    busy = true; host.setAttribute('aria-busy', 'true');
    for (const b of host.querySelectorAll('button')) b.disabled = true;
    const preset = body.preset === 'context7';
    const removingContext7 = remove && body.id === context7Entry()?.id;
    const message = preset ? (text, error = false) => {
      $('#context7-feedback').textContent = text;
      $('#context7-feedback').dataset.tone = error ? 'error' : 'success';
    } : feedback;
    syncContext7();
    message(preset ? '正在连接 Context7 并读取工具目录…' : '正在连接或保存…');
    try {
      state = await request(remove ? 'DELETE' : 'POST', { ...body, revision: state.revision });
      if (closed) return;
      $('#extension-token').value = ''; $('#extension-env').value = '';
      if (preset || removingContext7) {
        $('#context7-key').value = '';
        $('#context7-consent').checked = $('#context7-clear').checked = false;
        $('#context7-feedback').textContent = '';
      }
      paint();
      message(preset ? `已连接，发现 ${context7Entry().tools.length} 项工具。请在「管理工具权限」中查看启用状态。` : '已保存。启用的工具将在后续任务中可用。');
    } catch (err) { if (!closed) message(err.message, true); }
    finally {
      busy = false; host.removeAttribute('aria-busy');
      if (!closed) {
        for (const b of host.querySelectorAll('button')) b.disabled = false;
        $('#extension-browser').disabled = !state.capabilities.browser || state.entries.some(e => e.id === 'browser');
        syncContext7();
      }
    }
  }
  async function load() {
    if (busy) return;
    try {
      const latest = await request();
      if (closed || busy || (state && latest.revision < state.revision)) return;
      state = latest; paint();
      feedback('文件产物保存到当前工作区。外部插件按用户隔离；仅明确授权的只读访问可免审批。');
    } catch (err) { if (!closed) syncContext7(); feedback(err.message, true); }
  }
  $('#extension-browser').addEventListener('click', () => act({ id: 'browser', name: '知衡浏览器', kind: 'browser', enabled: true }));
  $('#extension-reload').addEventListener('click', load);
  $('#context7-consent').addEventListener('change', syncContext7);
  $('#context7-clear').addEventListener('change', syncContext7);
  $('#context7-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('#context7-consent').checked) return;
    const token = $('#context7-key').value.trim();
    const auth = $('#context7-clear').checked ? { clearToken: true } : token ? { token } : {};
    act({ preset: 'context7', ...auth });
  });
  $('#context7-permissions').addEventListener('click', () => {
    const card = [...host.querySelectorAll('#extension-list [data-id]')].find(el => el.dataset.id === context7Entry()?.id);
    if (card) { card.open = true; card.querySelector('summary').focus(); }
  });
  $('#extension-list').addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const card = button.closest('[data-id]');
    if (button.dataset.action === 'save' && card.dataset.id === context7Entry()?.id) {
      act({ id: card.dataset.id, enabled: card.querySelector('[data-enabled]').checked,
        allowedTools: [...card.querySelectorAll('[data-tool]:checked')].map(el => el.dataset.tool) });
      return;
    }
    act({ id: card.dataset.id, ...(button.dataset.action === 'save' ? { enabled: card.querySelector('[data-enabled]').checked, allowedTools: [...card.querySelectorAll('[data-tool]:checked')].map(el => el.dataset.tool), resourcesEnabled: card.querySelector('[data-resources]')?.checked === true, readOnlyResources: card.querySelector('[data-resources]')?.checked === true && card.querySelector('[data-resource-readonly]')?.checked === true, readOnlyTools:[...card.querySelectorAll('[data-readonly-tool]:checked')].map(el=>el.dataset.readonlyTool).filter(name=>[...card.querySelectorAll('[data-tool]:checked')].some(el=>el.dataset.tool===name)) } : button.dataset.action === 'test' ? { test: true } : {}) }, button.dataset.action === 'remove');
  });
  for (const radio of host.querySelectorAll('[name=extension-kind]')) radio.addEventListener('change', () => { const stdio = radio.value === 'stdio'; $('#extension-http').hidden = stdio; $('#extension-stdio').hidden = !stdio; $('#extension-trust-note').textContent = stdio ? '连接会启动指定的本机程序。仅添加你信任的程序；工作区目录不是操作系统沙箱。参数不经过 shell，密钥使用环境变量字段。' : '连接将读取服务的工具目录。保存后按工具启用，实际调用仍需审批。'; });
  $('#extension-form').addEventListener('submit', event => {
    event.preventDefault(); const kind = $('[name=extension-kind]:checked').value;
    try { act({ name: $('#extension-name').value.trim(), kind, enabled: false, ...(kind === 'http' ? { url: $('#extension-url').value.trim(), token: $('#extension-token').value.trim() } : { command: $('#extension-command').value.trim(), args: JSON.parse($('#extension-args').value || '[]'), env: JSON.parse($('#extension-env').value || '{}') }) }); }
    catch { feedback('参数和环境变量必须是有效 JSON。', true); }
  });
  load();
  return () => { closed = true; life.abort(); $('#context7-key').value = ''; $('#extension-token').value = ''; $('#extension-env').value = ''; };
}
