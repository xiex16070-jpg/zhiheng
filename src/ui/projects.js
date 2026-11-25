import { escapeHtml as esc } from '../agent/text.js';
import { icon } from './icons.js';

function conversationDay(value) {
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '较早';
  const now=new Date(),day=new Date(date.getFullYear(),date.getMonth(),date.getDate()),today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const diff=Math.round((today-day)/86400000);return diff===0?'今天':diff===1?'昨天':diff<7?'近七天':'较早';
}

/** Independent sidebar controller. It never sends a chat or changes permissions. */
export function createProjectSidebar({ host, apiFetch, onProjectChange, onOpenConversation, onNewConversation, onDeleteConversation, onUpdated }) {
  let data = null, activeConversationId = null, loading = false, disposed = false;
  const collapsed = new Set(), initialized = new Set();
  const life = new AbortController();
  host.classList.add('project-sidebar');
  host.innerHTML = `<div class="project-heading"><span>项目</span><button type="button" data-project-add aria-label="添加项目文件夹" title="添加项目文件夹">${icon('plus', { size: 17 })}</button></div><div class="project-feedback" role="status"></div><div class="project-tree"></div>`;
  const feedback = text => { if (!disposed) host.querySelector('.project-feedback').textContent = text || ''; };
  const headers = { 'content-type': 'application/json', 'x-workspace-picker': '1' };
  async function request(endpoint, body) {
    const response = await apiFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: life.signal });
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || '项目操作未完成，请稍后重试。');
    return value;
  }
  function render() {
    if (!data || disposed) return;
    const tree = host.querySelector('.project-tree');
    host.querySelector('[data-project-add]').disabled = loading || !data.canChoose;
    tree.innerHTML = data.projects.map(project => {
      const chats = data.conversations.filter(c => (c.workspaceId || 'default') === project.id);
      const selected = project.id === data.activeId;
      const folded = collapsed.has(project.id);
      let previousDay='';const dayHeading=chat=>{const day=conversationDay(chat.updatedAt || chat.createdAt);if(previousDay===day)return '';previousDay=day;return `<p class="project-date-group">${day}</p>`;};
      return `<section class="project-group${selected ? ' is-current' : ''}${project.available ? '' : ' is-unavailable'}" data-project="${esc(project.id)}">
        <div class="project-row"><button type="button" class="project-fold" data-project-fold="${esc(project.id)}" aria-expanded="${!folded}" aria-label="${folded ? '展开' : '收起'}${esc(project.name)}">${icon('chevron-right', { size: 12 })}</button><button type="button" class="project-title" data-project-select="${esc(project.id)}" title="${esc(project.name)}"${project.removed ? ' disabled' : ''}>${icon('folder', { size: 19 })}<span>${esc(project.name)}</span>${selected ? '<i aria-label="当前项目"></i>' : ''}</button>${project.removed ? '' : `<button type="button" class="project-new" data-project-new="${esc(project.id)}" aria-label="在${esc(project.name)}新建会话" title="新建会话">${icon('plus', { size: 15 })}</button>`}</div>
        <div class="project-children"${folded ? ' hidden' : ''}>${!project.available ? `<p class="project-unavailable">${project.removed ? '保留会话 · 重新添加文件夹后可继续' : '文件夹暂不可用'}</p>` : ''}
          ${chats.length ? chats.map(chat => `${dayHeading(chat)}<div class="project-conversation${chat.id === activeConversationId ? ' is-active' : ''}"><button type="button" data-project-chat="${esc(chat.id)}" title="${esc(chat.title)}"${chat.id === activeConversationId ? ' aria-current="page"' : ''}><span>${esc(chat.title || '新会话')}</span></button><button type="button" data-project-delete-chat="${esc(chat.id)}" aria-label="删除会话${esc(chat.title)}" title="删除会话">${icon('close', { size: 12 })}</button></div>`).join('') : '<p class="project-empty">暂无会话</p>'}
          ${project.id !== 'default' && !project.removed ? `<details class="project-options"><summary>项目选项</summary><form data-project-rename="${esc(project.id)}"><label>项目名称<input name="name" value="${esc(project.name)}" maxlength="80" required aria-label="项目名称"></label><button type="submit">保存</button></form><button type="button" data-project-remove="${esc(project.id)}">从侧栏移除</button><p>保留文件夹与所有会话</p></details>` : ''}
        </div></section>`;
    }).join('');
  }
  async function refresh({ conversationId = activeConversationId } = {}) {
    if (loading || disposed) return data;
    loading = true; activeConversationId = conversationId;
    try {
      const response = await apiFetch('/api/projects', { signal: AbortSignal.any([life.signal, AbortSignal.timeout(15000)]) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.message || '项目列表暂不可用。');
      if (disposed) return;
      data = next;
      for (const project of data.projects) if (!initialized.has(project.id)) {
        initialized.add(project.id);
        if (project.id !== data.activeId) collapsed.add(project.id);
      }
      onUpdated?.(data); feedback('');
    } catch (error) { if (!life.signal.aborted) feedback(error.message); }
    finally { loading = false; render(); }
    return data;
  }
  async function select(id) {
    if (data.activeId === id) return data.projects.find(p => p.id === id);
    const result = await request(`/api/projects/${id}/select`, {});
    data.activeId = result.workspace.id;
    collapsed.delete(id);
    await onProjectChange?.(result.workspace);
    return result.workspace;
  }
  host.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || button.disabled || loading) return;
    if (button.dataset.projectFold) {
      const id = button.dataset.projectFold;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id); render();
      host.querySelector(`[data-project-fold="${CSS.escape(id)}"]`)?.focus(); return;
    }
    button.disabled = true; feedback('');
    try {
      if (button.hasAttribute('data-project-add')) {
        feedback('请在系统窗口中选择项目文件夹…');
        const result = await request('/api/projects', { action: 'choose' });
        if (!result.cancelled) { await onProjectChange?.(result.workspace); collapsed.delete(result.workspace.id); }
      } else if (button.dataset.projectSelect) await select(button.dataset.projectSelect);
      else if (button.dataset.projectNew) { await select(button.dataset.projectNew); await onNewConversation?.(button.dataset.projectNew); }
      else if (button.dataset.projectChat) {
        const chat = data.conversations.find(c => c.id === button.dataset.projectChat);
        const project = data.projects.find(p => p.id === (chat.workspaceId || 'default'));
        if (project && !project.removed) await select(project.id);
        activeConversationId = chat.id; await onOpenConversation?.(chat.id, project);
      } else if (button.dataset.projectDeleteChat) await onDeleteConversation?.(button.dataset.projectDeleteChat);
      else if (button.dataset.projectRemove) {
        const result = await request(`/api/projects/${button.dataset.projectRemove}/remove`, {});
        if (data.activeId !== result.workspace.id) await onProjectChange?.(result.workspace);
      } else return;
      await refresh();
    } catch (error) { if (!life.signal.aborted) feedback(error.message); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  host.addEventListener('submit', async event => {
    const form = event.target.closest('[data-project-rename]'); if (!form) return;
    event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
    try { await request(`/api/projects/${form.dataset.projectRename}/rename`, { name: new FormData(form).get('name') }); await refresh(); }
    catch (error) { if (!life.signal.aborted) feedback(error.message); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  return { refresh, select, setActiveConversation(id) {
    activeConversationId = id;
    for (const button of host.querySelectorAll('[data-project-chat]')) {
      const active = button.dataset.projectChat === id;
      button.closest('.project-conversation').classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    }
  }, dispose() { disposed = true; life.abort(); } };
}
