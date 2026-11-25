import { activateWorkbenchPanel, showWorkbenchPanel } from './workbench-panels.js';
import { showDialog } from './dialog.js';
import { icon } from './icons.js';
import { escapeHtml } from '../agent/text.js';
import { animateIn, animateState } from './motion.js';

const labels = { queued: '排队中', running: '正在执行', completed: '已完成', failed: '未完成', cancelled: '已取消', interrupted: '服务重启后中断', awaiting_approval: '等待你处理' };
export function createAgentActivity({ apiFetch, onOpenConversation, button }) {
  let dialog, interval, events, refreshActive;
  const seen = new Set();
  const open = async () => {
    if(activateWorkbenchPanel('activity')) return;
    if (dialog?.open) return;
    dialog = document.createElement('dialog'); dialog.className = 'modal-mask';
    dialog.innerHTML = `<section class="modal activity-workbench"><div class="modal-head"><h2>${icon('activity', { size: 20 })} 任务中心</h2><button data-close aria-label="关闭">${icon('close')}</button></div><div class="activity-intro"><span class="activity-eyebrow">AGENT ACTIVITY</span><h3>每一步，都有进展</h3><p>服务运行时，后台任务会继续；需要回答或批准时会暂停。</p><p data-activity-feedback role="status"></p></div><div class="activity-list"></div></section>`;
    const current = dialog, life = new AbortController(), cards = new Map(); let refreshing = false, currentInterval;
    showWorkbenchPanel(dialog,'activity');
    if (button) { delete button.dataset.unread; button.title = '查看任务中心'; }
    const refresh = async () => {
      const host = current.querySelector('.activity-list'); if (!current.open || refreshing || life.signal.aborted) return;
      refreshing = true;
      try {
        const response = await apiFetch('/api/background', { signal: AbortSignal.any([life.signal, AbortSignal.timeout(15000)]) });
        if (!response.ok) throw new Error('任务列表暂不可用');
        const data = await response.json(); if (!host.isConnected) return;
        const tasks = data.tasks || [], ids = new Set(tasks.map(t => t.taskId));
        for (const [id, card] of cards) if (!ids.has(id)) { card.remove(); cards.delete(id); }
        host.querySelector('.activity-empty')?.remove();
        tasks.forEach((task, index) => {
          let card = cards.get(task.taskId); const fresh = !card;
          if (fresh) { card = document.createElement('article'); card.className = 'activity-card'; card.dataset.task = task.taskId; cards.set(task.taskId, card); }
          const status = Object.hasOwn(labels, task.status) ? task.status : 'failed';
          const html = `<div><span class="activity-state state-${status}">${escapeHtml(labels[status])}</span><time>${escapeHtml(new Date(task.createdAt).toLocaleString())}</time></div><h4>${escapeHtml(task.metadata?.title || '任务中心')}</h4><p>${escapeHtml((task.summary || task.events?.at(-1)?.text || '正在准备任务步骤').slice(0, 180))}</p><footer><button class="btn tiny" data-open="${escapeHtml(task.taskId)}">打开会话</button>${['running','queued'].includes(status) ? `<button class="btn tiny" data-cancel="${escapeHtml(task.taskId)}">停止任务</button>` : ''}</footer>`;
          if (card._content !== html) {
            const focused = card.contains(document.activeElement) ? document.activeElement : null;
            const action = focused?.matches('[data-cancel]') ? '[data-cancel]' : focused?.matches('[data-open]') ? '[data-open]' : null;
            card.innerHTML = html; card._content = html;
            if (!fresh && card._status !== status) animateState(card.querySelector('.activity-state'));
            card._status = status;
            if (action) (card.querySelector(action) || card.querySelector('[data-open]'))?.focus({ preventScroll: true });
          }
          if (host.children[index] !== card) host.insertBefore(card, host.children[index] || null);
          if (fresh) animateIn(card, { delay: Math.min(index, 3) * 35 });
        });
        if (!tasks.length) host.innerHTML = '<div class="activity-empty">这里会显示你的后台任务。<br>在输入框写好问题后，选择“后台运行”。</div>';
        current.querySelector('[data-activity-feedback]').textContent = '';
      } catch (error) { if (host.isConnected && !life.signal.aborted) current.querySelector('[data-activity-feedback]').textContent = error.message; }
      finally { refreshing = false; }
    };
    current.querySelector('.activity-list').addEventListener('click', async event => {
      const b = event.target.closest('[data-open], [data-cancel]'); if (!b || b.disabled) return;
      b.disabled = true;
      try {
        if (b.dataset.open) {
          const response = await apiFetch('/api/tasks/' + encodeURIComponent(b.dataset.open), { signal: life.signal }); const data = await response.json();
          if (!response.ok || !data.task?.conversationId) throw new Error('会话暂不可用，请刷新后重试。');
          current.addEventListener('close', () => onOpenConversation(data.task.conversationId), { once: true }); current.close();
        } else {
          const response = await apiFetch('/api/background/' + encodeURIComponent(b.dataset.cancel) + '/cancel', { method: 'POST', signal: life.signal, headers: { 'content-type': 'application/json' }, body: '{}' });
          if (!response.ok) throw new Error('任务已结束或停止失败，请刷新查看状态。');
          await refresh();
        }
      } catch (error) { if (!life.signal.aborted) current.querySelector('[data-activity-feedback]').textContent = error.message; }
      finally { if (b.isConnected) b.disabled = false; }
    });
    current.addEventListener('workbench:activate',refresh);
    refreshActive = refresh;
    await refresh(); if (!life.signal.aborted) interval = currentInterval = setInterval(() => { if (!document.hidden) refresh(); }, 4000);
  };
  button?.addEventListener('click', open);
  // The event channel carries server-authored status data only, never consent.
  if (typeof EventSource !== 'undefined') {
    events = new EventSource('/api/background/events');
    events.onmessage = event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      if (data.type !== 'task_notification' || seen.has(data.taskId + data.status)) return;
      seen.add(data.taskId + data.status);
      if (seen.size > 256) seen.delete(seen.values().next().value);
      if (dialog?.open) refreshActive?.();
      else if (button) { button.dataset.unread = 'true'; button.title = '有后台任务更新'; }
    };
  }
  return { open, close() { clearInterval(interval); events?.close(); dialog?.close(); } };
}

export function renderSubagent(host, event) {
  let card = [...host.querySelectorAll('.subagent-card')].find(c => c.dataset.agent === event.id);
  if (!card) { card = document.createElement('details'); card.className = 'subagent-card'; card.dataset.agent = event.id; host.append(card); }
  card.innerHTML = `<summary>${icon(event.status === 'running' ? 'loader' : event.status === 'completed' ? 'check' : 'warning', { size: 16 })}<span>${escapeHtml(event.goal || '并行研究')}</span><small>${escapeHtml(labels[event.status] || event.status)}</small></summary><p>${escapeHtml(event.summary || '子任务正在独立执行，结果会交回主任务核对与整合。')}</p>`;
}
