import { renderSupportReview, decorateSupport } from './judge-settings.js';
import { mountPublicationReview, reviewableCitation, showCitationReviews } from './publication-review.js';
import { terminalPresentation, canResumeTask, taskScopeSignature } from './task-state.js';
import { bindTabs } from './tabs.js';
import { installFormFeedback } from './form-feedback.js';
import { activateWorkbenchPanel, showWorkbenchPanel, configureWorkbenchPanels } from './workbench-panels.js';
import { openCommandPalette } from './command-palette.js';
import { createTimeline } from './timeline.js';
import { disclosureSummary } from './disclosure.js';
import { renderSkillEffectiveness } from './integration-settings.js';
import { createAgentActivity, renderSubagent } from './agent-activity.js';
import { createCapabilityNavigator } from './capabilities.js';
import { playStudioIntro, mountStudioInteractions } from './studio.js';
import { createProjectSidebar } from './projects.js';
import { createArtifactPreview, artifactPreviewUrl } from './artifact-preview.js';
import { openFilePermissions, renderFileReview } from './file-permissions.js';
import { mountDictation } from './dictation.js';
import { renderVisualization } from './visualization.js';
/**
 * 应用外壳：会话记忆、工作流轨迹、文献依据、审批卡片、运行监控。
 */

import { citedSources, escapeHtml, formatBibliography } from '../agent/text.js';
import { renderMarkdown } from './markdown.js';
import { createAnswerPreview } from './answer-preview.js';
import { showDialog } from './dialog.js';
import { openConfiguration } from './configuration.js';
import { openKnowledgeWorkbench } from './knowledge-workbench.js';
import { renderConversationProfile } from './conversation-profile.js';
import { createReader } from './reader.js';
import { openSettings, loadProvider, restoreProvider, isConfigured } from './settings.js';
import { animateIn, animateState } from './motion.js';
import { icon, brandMark } from './icons.js';
import { openLogicWorkbench, appendLogicResult } from './logic.js';
import './preferences-panel.js';
import { createPreferenceStore } from './preference-store.js';
import { renderLibrary, openSectionEditor } from './library.js';
import './question-index.js';
import { authorityLabel, appendJointReport } from './joint-research.js';

const STEP_LABEL = {
  intake: '载入上下文',
  retrieve: '检索文献',
  selected_source: '读取所选资料',
  authority_retrieve: '检索权威外部来源',
  evidence_mix: '合并本地与外部证据',
  research_ircot: '按证据逐步追检',
  research_tot: '比较候选分支',
  verify: '校验引用',
  approval: '等待审批',
  finalize: '整理答案',
  persist: '保存结果',
  compact: '上下文压缩',
  local_context_compact: '整理已读资料',
  answer_contract_repair: '核对回答格式与引文',
  inference_audit: '推断核查',
  search_knowledge: '检索知识库',
  read_source: '阅读来源原文',
  verify_quote: '核对逐字引文',
  logic_evaluate_grounded: '按文献规则验算',
  logic_run_assumptions: '按给定假设验算',
  logic_evaluate: '运行规则验算',
  propose_logic_program: '确认逻辑前提',
  current_time: '读取当前时间',
  web_search: '搜索网站',
  web_fetch: '读取网页',
  scholar_search: '检索学术文献',
  run_command: '执行命令',
  read_file: '读取项目文件',
  write_file: '写入项目文件',
  patch_file: '修改项目文件',
  delegate_task: '委派子任务',
  start_background_task: '启动后台任务',
};

const STEP_STATE = {
  running: ['loader', '进行中'], ok: ['check', '已完成'], error: ['close', '失败'],
  tripped: ['stop', '已停止'], skipped: ['chevron-right', '已跳过'], paused: ['pause', '等待确认'],
  ended: ['clock', '已结束'], returned: ['undo', '工具已返回'],
};

function stepLabel(name) {
  if (/^reason#\d+$/.test(name)) return `模型调用 #${name.split('#')[1]}`;
  return STEP_LABEL[name] || name.replace(/#(\d+)/, ' #$1');
}

const AUDIT_LABEL = {
  pass: { cls: 'pass', icon: 'check', text: '模型认为支持' },
  weak: { cls: 'weak', icon: 'warning', text: '证据不足' },
  fail: { cls: 'fail', icon: 'close', text: '模型不支持' },
  skip: { cls: 'skip', icon: 'clock', text: '未审核' },
};

const state = {
  user: null,
  conversations: [],
  workspaceId: 'default',
  workspaceName: '个人工作区',
  corpus: null,
  stack: null,
  conversationId: null,
  kb: [],
  sections: [],
  corpusFiles: [],
  provider: loadProvider(),
  focusedSource: null,
  busy: false,
  abort: null,
  lastTaskId: null,
  selectedSkill: null,
  researchStrategy: null,
  taskMode: 'agent',
  queue: [], // 追问队列（busy 时 Enter 入队，任务完成后依次发送）
  queueTimer: null,
  viewVersion: 0,
  historyAbort: null,
};

const el = {};
let preferenceStore;
let indexDiscipline = '';
let agentActivity;
let projectSidebar;
let artifactPreview;
let configure;

function paintFocusedSource() {
  const chip=document.getElementById('focused-source-chip');if(!chip)return;
  chip.hidden=!state.focusedSource;
  chip.querySelector('span').textContent=state.focusedSource?.docId ? '仅所选文档' : '已选原文';
  chip.title=state.focusedSource?.label || '取消已选原文';
  paintTaskContext();
}

function paintTaskContext() {
  const host = document.getElementById('task-context');
  if (!host) return;
  const preferences = preferenceStore?.current() || {};
  host.querySelector('[data-context-project]').textContent = state.workspaceName;
  const scope = state.focusedSource?.docId ? `仅此文档：${state.kb.find(doc => doc.id === state.focusedSource.docId)?.name || '所选文档'}` : state.focusedSource ? '已选原文' :
    state.sections.find(section => section.id === preferences.discipline)?.name || preferences.discipline || '全部知识库';
  const scopeButton = host.querySelector('[data-context-scope]');
  scopeButton.hidden = state.taskMode !== 'knowledge';
  scopeButton.querySelector('span').textContent = `资料范围 · ${scope}`;
  scopeButton.title = state.focusedSource?.label || `调整资料范围：${scope}`;
}

function fillDraft(question) {
  el.input.value = question;
  el.input.dispatchEvent(new Event('input'));
  el.input.focus();
  document.getElementById('hint-right').textContent = '已放入草稿，发送时使用当前项目、模式与设置。';
  document.getElementById('hint-right').dataset.draft = 'true';
}

async function resumeFailedTask(taskId) {
  if (state.busy) throw new Error('请先等待或停止当前任务。');
  const originView = state.viewVersion, originWorkspace = state.workspaceId;
  const controller = new AbortController();
  state.abort = controller;
  state.busy = true; setSendState(true);
  let replay;
  let paused = false;
  let cancelled = false;
  try {
    const response = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`, { signal: controller.signal });
    if (!response.ok) throw new Error('任务不存在或不可访问。');
    const { task } = await response.json();
    controller.signal.throwIfAborted();
    if (originView !== state.viewVersion || originWorkspace !== state.workspaceId) {
      throw new Error('会话已切换，本次恢复未开始。');
    }
    if (!canResumeTask(task)) throw new Error('当前任务不能恢复，请查看任务状态或修改问题后重新发送。');
    if ((task.checkpoint?.workspaceId || 'default') !== state.workspaceId) throw new Error('请先切换回任务原来的项目，再恢复。');
    if (!isConfigured(state.provider)) throw new Error('请先配置本次恢复使用的模型。');
    const opened = await openConversation(task.conversationId, { signal: controller.signal });
    controller.signal.throwIfAborted();
    if (!opened || opened.viewVersion !== state.viewVersion || state.conversationId !== task.conversationId ||
        (task.checkpoint?.workspaceId || 'default') !== state.workspaceId) {
      throw new Error('会话未能加载或已切换，本次恢复未开始。');
    }
    replay = createAssistantNode(task.question);
    await streamPost(`/api/tasks/${encodeURIComponent(taskId)}/resume`, { provider: state.provider }, ev => {
      if (ev.type === 'approval_required') paused = true;
      if (ev.type === 'done' || ev.type === 'error') paused = false;
      if (ev.type === 'error' && terminalPresentation(ev).state === 'stopped') cancelled = true;
      replay.onEvent(ev);
    }, controller.signal);
  } catch (error) {
    cancelled = controller.signal.aborted || error.name === 'AbortError';
    if (!replay) {
      document.getElementById('hint-right').textContent = cancelled ? '已停止恢复，未开始新的执行。' : error.message;
      if (!cancelled) throw error;
      return;
    }
    const recovered = error.code === 'stream_incomplete' ? await reconcileTask(taskId, replay) : { recovered: false };
    paused = Boolean(recovered.paused);
    cancelled ||= controller.signal.aborted || Boolean(recovered.cancelled);
    if (!recovered.recovered) replay.onEvent({ type: 'error', taskId, cancelled, message: error.message });
  } finally {
    if (state.abort === controller) { state.busy = false; state.abort = null; setSendState(false); }
    replay?.setBusy(false);
    if (cancelled) state.queue = [];
    renderQueueChips();
    if (replay && !paused && !cancelled) drainQueueForCurrent();
    refreshConversations();
  }
}

function mountRecoveryActions(host, taskId, question) {
  const actions = document.createElement('div'); actions.className = 'task-recovery';
  const feedback = document.createElement('span'); feedback.setAttribute('role', 'status');
  if (question) {
    const draft = document.createElement('button'); draft.type = 'button'; draft.className = 'btn';
    draft.textContent = '修改后重新发送'; draft.addEventListener('click', () => fillDraft(question)); actions.append(draft);
  }
  actions.append(feedback); host.append(actions);
  if (!taskId) return;
  const check = async () => {
    feedback.textContent = '正在核对恢复条件…';
    try {
      const response = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);
      if (!response.ok) throw new Error('任务状态暂不可用');
      const { task } = await response.json();
      if (!actions.isConnected) return;
      feedback.textContent = canResumeTask(task) ? '恢复会核对原任务范围与当前权限，使用当前模型。' : task.status === 'cancelled' ? '已停止的任务不能接续，可修改问题后重新发送。' : '当前状态不支持失败恢复。';
      if (canResumeTask(task)) {
        const resume = document.createElement('button'); resume.type = 'button'; resume.className = 'btn primary';
        resume.textContent = '恢复失败任务'; actions.prepend(resume);
        resume.addEventListener('click', async () => {
          resume.disabled = true;
          try { await resumeFailedTask(taskId); }
          catch (error) { if (actions.isConnected) { feedback.textContent = error.message; resume.disabled = false; } }
        });
      }
    } catch {
      if (!actions.isConnected) return;
      feedback.textContent = '未能核对任务状态。';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn'; retry.textContent = '重新核对';
      retry.onclick = () => { retry.remove(); check(); }; actions.append(retry);
    }
  };
  check();
}

function setTaskMode(mode) {
  state.taskMode = mode === 'knowledge' ? 'knowledge' : 'agent';
  document.querySelectorAll('[data-task-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.taskMode === state.taskMode)));
  const switcher = document.getElementById('task-mode-switch');
  if (switcher) switcher.dataset.mode = state.taskMode;
  el.input.placeholder = state.taskMode === 'knowledge' ? '围绕知识库研究，核对来源并积累结论…' : '描述你的目标，或让知衡处理项目中的文件…';
  document.getElementById('joint-research-trigger').hidden = state.taskMode !== 'knowledge';
  if (state.taskMode === 'agent') { state.focusedSource = null; setResearchStrategy(null); }
  paintFocusedSource();
  const empty = el.messages.querySelector('.empty');
  if (empty && empty.dataset.mode !== state.taskMode) renderEmptyState();
}

function openCommands() {
  openCommandPalette({conversations:state.conversations,onConversation:openConversation,actions:[
    {label:'新建会话',run:newConversation},{label:'知识库工作台',run:openKnowledge},{label:'任务活动',run:()=>agentActivity.open()},
    {label:'学习与记忆',run:()=>openLearn()},{label:'项目文件夹',run:openWorkspace},{label:'设置',run:()=>configure?.()},{label:'切换主题',run:toggleTheme}
  ]});
}
configureWorkbenchPanels({knowledge:openKnowledge,activity:()=>agentActivity?.open(),learning:()=>openLearn()});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'&&!event.shiftKey&&!event.altKey&&!event.isComposing){event.preventDefault();openCommands();}});

function openKnowledge(initialTab) {
  el.closeSidebar?.();
  openKnowledgeWorkbench({ apiFetch, initialTab: typeof initialTab === 'string' ? initialTab : undefined, onImport: () => document.getElementById('file-input').click(),
    onResearch({ question = '', refs = [], docId = null, docIds = [] } = {}) {
      setTaskMode('knowledge');
      const scope=preferenceStore.current().discipline || '';
      const section=state.sections.find(item=>item.id===scope);
      if(!docId && docIds.length && scope && (!section || !docIds.every(id=>section.docIds.includes(id)))) {
        refs=[];
        question+='\n仅使用当前资料范围；所需原文不在范围内时，请明确说明证据缺口，不扩大范围。';
      }
      el.input.value = question; el.input.dispatchEvent(new Event('input'));
      state.focusedSource = refs[0] ? {ref:refs[0],question,docId,sticky:true,scope} : null;
      paintFocusedSource();
      el.input.focus();
    },
    onSource: source => el.reader.open(source.ref, { start:source.start, end:source.end, quote:source.quote, fresh:true }),
  });
}

function paintFilePermission(permission) {
  const button = document.getElementById('file-permission-trigger');
  if (!button) return;
  button.dataset.mode = permission?.mode || 'ask';
  button.querySelector('span').textContent = ({ ask: '修改需确认', trusted: '信任此项目', read_only: '只读模式' })[permission?.mode] || '项目权限';
}
async function refreshFilePermission() {
  try { const response = await apiFetch('/api/file-permissions'); if (response.ok) paintFilePermission(await response.json()); } catch { /* The server remains authoritative. */ }
}

function setSendState(busy) {
  if (!el.send) return;
  el.send.innerHTML = icon(busy ? 'stop' : 'send', { size: 18 });
  el.send.setAttribute('aria-label', busy ? '停止' : '发送');
  el.send.title = busy ? '停止' : '发送';
}

// Preserve the button before awaiting: Event.currentTarget is cleared after dispatch.
const copyFeedback = new WeakMap();
async function copyWithFeedback(button, text) {
  const previous = copyFeedback.get(button);
  const feedback = { original: previous?.original || button.innerHTML, timer: null };
  clearTimeout(previous?.timer);
  copyFeedback.set(button, feedback);
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch { /* Clipboard access can be denied by the browser. */ }
  if (copyFeedback.get(button) !== feedback) return;
  button.innerHTML = copied ? `${icon('check', { size: 14 })} 已复制` : `${icon('warning', { size: 14 })} 复制失败`;
  feedback.timer = setTimeout(() => {
    if (copyFeedback.get(button) !== feedback) return;
    button.innerHTML = feedback.original;
    copyFeedback.delete(button);
  }, 1600);
}

/* 回答评价：保存在本机的训练标签。👎 可附问题类型与正确回答，后者导出为偏好样本。 */
const FEEDBACK_REASONS = [['wrong_citation', '引用不对'], ['unsupported_claim', '结论无依据'], ['bad_logic', '推理错误'],
  ['wrong_tool', '工具用错'], ['incomplete', '没做完'], ['format', '格式问题'], ['refused_wrongly', '不该拒答'], ['other', '其他']];
function attachFeedback(actions, taskId) {
  const up = document.createElement('button'), down = document.createElement('button');
  up.type = down.type = 'button';
  up.className = down.className = 'act';
  up.innerHTML = `${icon('thumb-up', { size: 14 })} 有帮助`;
  down.innerHTML = `${icon('thumb-down', { size: 14 })} 有问题`;
  up.title = '标记为好回答（只保存在本机，用于改进本地模型）';
  down.title = '指出问题，可写出正确回答（只保存在本机）';
  up.setAttribute('aria-pressed', 'false');
  down.setAttribute('aria-pressed', 'false');
  let panel = null;
  const close = () => { panel?.remove(); panel = null; };
  const send = async (payload) => {
    const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    up.setAttribute('aria-pressed', String(payload.rating === 'up'));
    down.setAttribute('aria-pressed', String(payload.rating === 'down'));
  };
  up.addEventListener('click', async () => {
    try { await send({ rating: 'up' }); close(); }
    catch (err) { up.title = `保存失败：${err.message}`; up.classList.add('act-failed'); }
  });
  down.addEventListener('click', () => {
    if (panel) return close();
    panel = document.createElement('form');
    panel.className = 'feedback-panel';
    panel.innerHTML = `<fieldset><legend>哪里有问题？</legend>${FEEDBACK_REASONS.map(([value, label]) =>
      `<label><input type="checkbox" value="${value}"> ${label}</label>`).join('')}</fieldset>
      <label class="feedback-correction"><span>正确的回答（可选，会作为改进样本）</span><textarea rows="3" maxlength="8000"></textarea></label>
      <div class="feedback-row"><span class="feedback-status" role="status"></span><button type="button" class="act" data-cancel>取消</button><button type="submit" class="act">提交</button></div>`;
    panel.querySelector('[data-cancel]').addEventListener('click', close);
    panel.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = panel.querySelector('.feedback-status');
      status.textContent = '正在保存…';
      try {
        await send({ rating: 'down', reasons: [...panel.querySelectorAll('input:checked')].map((input) => input.value),
          correction: panel.querySelector('textarea').value });
        close();
      } catch (err) { status.textContent = `保存失败：${err.message}`; }
    });
    actions.after(panel);
    panel.querySelector('input')?.focus();
  });
  actions.append(up, down);
}

/* ------------------------------------------------------------------ SSE */

/**
 * R02（N-03）：统一 API 请求入口。
 * 身份只靠 HttpOnly 签名 Cookie（浏览器自动携带），不再发送任何明文身份头。
 * 401（Cookie 缺失/过期/密钥轮换）时自动调用一次 /api/bootstrap 重新领取身份，
 * 然后重试原请求一次；仍失败则把 401 原样交给调用方。
 */
let reauthInFlight = null;
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const u = String(url);
  if (res.status === 401 && u.startsWith('/api/') && !u.includes('/api/bootstrap')) {
    reauthInFlight =
      reauthInFlight ||
      fetch('/api/bootstrap')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .finally(() => {
          reauthInFlight = null;
        });
    const boot = await reauthInFlight;
    if (boot?.user?.id) {
      state.user = boot.user;
      try {
        localStorage.setItem('csl.uid', boot.user.id);
      } catch {}
      return fetch(url, opts);
    }
  }
  return res;
}
if (typeof window !== 'undefined') window.apiFetch = apiFetch;

async function streamPost(url, body, onEvent, signal) {
  const res = await apiFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const failure = new Error(err.message || err.error || `HTTP ${res.status}`);
    failure.httpStatus = res.status;
    failure.code = err.error;
    throw failure;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let terminal = null;
  let taskId = null;

  const consumeEvent = (part) => {
    const payload = part
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload) return;
    let ev;
    try {
      ev = JSON.parse(payload);
    } catch {
      throw new Error('服务端返回了无法解析的流事件');
    }
    if (ev.type === 'conversation' && ev.taskId) taskId = ev.taskId;
    if (['done', 'error', 'approval_required'].includes(ev.type)) terminal = ev.type;
    onEvent(ev);
  };

  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(/\r?\n\r?\n|\r\r/);
      buf = parts.pop() || '';
      for (const part of parts) consumeEvent(part);
    }
    buf += dec.decode();
    if (buf.trim()) consumeEvent(buf);
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
  }
  if (!terminal) {
    const err = new Error('连接提前结束，未收到任务终态；已保留任务状态供刷新恢复');
    err.code = 'stream_incomplete';
    err.taskId = taskId;
    throw err;
  }
  return { terminal, taskId };
}

async function reconcileTask(taskId, messageApi) {
  if (!taskId) return { recovered: false, paused: false };
  try {
    const res = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (!res.ok) return { recovered: false, paused: false };
    const { task } = await res.json();
    if (task.status === 'completed' && task.result) {
      messageApi.onEvent({ type: 'done', taskId, result: task.result, llmCalls: task.result.llmCalls, ms: 0 });
      return { recovered: true, paused: false };
    }
    if (task.status === 'awaiting_approval' && task.checkpoint?.approvalId) {
      const pendingRes = await apiFetch('/api/approvals?status=pending');
      const pending = pendingRes.ok ? (await pendingRes.json()).approvals || [] : [];
      const approval = pending.find((item) => item.id === task.checkpoint.approvalId);
      if (approval) {
        messageApi.onEvent({ type: 'approval_required', taskId, approval });
        return { recovered: true, paused: true };
      }
    }
    if (task.status === 'failed') {
      messageApi.onEvent({ type: 'error', taskId, message: task.error || '任务失败', result: task.result });
      return { recovered: true, paused: false };
    }
    if (task.status === 'cancelled') {
      messageApi.onEvent({ type: 'error', taskId, status: 'cancelled', message: '已停止', result: task.result });
      return { recovered: true, paused: false, cancelled: true };
    }
  } catch {
    // Fall through to the original transport error; refreshing remains safe.
  }
  return { recovered: false, paused: false };
}

/* ------------------------------------------------------------------ 骨架 */

function renderShell() {
  document.getElementById('app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <button class="toolbar-button toolbar-icon sidebar-toggle" id="btn-sidebar" type="button" aria-label="打开会话与偏好" aria-controls="sidebar" aria-expanded="false">${icon('sidebar', { size: 19 })}</button>
          <div class="brand-mark">${brandMark({ size: 32 })}</div>
          <div class="brand-text">
            <h1>知衡<span class="brand-descriptor"> · Agent 工作台</span></h1>
            <p>研究 · 创作 · 执行</p>
          </div>
        </div>
        <div class="task-mode-switch" id="task-mode-switch" data-mode="agent" role="group" aria-label="任务模式">
          <button type="button" data-task-mode="agent" aria-pressed="true" aria-label="Agent" title="使用工具推进项目与交付">
            <span class="mode-emblem">${brandMark({ size: 24 })}</span><span class="mode-copy"><strong>Agent</strong><small>创作与执行</small></span>
          </button>
          <button type="button" data-task-mode="knowledge" aria-pressed="false" aria-label="知识库研究" title="围绕知识库检索与核对证据">
            <span class="mode-emblem">${icon('book', { size: 22 })}</span><span class="mode-copy"><strong>知识库研究</strong><small>阅读与求证</small></span>
          </button>
        </div>
        <div class="studio-breadcrumb" id="studio-project-title">个人工作区</div>
        <div class="toolbar-utilities">
          <button class="toolbar-button model-control" id="pill-model" type="button" title="选择模型与接口" aria-haspopup="dialog"><span class="dot off"></span><span class="model-name">选择模型</span>${icon('settings', { size: 12 })}</button>
          <details class="runtime-status" id="runtime-status">
            <summary class="toolbar-button" title="查看运行状态" aria-label="查看运行状态">${icon('activity', { size: 17 })}<span class="status-label">状态</span></summary>
            <div class="status-popover">
              <div class="status-heading">运行状态</div>
              <div class="status-row"><span class="status-key">文献库</span><span class="pill" id="pill-corpus"><span class="dot"></span><span>载入中</span></span></div>
              <div class="status-row"><span class="status-key">存储</span><span class="pill" id="pill-stack"><span class="dot"></span><span>载入中</span></span></div>
              <div class="status-row"><span class="status-key">检索</span><span class="pill" id="pill-vector"><span class="dot"></span><span>载入中</span></span></div>
              <span class="pill context-status" id="pill-ctx" title="上下文使用情况" hidden><span class="dot"></span><span>上下文</span></span>
              <button class="toolbar-button status-monitor" id="btn-monitor" type="button">${icon('chart', { size: 16 })}<span>打开运行监控</span>${icon('chevron-right', { size: 14 })}</button>
            </div>
          </details>
          <button class="toolbar-button toolbar-icon" id="btn-theme" type="button" title="切换到深色主题" aria-label="切换到深色主题">${icon('moon', { size: 18 })}</button>
        </div>
      </header>

      <div class="layout" id="layout">
        <aside class="sidebar" id="sidebar" aria-label="会话与偏好">
          <div class="sidebar-mobile-head"><span>会话与偏好</span><button class="toolbar-button toolbar-icon" id="btn-sidebar-close" type="button" aria-label="关闭会话与偏好">${icon('close', { size: 18 })}</button></div>
          <div class="sidebar-top">
          <button class="new-chat" id="btn-new" data-sidebar-action type="button"><span class="side-action-icon">${icon('plus', { size: 18 })}</span><span>新会话</span>${icon('chevron-right', { size: 14 })}</button>
          <button class="toolbar-button sidebar-search" id="btn-command" type="button" aria-keyshortcuts="Control+k Meta+k">${icon('search',{size:17})}<span>搜索与命令</span><kbd>Ctrl K</kbd></button>
          <nav class="sidebar-tools" aria-label="工作工具">
            <button class="toolbar-button" id="btn-knowledge" data-sidebar-action type="button" aria-haspopup="dialog">${icon('book', { size: 17 })}<span>知识库工作台</span>${icon('chevron-right', { size: 14 })}</button>
            <button class="toolbar-button" id="btn-activity" data-sidebar-action type="button">${icon('branch', { size: 17 })}<span>任务中心</span>${icon('chevron-right', { size: 14 })}</button>
            <button class="toolbar-button" id="btn-logic" data-sidebar-action type="button" title="选择文献推理方法或运行规则示例" aria-haspopup="dialog">${icon('inference', { size: 17 })}<span>知衡推演</span>${icon('chevron-right', { size: 14 })}</button>
            <button class="toolbar-button" id="btn-workspace" data-sidebar-action type="button" title="查看与管理当前项目文件">${icon('panels', { size: 17 })}<span>项目文件</span><span id="ws-count" class="ws-count" hidden></span>${icon('chevron-right', { size: 14 })}</button>
            <button class="toolbar-button" id="btn-learn" data-sidebar-action type="button" title="长期记忆与技能">${icon('learning', { size: 17 })}<span>学习</span>${icon('chevron-right', { size: 14 })}</button>
          </nav></div>
          <div class="sidebar-scroll">
          <div id="projects-slot"></div>
          <div class="side-block conversations-block" hidden>
            <div class="side-title"><span class="side-heading">${icon('chat', { size: 14 })} 会话</span><span id="conv-count"></span></div>
            <div class="convlist" id="convlist"></div>
          </div>
          <div class="side-block knowledge-block">
            <div class="side-title"><span class="side-heading">${icon('book', { size: 14 })} 知识库</span><span id="kb-count"></span></div>
            <details class="library-catalog"><summary>全部文件<span class="library-toggle"></span></summary>
              <div class="kblist" id="kblist"></div>
            </details>
            <div class="library-actions">
            <button class="kb-import" id="btn-import" type="button">${icon('upload', { size: 17 })}<span>导入文档</span>${icon('plus', { size: 14 })}</button>
            <button class="kb-import" id="btn-section" type="button" disabled>${icon('layers', { size: 16 })}<span>建立分区</span></button>
            </div>
            <input type="file" id="file-input" multiple hidden
                   accept=".pdf,.docx,.xlsx,.pptx,.ipynb,.md,.markdown,.txt,.text,.csv,.tsv,.json,.html,.htm" />
            <div class="kb-progress" id="kb-progress" hidden></div>
          </div>
          </div>
          <div id="preferences-host" hidden><zh-preferences></zh-preferences></div>
          <footer class="sidebar-footer"><button type="button" id="btn-capabilities" data-sidebar-action class="sidebar-settings sidebar-capabilities" aria-haspopup="dialog" aria-keyshortcuts="Control+Shift+k Meta+Shift+k">${icon('compass', { size: 18 })}<span>能力导航</span></button><button type="button" id="btn-settings" data-sidebar-action class="sidebar-settings" aria-haspopup="dialog">${icon('settings', { size: 18 })}<span>设置</span>${icon('chevron-right', { size: 14 })}</button></footer>
        </aside>
        <button class="sidebar-backdrop" id="sidebar-backdrop" type="button" tabindex="-1" aria-label="关闭侧栏" hidden></button>

        <section class="chat" role="main" aria-label="Agent 对话工作区">
          <div class="messages" id="messages"></div>
          <div class="composer-wrap">
            <div class="queue-chips" id="queue-chips"></div>
            <div class="composer">
              <div class="task-context" id="task-context" aria-label="下一条消息的任务范围"><button type="button" data-context-project title="查看当前项目文件">个人工作区</button><button type="button" data-context-scope hidden>${icon('book', { size: 13 })}<span>资料范围 · 全部知识库</span></button></div>
              <div class="model-onboarding" id="model-onboarding" hidden><span>${icon('settings', { size: 16 })}<span>先连接一个模型，即可开始任务。</span></span><button type="button" class="btn" id="configure-first-model">配置模型</button></div>
              <div class="composer-box">
                <label class="composer-label" for="input">交给知衡</label>
                <textarea id="input" rows="1" placeholder="描述你的目标，或让知衡处理项目中的文件…"></textarea>
                <button class="send" id="send" title="发送" aria-label="发送">${icon('send', { size: 18 })}</button>
              </div>
              <div class="composer-hint">
                <button type="button" class="btn tiny" id="file-permission-trigger" aria-haspopup="dialog">${icon('shield', {size:14})}<span>项目权限</span></button>
                <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行</span>
                <button type="button" id="joint-research-trigger" class="btn tiny joint-composer" aria-haspopup="dialog">${icon('inference', { size: 13 })}<span>联合研究</span></button>
                <button type="button" id="clear-research" class="btn tiny" title="移除本次文献策略" hidden></button>
                <button type="button" id="focused-source-chip" class="btn tiny" hidden aria-label="取消已选原文">${icon('document',{size:13})}<span>已选原文</span>${icon('close',{size:12})}</button>
                <details class="composer-tools" id="composer-tools"><summary>${icon('plus', { size: 14 })}<span>更多操作</span><small id="composer-skill-state"></small></summary><div class="composer-tools-body"><span class="composer-skill"><button type="button" id="choose-skill" class="btn tiny">${icon('layers', { size: 13 })}<span>选择技能</span></button><button type="button" id="clear-skill" class="btn tiny" aria-label="移除本次提问的技能" hidden>${icon('close', { size: 12 })}</button></span><button type="button" id="background-submit" class="btn tiny" title="后台执行任务，审批仍需确认">${icon('clock', { size: 13 })}<span>后台运行</span></button><span id="dictation-slot"></span></div></details><span id="hint-right"></span>
              </div>
            </div>
          </div>
        </section>

        <aside class="reader" id="reader">
          <div class="reader-head" id="reader-head"></div>
          <div class="reader-body" id="reader-body"></div>
          <div class="reader-foot" id="reader-foot"></div>
        </aside>
      </div>
    </div>
  `;

  el.messages = document.getElementById('messages');
  el.input = document.getElementById('input');
  el.send = document.getElementById('send');
  el.layout = document.getElementById('layout');
  el.reader = createReader({
    layoutEl: el.layout,
    headEl: document.getElementById('reader-head'),
    bodyEl: document.getElementById('reader-body'),
    footEl: document.getElementById('reader-foot'),
  });
  artifactPreview = createArtifactPreview({ apiFetch });
  const openSource = el.reader.open.bind(el.reader);
  el.reader.open = (...args) => { artifactPreview.close(); return openSource(...args); };
  bindShellNavigation();
}

function bindShellNavigation() {
  const sidebar = document.getElementById('sidebar');
  const trigger = document.getElementById('btn-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const status = document.getElementById('runtime-status');
  const narrow = window.matchMedia('(max-width: 1180px)');
  const previousInert = new Map();
  let opened = false;
  const close = (restoreFocus = true) => {
    const hadFocus = sidebar.contains(document.activeElement);
    opened = false;
    for (const [node, inert] of previousInert) node.inert = inert;
    previousInert.clear();
    document.querySelector('.shell').classList.remove('sidebar-open');
    trigger.setAttribute('aria-expanded', 'false');
    backdrop.hidden = true;
    sidebar.removeAttribute('aria-modal');
    sidebar.setAttribute('role', 'complementary');
    if (restoreFocus && hadFocus && narrow.matches) trigger.focus({ preventScroll: true });
    sidebar.inert = narrow.matches;
    if (narrow.matches) sidebar.setAttribute('aria-hidden', 'true');
    else sidebar.removeAttribute('aria-hidden');
  };
  const open = () => {
    if (!narrow.matches) return;
    opened = true;
    status.open = false;
    sidebar.inert = false;
    sidebar.removeAttribute('aria-hidden');
    sidebar.setAttribute('role', 'dialog');
    sidebar.setAttribute('aria-modal', 'true');
    document.querySelector('.shell').classList.add('sidebar-open');
    trigger.setAttribute('aria-expanded', 'true');
    backdrop.hidden = false;
    for (const node of [document.querySelector('.topbar'), document.querySelector('.chat'), document.getElementById('reader')]) {
      previousInert.set(node, node.inert);
      node.inert = true;
    }
    document.getElementById('btn-sidebar-close').focus({ preventScroll: true });
  };
  el.closeSidebar = close;
  sidebar.addEventListener('click', event => {
    if (event.target.closest('[data-sidebar-action]')) close();
  }, true);
  trigger.addEventListener('click', open);
  document.getElementById('btn-sidebar-close').addEventListener('click', () => close());
  backdrop.addEventListener('click', () => close());
  narrow.addEventListener('change', () => close(false));
  document.addEventListener('click', (event) => {
    if (status.open && !status.contains(event.target) && !event.target.closest('.modal-mask')) status.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (document.querySelector('.modal-mask')) return;
    if (!opened) {
      if (event.key === 'Escape' && status.open) { status.open = false; status.querySelector('summary').focus(); }
      return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = [...sidebar.querySelectorAll('button, select, input, summary, a[href]')].filter((node) => !node.disabled && node.getClientRects().length);
    if (event.shiftKey && (document.activeElement === nodes[0] || !sidebar.contains(document.activeElement))) { event.preventDefault(); nodes.at(-1)?.focus(); }
    else if (!event.shiftKey && (document.activeElement === nodes.at(-1) || !sidebar.contains(document.activeElement))) { event.preventDefault(); nodes[0]?.focus(); }
  });
  close(false);
}

/* ------------------------------------------------------------------ 顶栏 / 侧栏 */

function renderTopbar() {
  const corpus = document.getElementById('pill-corpus');
  const dcount = Array.isArray(state.corpus.disciplines)
    ? state.corpus.disciplines.length
    : state.corpus.disciplines;
  corpus.querySelector('span:last-child').textContent =
    `${Number(state.corpus.papers || 0).toLocaleString()} ${state.corpus.unit || '篇'} · ${dcount} 学科`;
  corpus.title = state.corpus.name || '文献库规模';

  const stack = document.getElementById('pill-stack');
  const store = state.stack.store === 'mysql' ? 'MySQL' : '文件';
  const cache = state.stack.cache === 'redis' ? 'Redis' : '内存';
  stack.querySelector('span:last-child').textContent = `${store} · ${cache}`;
  stack.querySelector('.dot').className = 'dot' + (state.stack.store === 'mysql' ? '' : ' warn');

  const vec = document.getElementById('pill-vector');
  const v = state.stack.vector || {};
  const vLabel = v.engine === 'qdrant' ? 'Qdrant' : v.engine === 'local' ? '本地向量' : '无向量';
  vec.querySelector('span:last-child').textContent = v.ready ? `${vLabel} · ${v.embedding || ''}`.trim() : vLabel;
  vec.querySelector('.dot').className = 'dot' + (v.ready ? '' : ' off');

  updateModelPill();
}

function updateModelPill() {
  const pill = document.getElementById('pill-model');
  const ok = isConfigured(state.provider);
  pill.querySelector('.model-name').textContent = ok ? state.provider.model : '选择模型';
  pill.title = ok ? `${state.provider.model} · 模型设置` : '选择模型与接口';
  pill.querySelector('.dot').className = 'dot' + (ok ? '' : ' off');
  document.getElementById('model-onboarding').hidden = ok;
  const hint = document.getElementById('hint-right');
  if (ok && hint?.textContent === '选择模型后即可开始') hint.textContent = '';
}

function renderSidebar() {
  if (projectSidebar) { projectSidebar.refresh({ conversationId: state.conversationId }); return; }
  const list = document.getElementById('convlist');
  list.innerHTML = '';
  document.getElementById('conv-count').textContent = state.conversations.length
    ? `${state.conversations.length} 个`
    : '';

  if (!state.conversations.length) {
    list.innerHTML = `<div class="empty-hint">还没有会话</div>`;
  }

  for (const c of state.conversations) {
    const row = document.createElement('div');
    row.className = 'convitem' + (c.id === state.conversationId ? ' active' : '');
    row.innerHTML = `
      <button class="conv-open" title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</button>
      <button class="conv-del" title="删除会话" aria-label="删除会话">${icon('close', { size: 14 })}</button>
    `;
    row.querySelector('.conv-open').addEventListener('click', () => { el.closeSidebar?.(); openConversation(c.id); });
    row.querySelector('.conv-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await apiFetch(`/api/conversations/${c.id}`, { method: 'DELETE' });
      state.conversations = state.conversations.filter((x) => x.id !== c.id);
      if (state.conversationId === c.id) newConversation();
      renderSidebar();
    });
    list.appendChild(row);
  }
}

function editSection(section = null) {
  openSectionEditor({
    section, documents: state.kb, apiFetch,
    async onSaved(saved) {
      const index = state.sections.findIndex(s => s.id === saved.id);
      if (index === -1) state.sections.push(saved);
      else state.sections[index] = saved;
      renderKb();
      preferenceStore.change({ discipline: saved.id });
      document.querySelector('zh-question-index')?.invalidate();
      return preferenceStore.whenSettled();
    },
  });
}

function renderKb() {
  document.getElementById('kb-count').textContent = `${state.kb.length + state.corpusFiles.length} 个文件`;
  const create = document.getElementById('btn-section');
  create.disabled = !state.kb.length;
  create.title = state.kb.length ? '将导入文档整理为学科分区' : '请先导入文档';
  function openRef(ref) { el.closeSidebar?.(); el.reader.open(ref, { start: 0, end: 0 }); }
  renderLibrary(document.getElementById('kblist'), {
    documents: state.kb, sections: state.sections, corpusFiles: state.corpusFiles, editSection, openRef,
    async openDoc(d) {
      const res = await apiFetch(`/api/kb/docs/${d.id}`);
      if (res.ok) openRef((await res.json()).chunks?.[0]?.id || d.id);
    },
    async removeDoc(d) {
      if (!confirm(`删除「${d.name}」？该文档的片段与向量会一并移除。`)) return;
      const res = await apiFetch(`/api/kb/docs/${d.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const feedback = document.getElementById('kb-progress');
        feedback.hidden = false;
        feedback.textContent = '未能删除文档，请重试。';
        return;
      }
      await refreshKb();
    },
  });
}

async function refreshKb(updateQuestions = true) {
  const res = await apiFetch('/api/kb/docs');
  if (!res.ok) throw new Error('无法读取知识库文件');
  const data = await res.json();
  state.kb = data.documents || [];
  state.sections = data.sections || [];
  state.corpusFiles = data.corpusFiles || [];
  renderKb();
  preferenceStore?.paint();
  if (updateQuestions) document.querySelector('zh-question-index')?.invalidate();
}

async function importFiles(files) {
  if (!files?.length) return;
  const box = document.getElementById('kb-progress');
  box.hidden = false;

  // 本地先按大小拦截：几百 MB 的扫描件传上去也会被服务端拒绝，没必要等
  const maxBytes = state.upload?.maxBytes || 64 * 1024 * 1024;
  const maxMb = Math.round(maxBytes / 1024 / 1024);
  const oversized = files.filter((f) => f.size > maxBytes);
  const usable = files.filter((f) => f.size <= maxBytes);

  if (oversized.length) {
    box.innerHTML = oversized
      .map(
        (f) =>
          `<div class="kb-bad">${icon('warning', { size: 13 })} ${escapeHtml(f.name)}：${(f.size / 1024 / 1024).toFixed(1)}MB，超过 ${maxMb}MB 上限</div>`
      )
      .join('');
  }
  if (!usable.length) return;

  box.hidden = false;
  box.textContent = `正在解析 ${usable.length} 个文件…`;

  const fd = new FormData();
  for (const f of usable) fd.append('file', f, f.name);

  try {
    const res = await apiFetch('/api/kb/import', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    const ok = data.results.filter((r) => r.ok);
    const bad = data.results.filter((r) => !r.ok);
    box.innerHTML = ok
      .map(
        (r) =>
          `<div class="kb-ok">${icon('check', { size: 13 })} ${escapeHtml(r.doc.name)} · ${r.chars} 字 / ${r.chunks} 段${
            r.vectorIndexed ? ` · 向量 ${r.vectorIndexed}` : ''
          }</div>`
      )
      .join('') +
      bad.map((r) => `<div class="kb-bad">${icon('warning', { size: 13 })} ${escapeHtml(r.name || '')}：${escapeHtml(r.error)}</div>`).join('');
    for (const [index, row] of [...box.querySelectorAll('.kb-ok')].entries()) {
      const review = document.createElement('div');
      row.append(review);
      void mountPublicationReview(review, ok[index].doc.id + '_0', {}, { apiFetch, initialReview: ok[index].publicationReview });
    }
    if (!ok.length) setTimeout(() => (box.hidden = true), 6000);
    await refreshKb();
    await refreshBootstrapStats();
  } catch (err) {
    box.innerHTML = `<div class="kb-bad">导入失败：${escapeHtml(err.message)}</div>`;
  }
}

async function refreshBootstrapStats() {
  const res = await fetch('/api/bootstrap');
  if (!res.ok) return;
  const data = await res.json();
  state.corpus = data.corpus;
  state.stack = data.stack;
  state.upload = data.config?.upload || state.upload;
  renderTopbar();
  preferenceStore.paint();
}

async function savePreference(patch) {
  const res = await apiFetch('/api/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ preferences: patch }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.preferences || !Object.keys(patch).every((key) => Object.hasOwn(data.preferences, key))) {
    throw new Error('偏好保存结果不完整');
  }
  return data.preferences;
}

/* ------------------------------------------------------------------ 消息 */

function nearMessageBottom() {
  const box = el.messages;
  return box.scrollHeight - box.scrollTop - box.clientHeight < 240;
}

function scrollToBottom(force = false) {
  if (force || nearMessageBottom()) el.messages.scrollTop = el.messages.scrollHeight;
}

function addUserMessage(text, { animateEntry = true } = {}) {
  const node = document.createElement('div');
  node.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble-user';
  bubble.textContent = text;
  node.appendChild(bubble);
  el.messages.appendChild(node);
  if (animateEntry) animateIn(node);
  return node;
}

function appendEvidenceCards(container, citations = [], animate = false, reviewContext = {}, renew = false) {
  if (!citations?.length) return;
  const list = document.createElement('details');
  list.className = 'evidence result-disclosure';
  list.innerHTML = disclosureSummary('引用来源', { symbol: 'quote', meta: `原文引用 · ${citations.length} 条`, className: 'evidence-title' });
  const body = document.createElement('div');
  body.className = 'disclosure-body';
  const reviewEntries = [];
  for (const [index, source] of citations.entries()) {
    const card = document.createElement('button');
    card.type = 'button';
    card.dataset.ref = String(source.ref || source.id);
    card.className = 'ev';
    const kind = ['doc', 'external'].includes(source.kind) ? source.kind : 'paper';
    const label = kind === 'doc' ? '文档' : kind === 'external' ? '外部' : source.recordType === 'textbook-section' ? '教材' : '论文';
    const located = source.locatable !== false && /^\d+$/.test(source.start) && /^\d+$/.test(source.end);
    card.innerHTML = `
      <span class="ev-top"><span class="ev-num">${index + 1}</span><span class="ev-kind ${kind}">${label}</span>
        <span class="ev-doc">${escapeHtml(source.title)}</span></span>
      <span class="ev-quote">${escapeHtml((source.snippet || '').slice(0, 130))}</span>
      ${source.authority ? `<span class="ev-authority">${escapeHtml(authorityLabel(source))}</span>` : ''}
      <span class="ev-meta"><span>${escapeHtml(source.heading || source.discipline || '')}</span>
        <span class="ev-loc">${located ? `${source.start}–${source.end}` : '无偏移'}</span>
        <span class="ev-open">阅读来源 ${icon('chevron-right', { size: 13 })}</span></span>`;
    const ref = source.ref || source.id;
    if (reviewableCitation(source)) {
      const status = document.createElement('span');
      status.className = 'ev-authority'; status.textContent = '出版状态待核对';
      card.append(status);
      reviewEntries.push({ ref: String(ref), index, badge: status });
    }
    card.addEventListener('click', () => el.reader.open(ref, { ...source, reviewContext }));
    body.appendChild(card);
  }
  list.appendChild(body);
  container.appendChild(list);
  if (reviewEntries.length) {
    const note = document.createElement('p'); note.className = 'warn-note'; note.hidden = true;
    container.insertBefore(note, list);
    void showCitationReviews(reviewEntries, reviewContext, note, apiFetch, renew);
  }
  if (animate) list.querySelectorAll('.ev').forEach((card, i) => animateIn(card, { kind: 'citation', delay: Math.min(i * 40, 160) }));
}

function addReferenceDownload(actions, endpoint) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.className = 'act';
  summary.textContent = '导出参考文献';
  details.append(summary);
  const status = document.createElement('span');
  status.setAttribute('role', 'status');
  actions.append(details, status);
  for (const [format, extension, label] of [['csl-json', 'json', 'CSL-JSON'], ['bibtex', 'bib', 'BibTeX'], ['ris', 'ris', 'RIS'], ['apa', 'txt', 'APA（按正文编号）']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'act';
    button.textContent = label;
    button.addEventListener('click', () => download(format, extension, button));
    details.append(button);
  }
  details.addEventListener('keydown', event => {
    if (event.key === 'Escape' && details.open) { details.open = false; summary.focus(); }
  });
  async function download(format, extension, button) {
    button.disabled = true;
    status.textContent = '';
    try {
      const response = await apiFetch(endpoint + '?format=' + format);
      if (!response.ok) throw new Error(response.status === 409 ? '请切回此回答所属项目。' : '此回答的引用暂时无法导出。');
      const link = document.createElement('a');
      link.download = 'references.' + extension;
      const url = URL.createObjectURL(await response.blob());
      link.href = url;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      details.open = false;
      summary.focus();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }
}

function createAssistantNode(question = '', { affectsBusy = true } = {}) {
  const node = document.createElement('div');
  node.className = 'msg assistant';
  node.dataset.q = question;
  node.innerHTML = `
    <div class="msg-head">
      <span class="avatar">${brandMark({ size: 22 })}</span>
      <span>知衡</span>
      <span class="lat" style="margin-left:auto"></span>
    </div>
    <div class="run-status" data-status="running" role="status" aria-live="polite" aria-atomic="true">
      <span class="run-status-icon" aria-hidden="true">${icon('loader', { size: 15 })}</span><span class="run-status-text">准备回答…</span>
    </div>
    <div class="trace" hidden>
      <button class="trace-head" type="button" aria-expanded="false">
        <span class="trace-label">${icon('branch', { size: 16 })} 执行过程</span><span class="trace-sum">准备中…</span>
        <span class="trace-toggle"><span class="when-closed">展开</span><span class="when-open">收起</span></span>
        <span class="chev">${icon('chevron-right', { size: 14 })}</span>
      </button>
      <div class="trace-body"></div>
    </div>
    <div class="answer"></div>
    <div class="extra"></div>
  `;

  const trace = node.querySelector('.trace');
  const traceBody = node.querySelector('.trace-body');
  const traceSum = node.querySelector('.trace-sum');
  const runStatus = node.querySelector('.run-status');
  const statusText = node.querySelector('.run-status-text');
  const answer = node.querySelector('.answer');
  const extra = node.querySelector('.extra');
  const lat = node.querySelector('.lat');

  const traceHead = node.querySelector('.trace-head');
  traceHead.addEventListener('click', () => {
    traceHead.setAttribute('aria-expanded', String(trace.classList.toggle('open')));
  });

  const steps = new Map();
  const timeline = createTimeline({ root:traceBody, summary:traceSum, label:stepLabel });
  const order = [];
  const evidence = new Map();
  let buffer = '';
  let pendingText = '';
  let appendPreview = null;
  let raf = 0;
  let audits = null; // inference_audit 事件先到、done 后到时都能回填徽章
  let finalPainted = false; // done 之后禁止流式 paint 覆盖终态 DOM（rAF 竞态防护）
  let liveUpdates = affectsBusy;
  let lifecycle = 'running';
  runStatus.hidden = !liveUpdates;
  const started = performance.now();

  const fillAuditBadges = (list) => {
    if (!list?.length) return;
    node.querySelectorAll('.inf-audit').forEach((slot) => {
      const idx = Number(slot.dataset.audit);
      const inf = list[idx];
      if (!inf) return;
      const a = inf.audit || { verdict: 'skip' };
      const lab = AUDIT_LABEL[a.verdict] || AUDIT_LABEL.skip;
      const anchor = inf.refsValid === false ? ' · 依据ref未锚定' : '';
      slot.innerHTML = `<span class="audit-badge ${lab.cls}" title="${escapeHtml((a.reason || '') + anchor)}">${icon(lab.icon, { size: 12 })} ${lab.text}</span>`;
    });
  };

  const numberFor = (id, refs = order) => {
    const key = String(id);
    if (!evidence.has(key)) return { n: '?', title: '未检索到的文献', bad: true };
    const item = evidence.get(key);
    const ref = String(item.ref || item.id);
    if (!refs.includes(ref)) refs.push(ref);
    return { n: refs.indexOf(ref) + 1, title: item.title, ref };
  };
  const addEvidence = (items) => {
    for (const item of items || []) {
      evidence.set(String(item.id), item);
      if (item.ref != null) evidence.set(String(item.ref), item);
      if (item.alias) evidence.set(item.alias, item);
    }
  };
  answer.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-cite]');
    if (!chip) return;
    event.stopPropagation();
    const item = evidence.get(chip.dataset.cite);
    if (item) el.reader.open(item.ref || item.id, { ...item, reviewContext: { taskId: node.dataset.taskId } });
  });

  const paint = () => {
    raf = 0;
    if (finalPainted) return; // 终态已渲染（含审核徽章），排队中的流式帧不得覆盖
    const follow = nearMessageBottom();
    if (!appendPreview) appendPreview = createAnswerPreview(answer, numberFor);
    appendPreview(pendingText);
    pendingText = '';
    if (follow) scrollToBottom(true);
  };
  const schedulePaint = () => {
    if (!raf) raf = requestAnimationFrame(paint);
  };

  const updateStatus = (text, status = 'running') => {
    lifecycle = status;
    runStatus.hidden = !liveUpdates;
    if (runStatus.dataset.status !== status) {
      runStatus.dataset.status = status;
      const name = { running: 'loader', complete: 'check', error: 'warning', paused: 'pause', stopped: 'stop', ended: 'clock' }[status] || 'info';
      runStatus.querySelector('.run-status-icon').innerHTML = icon(name, { size: 15 });
    }
    const busy = String(status === 'running');
    if (answer.getAttribute('aria-busy') !== busy) answer.setAttribute('aria-busy', busy);
    if (statusText.textContent !== text) statusText.textContent = text;
  };

  const settleSteps = (status) => {
    for (const step of steps.values()) if (step.status === 'running') step.status = status;
  };

  const renderTrace = () => {
    if (!steps.size) return;
    trace.hidden = false;
    for (const step of steps.values()) timeline.upsert(step);
  };

  const api = {
    node,
    replaySteps(list) { if(list.length) { trace.hidden=false; timeline.replay(list); } },
    onEvent(ev) {
      if (ev.taskId) node.dataset.taskId = ev.taskId;
      if (finalPainted && ev.type !== 'inference_audit') return;
      switch (ev.type) {
        case 'preferences_updated':
          preferenceStore.accept(ev.patch);
          break;
        case 'round': timeline.round(ev.round); break;
        case 'step': {
          const key = `${ev.attempt || 1}:${ev.detail?.callId || ev.name}`;
          const step = { name: ev.name, status: ev.status, detail: ev.detail, ms: ev.ms, attempt:ev.attempt };
          steps.set(key, step);
          trace.hidden = false;
          timeline.upsert(step);
          if (ev.status === 'running') {
            updateStatus(`${/^tool[:#]/.test(ev.name) ? '正在调用工具：' : '正在'}${stepLabel(ev.name)}…`);
          }
          if (ev.name === 'compact' && ev.status === 'ok' && ev.detail?.preTokens != null) {
            extra.insertAdjacentHTML(
              'beforeend',
              `<div class="sys-line">${icon('layers', { size: 14 })} 上下文已自动摘要（${(ev.detail.preTokens / 1000).toFixed(0)}K→${(ev.detail.postTokens / 1000).toFixed(0)}K tokens），最近消息保留原文。这是系统注入，不是用户输入。</div>`
            );
          }
          if (ev.name === 'compact' && ev.status === 'tripped') {
            extra.insertAdjacentHTML(
              'beforeend',
              `<div class="sys-line warn">${icon('warning', { size: 14 })} 上下文反复回满，已停止自动压缩。建议开新会话，或把问题拆小、分块提问。</div>`
            );
          }
          break;
        }
        case 'token':
          updateStatus('正在生成回答…');
          buffer += ev.text;
          pendingText += ev.text;
          schedulePaint();
          break;
        case 'evidence':
          addEvidence(ev.citations);
          break;
        case 'reset':
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          buffer = '';
          pendingText = '';
          appendPreview = null;
          order.length = 0;
          answer.replaceChildren();
          break;
        case 'tool':
          // Modern servers emit a persisted step for every tool; do not count it twice.
          updateStatus(`已收到${ev.label || ev.name}结果，继续处理…`);
          break;
        case 'tool_artifact':
          if (['file', 'viz'].includes(ev.artifact?.kind) && ev.artifact.action !== 'read') renderFileCard(extra, ev.artifact, { animate: liveUpdates });
          refreshWorkspaceBadge();
          break;
        case 'subagent': renderSubagent(extra, ev); break;
        case 'background_task': renderBackgroundTask(extra, ev); refreshConversations(); break;
        case 'context': timeline.context(ev); if (affectsBusy) updateCtxPill(ev, steps); break;
        case 'tool_progress': timeline.progress(ev); break;
        case 'plan':
          renderPlanPanel(extra, ev.items || [], { animate: liveUpdates });
          break;
        case 'logic_result':
          appendLogicResult(extra, ev.result);
          break;
        case 'done': {
          timeline.finish(ev.ms);
          for (const card of node.querySelectorAll('.approval-card[data-decision]')) {
            card.classList.add('approval-settled');
            card.querySelector('.ap-head').textContent = card.dataset.decision === 'approved' ? '已批准本次操作' : '已拒绝本次操作';
            card.querySelectorAll('details').forEach(detail => { detail.open = false; });
            const status = card.querySelector('.ap-done'); if (status) status.textContent = '本次任务已结束';card.querySelectorAll('[data-act]').forEach(button=>button.hidden=true);
          }
          const partialSources = ev.result?.jointResearch?.status === 'partial';
          updateStatus(ev.result?.truncated ? '输出已截断' : partialSources ? '回答已完成 · 部分来源不可用' : '回答已完成', ev.result?.truncated ? 'error' : 'complete');
          settleSteps('ended');
          renderTrace();
          // Rendering a terminal event does not finish the HTTP stream. Its
          // owner releases the foreground slot in finally after EOF/cancel.
          if (ev.context) {timeline.context(ev.context);updateCtxPill(ev.context, steps);}
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          buffer = ev.result?.body || '';
          pendingText = '';
          finalPainted = true;
          evidence.clear();
          order.length = 0;
          addEvidence(ev.result.citations);
          answer.innerHTML = renderMarkdown(ev.result.body, { numberFor });
          fillAuditBadges(ev.result.inferences || audits);
          const lc = ev.llmCalls || ev.result?.llmCalls;
          const nArt = (ev.result?.artifacts || []).filter((a) => ['file', 'viz'].includes(a.kind) && a.action !== 'read').length;
          const elapsed = Number(ev.ms) > 0 ? `${(ev.ms / 1000).toFixed(1)}s` : '';
          const judgeCalls = lc?.judge ?? ((ev.result?.supportSummary?.llmCalls || 0) + (ev.result?.inferenceReview?.llmCalls || 0));
          const calls = lc ? `${elapsed ? ' · ' : ''}模型调用 ${(lc.main || 0) + (lc.aux || 0) + (lc.sub || 0) + judgeCalls} 次${lc.aux || lc.sub || judgeCalls ? `（辅助 ${lc.aux || 0} · 子任务 ${lc.sub || 0} · 审核 ${judgeCalls}）` : ''}` : '';
          const products = nArt ? `${elapsed || calls ? ' · ' : ''}产物 ${nArt} 个` : '';
          lat.textContent = [ev.result?.research?.requested ? strategyLabels[ev.result.research.strategy] : '', `${elapsed}${calls}${products}`].filter(Boolean).join(' · ');
          renderResult(ev.result, ev.taskId);
          extra.querySelector('.followup-chips')?.remove();
          if (ev.result.followups?.length) {
            const chips = document.createElement('div'); chips.className = 'followup-chips'; chips.setAttribute('aria-label', '继续研究');
            for (const question of ev.result.followups.slice(0, 3)) {
              const button = document.createElement('button'); button.textContent = question;
              button.addEventListener('click', () => { el.input.value = question; el.input.dispatchEvent(new Event('input')); el.input.focus(); });
              chips.append(button);
            }
            extra.append(chips);
          }
          break;
        }
        case 'inference_audit':
          audits = ev.inferences || null;
          fillAuditBadges(audits);
          break;
        case 'approval_required':
          updateStatus('等待你的确认', 'paused');
          settleSteps('paused');
          renderTrace();
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          answer.innerHTML = renderMarkdown(buffer, { numberFor });
          appendPreview = null;
          pendingText = buffer;
          renderApproval(ev.approval, ev.taskId);
          break;
        case 'error': {
          const terminal = terminalPresentation(ev);
          const citationsOnly = ev.result?.incompleteReason === 'citations_only';
          const partial = citationsOnly || ev.result?.truncated ? ev.result : null;
          updateStatus(terminal.title, terminal.state);
          settleSteps('ended');
          renderTrace();
          if (raf) { cancelAnimationFrame(raf); raf = 0; }
          finalPainted = true;
          if (partial) {
            evidence.clear();
            order.length = 0;
            addEvidence(partial.citations);
          }
          answer.innerHTML = renderMarkdown(partial?.body ?? buffer, { numberFor });
          if (partial) appendEvidenceCards(extra, partial.citations, false, { taskId: ev.taskId || node.dataset.taskId });
          extra.insertAdjacentHTML(
            'beforeend',
            `<div class="warn-note" data-terminal="${terminal.state}">${escapeHtml(terminal.message)}</div>`
          );
          mountRecoveryActions(extra, ev.taskId || node.dataset.taskId, question);
          break;
        }
        default:
          break;
      }
    },
    setBusy(b) {
      if (b) {
        liveUpdates = true;
        finalPainted = false;
        updateStatus('正在恢复任务…');
      }
      if (!b) {
        if (lifecycle === 'running') updateStatus('任务已结束', 'ended');
        renderTrace();
      }
    },
  };

  function renderResult(result, taskId = null) {
    decorateSupport(answer,result.support);
    extra.insertAdjacentHTML('beforeend',renderSupportReview(result));
    const audit = result.quoteAudit;
    const notes = audit?.checks?.filter(check => ['unmatched', 'unchecked', 'normalized'].includes(check.status)) || [];
    if (notes.length || audit?.limited) {
      const note = document.createElement('div');
      note.className = 'warn-note quote-audit';
      const heading = document.createElement('strong');
      heading.textContent = '直接引语核对';
      note.append(heading);
      for (const check of notes) {
        const refs = check.refs.map(ref => numberFor(ref).n).join('、');
        const p = document.createElement('p');
        const verdict = { unmatched: '在本轮取得的所引材料中未找到这段原话',
          normalized: '仅在规范化文本后匹配，引用时请核对原文', unchecked: '可核对的原文不完整，未确认逐字匹配' };
        p.textContent = `“${check.quote}” · 来源 ${refs} · ${verdict[check.status]}。`;
        note.append(p);
      }
      if (audit.limited) note.append('受本次核对上限限制，仅检查了部分文本。');
      extra.prepend(note);
    }
    const method = result.research;
    if (method?.stats && ['ircot', 'tot'].includes(method.strategy)) {
      const { searches, evaluated, stop } = method.stats;
      const notes = { budget: '已用完辅助调用预算', hop_limit: '已完成两轮追检', invalid_plan: '模型未返回有效检索方案', repeated_query: '检索词重复',
        no_evidence: '未找到补充依据', no_new_evidence: '未找到新依据', model_unavailable: '规划调用未完成', search_unavailable: '追加检索未完成' };
      const detail = document.createElement('details');
      detail.className = 'research-receipt';
      const summary = document.createElement('summary');
      summary.textContent = `${strategyLabels[method.strategy]} · 追加检索 ${searches} 次${method.strategy === 'tot' ? ` · 比较 ${evaluated} 个分支` : ''}${notes[stop] ? ' · ' + notes[stop] : ''}`;
      detail.append(summary);
      const description = document.createElement('p');
      description.textContent = method.outline?.length ? '选用的检索词：' + method.outline.join(' → ') : '本次回答沿用首轮检索结果。';
      detail.append(description);
      extra.append(detail);
    }
    if (result.truncated) extra.insertAdjacentHTML('beforeend', '<div class="warn-note">已达到输出上限，以上为部分回答。</div>');
    for (const logic of result.logicResults || []) appendLogicResult(extra, logic);
    // Phase A：计划清单与产物文件卡片（终态/历史回放都走这里；renderFileCard 按路径去重）
    if (result.plan?.length) renderPlanPanel(extra, result.plan, { animate: liveUpdates });
    for (const task of result.backgroundTasks || []) renderBackgroundTask(extra, task);
    for (const a of result.artifacts || []) {
      if (['file', 'viz'].includes(a.kind) && a.action !== 'read') renderFileCard(extra, a, { animate: liveUpdates });
    }
    appendJointReport(extra, result.jointResearch);
    if (result.noEvidence) {
      answer.innerHTML = `
        <div class="noev">
          <div class="noev-head"><span class="mark">${icon('search', { size: 20 })}</span>${result.jointResearch?.enabled ? '未取得充分依据' : '知识库中未查到依据'}</div>
          <p>${escapeHtml(result.body || '检索到的文献都无法支撑这个问题。')}</p>
        </div>`;
      renderTrace();
      return;
    }

    appendEvidenceCards(extra, result.citations, liveUpdates, { taskId: taskId || node.dataset.taskId }, affectsBusy);

    if (result.uncited) {
      extra.insertAdjacentHTML(
        'beforeend',
        '<div class="warn-note">检索到了相关资料，但回答里没有标注引用，无法逐句核验。</div>'
      );
    }

    if (result.unverified?.length) {
      extra.insertAdjacentHTML(
        'beforeend',
        `<div class="warn-note">有 ${result.unverified.length} 个引用不在本轮检索结果中（${escapeHtml(result.unverified.join('、'))}），已标记为可疑。</div>`
      );
    }

    // 推断核查面板：每条推断的成立性审核结论（标注而非删改正文）
    if (result.inferences?.length) {
      const s = result.inferenceStats || {};
      const rows = result.inferences
        .map((inf) => {
          const a = inf.audit || { verdict: 'skip' };
          const lab = AUDIT_LABEL[a.verdict] || AUDIT_LABEL.skip;
          const anchor = inf.refsValid === false ? '<span class="inf-flag">依据 ref 不在本轮证据中</span>' : '';
          return `<div class="inf-row">
            <span class="audit-badge ${lab.cls}">${icon(lab.icon, { size: 12 })} ${lab.text}</span>
            <span class="inf-row-text">${escapeHtml((inf.text || '').slice(0, 120))}</span>
            <span class="inf-row-meta">${escapeHtml(inf.method || '方法未注明')} · 置信度 ${escapeHtml(inf.confidence || '未注明')}${anchor}</span>
            ${a.reason ? `<span class="inf-row-why">${escapeHtml(a.reason)}</span>` : ''}
          </div>`;
        })
        .join('');
      extra.insertAdjacentHTML(
        'beforeend',
        `<details class="inf-panel result-disclosure">
          ${disclosureSummary('模型推断评估', { symbol: 'inference', meta: `${s.total ?? result.inferences.length} 条 · 支持 ${s.pass || 0} · 证据不足 ${s.weak || 0} · 不支持 ${s.fail || 0}${s.unanchored ? ` · 未锚定 ${s.unanchored}` : ''}` })}
          <div class="disclosure-body"><p class="execution-note">模型评估意见，不构成形式证明。</p>${rows}</div>
        </details>`
      );
    }

    // 消息操作条（复制 / 重发 / 引用清单导出）
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML =
      `<button class="act" data-copy title="复制回答原文">${icon('copy', { size: 14 })} 复制</button>` +
      (question ? `<button class="act" data-resend title="回填草稿，发送时使用当前项目、模式与设置">${icon('retry', { size: 14 })} 修改后重新发送</button>` : '') +
      (result.citations?.length ? `<button class="act" data-bib title="复制参考清单（按可用元数据诚实格式化）">${icon('quote', { size: 14 })} 引用清单</button>` : '');
    actions.querySelector('[data-copy]').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, result.body || ''));
    actions.querySelector('[data-resend]')?.addEventListener('click', () => {
      fillDraft(question);
    });
    actions.querySelector('[data-bib]')?.addEventListener('click', (e) => copyWithFeedback(e.currentTarget, formatBibliography(result.citations)));
    if (taskId && result.citations?.length) addReferenceDownload(actions, '/api/tasks/' + encodeURIComponent(taskId) + '/references');
    if (taskId) attachFeedback(actions, taskId);
    extra.appendChild(actions);

    scrollToBottom();
  }

  function renderApproval(approval, taskId) {
    const card = document.createElement('div');
    card.className = 'approval-card';
    const isLogic = approval.action === 'propose_logic_program';
    const isBatch = approval.action === 'tool_batch';
    const isCmd = approval.action === 'run_command';
    const isQuestion = approval.action === 'ask_user';
    const cmd = isCmd && approval.payload && Array.isArray(approval.payload.command)
      ? approval.payload.command.map((s) => (/\s/.test(s) ? JSON.stringify(s) : s)).join(' ')
      : '';
    const batchItems=isBatch ? approval.payload.calls : [];
    const batchMarkup=`<div class="approval-batch">${batchItems.map(item=>`<section class="approval-batch-item"><label><input type="checkbox" data-approve-call="${escapeHtml(item.id)}"><span>${escapeHtml(item.action)}</span></label>${item.fileReview ? renderFileReview(item.fileReview) : `<pre>${escapeHtml(JSON.stringify(item.payload,null,2))}</pre>`}<p>${escapeHtml(item.reason || '')}</p></section>`).join('')}</div>`;
    const logicMarkup=`<p>${escapeHtml(approval.payload.explanation || '请确认模型是否准确表达了你的条件、事实与待验证问题。')}</p><label class="logic-proposal-label">待执行的知衡程序<textarea class="logic-proposal-program" aria-label="确认或修改知衡程序" rows="8" maxlength="20000" spellcheck="false">${escapeHtml(approval.payload.program || '')}</textarea></label><p class="ap-reason">批准后才运行。结果只相对于已确认的前提成立；“未知”不等于“否定”。${approval.payload.mode==='grounded'?'原文绑定不随编辑自动改变；无法匹配将拒绝执行。':''}</p>`;
    const payloadBlock = isLogic ? logicMarkup : isBatch ? batchMarkup : isQuestion
      ? `<h3 class="question-heading">${escapeHtml(approval.payload.question)}</h3>
         <div class="question-options">${(approval.payload.options || []).map((option, index) => `<button type="button" class="question-option" data-option="${index}">${escapeHtml(option)}${approval.payload.recommended === index ? '<span>推荐</span>' : ''}</button>`).join('')}</div>
         <textarea class="question-answer" maxlength="2000" rows="3" placeholder="选择上方选项，或补充你的想法" aria-label="你的回答"></textarea>`
      : isCmd
      ? `<pre class="ap-payload ap-cmd">$ ${escapeHtml(cmd)}</pre>
         <div class="ap-reason">理由：${escapeHtml((approval.payload && approval.payload.justification) || '未说明')}</div>
         <div class="ap-reason">工作目录：用户工作区${approval.payload && approval.payload.cwd ? ' / ' + escapeHtml(String(approval.payload.cwd)) : ''} · 非操作系统级沙箱 · 审计已开启</div>`
      : approval.fileReview ? renderFileReview(approval.fileReview)
      : `<pre class="ap-payload">${escapeHtml(JSON.stringify(approval.payload, null, 2))}</pre>
         <div class="ap-reason">${escapeHtml(approval.reason || '')}</div>`;
    const decided = ['approved', 'rejected'].includes(approval.status);
    card.innerHTML = `
      <div class="ap-head"><span class="ap-mark">!</span>${isQuestion ? '补充一个信息' : '需要你的确认'}</div>
      <div class="ap-body">
        ${isQuestion ? '' : `<div class="ap-action">${escapeHtml(approval.action)}</div>`}
        ${payloadBlock}
      </div>
      <div class="ap-actions">
        ${decided
          ? `<button class="btn primary" data-act="${approval.status}" data-decided="1">继续执行</button>`
          : isCmd
            ? `<button class="btn primary" data-act="approved" data-scope="once">仅此次</button>
               <button class="btn" data-act="approved" data-scope="task">本任务允许该前缀</button>
               <button class="btn" data-act="approved" data-scope="persistent">永久允许该前缀</button>`
            : `<button class="btn primary" data-act="approved">${isQuestion ? '回答并继续' : isBatch ? '确认所选并继续' : '批准'}</button>`
        }
        ${decided ? '' : `<button class="btn" data-act="rejected">${isQuestion ? '跳过' : '拒绝'}</button>`}
      </div>
    `;
    timeline.approval(card, approval);
    trace.hidden=false; trace.classList.add('open'); traceHead.setAttribute('aria-expanded','true');
    scrollToBottom(true);

    card.querySelectorAll('[data-option]').forEach(btn => btn.addEventListener('click', () => {
      card.querySelector('.question-answer').value = approval.payload.options[Number(btn.dataset.option)];
      card.querySelectorAll('[data-option]').forEach(item => item.setAttribute('aria-pressed', String(item === btn)));
    }));
    card.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (state.busy) {
          extra.insertAdjacentHTML('beforeend', '<div class="warn-note">请先停止或等待当前任务完成，再恢复此审批。</div>');
          return;
        }
        const decision = btn.dataset.act;
        card.dataset.decision = decision;
        const answer = card.querySelector('.question-answer')?.value.trim();
        if (isQuestion && decision === 'approved' && !answer && btn.dataset.decided !== '1') { card.querySelector('.question-answer').focus(); return; }
        const decisions=isBatch ? Object.fromEntries([...card.querySelectorAll('[data-approve-call]')].map(input=>[input.dataset.approveCall,input.checked?'approved':'rejected'])) : null;
        const program=isLogic ? card.querySelector('.logic-proposal-program').value : null;
        const scope = btn.dataset.scope || null;
        const alreadyDecided = btn.dataset.decided === '1';
        card.querySelectorAll('button').forEach((b) => (b.disabled = true));
        card.querySelectorAll('input,textarea').forEach(input=>input.disabled=true);
        const progress=card.querySelector('.ap-done') || document.createElement('span');progress.className='ap-done';progress.textContent='正在提交并恢复…';card.querySelector('.ap-actions').append(progress);

        state.busy = true;
        api.setBusy(true);
        setSendState(true);
        const controller = new AbortController();
        state.abort = controller;
        let paused = false;
        let cancelled = false;
        try {
          if (!alreadyDecided) {
            const decidedRes = await apiFetch(`/api/approvals/${approval.id}/decide`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ decision, scope, ...(isQuestion ? { answer } : {}), ...(decisions ? {decisions} : {}), ...(program !== null ? {program} : {}) }),
              signal: controller.signal,
            });
            if (!decidedRes.ok) {
              const payload = await decidedRes.json().catch(() => ({}));
              throw new Error(payload.message || payload.error || `HTTP ${decidedRes.status}`);
            }
          }
          btn.dataset.decided='1';btn.textContent='继续执行';card.querySelectorAll('[data-act]').forEach(other=>{if(other!==btn)other.hidden=true;});
          controller.signal.throwIfAborted();
          await streamPost(
            `/api/tasks/${taskId}/resume`,
            { provider: state.provider, approvalId: approval.id },
            (ev) => {
              if (ev.type === 'approval_required') paused = true;
              if (ev.type === 'done' || ev.type === 'error') paused = false;
              if (ev.type === 'error' && terminalPresentation(ev).state === 'stopped') cancelled = true;
              api.onEvent(ev);
            },
            controller.signal
          );
        } catch (err) {
          cancelled = controller.signal.aborted || err.name === 'AbortError';
          const recovered = err.code === 'stream_incomplete'
            ? await reconcileTask(err.taskId || taskId, api)
            : { recovered: false };
          paused = Boolean(recovered.paused);
          cancelled ||= controller.signal.aborted || Boolean(recovered.cancelled);
          if (!recovered.recovered) {
            api.onEvent({ type: 'error', message: cancelled ? '已停止' : `恢复失败：${err.message}` });
            progress.textContent='未能继续，可重试或重新打开会话。';btn.disabled=false;
            if(btn.dataset.decided!=='1'){card.querySelectorAll('button,input,textarea').forEach(control=>control.disabled=false);}
          }
        } finally {
          if (state.abort === controller) { state.busy = false; state.abort = null; setSendState(false); }
          api.setBusy(false);
          if (cancelled) state.queue = [];
          renderQueueChips();
          if (!paused && !cancelled) drainQueueForCurrent();
          refreshConversations();
        }
      });
    });
  }

  el.messages.appendChild(node);
  if (liveUpdates) animateIn(node);
  return api;
}

function renderHistoryMessage(msg, conversationId) {
  if (msg.role === 'user') {
    addUserMessage(msg.content, { animateEntry: false });
    return;
  }
  if (msg.result) {
    const replay = createAssistantNode('', { affectsBusy: false });
    replay.onEvent({
      type: msg.result.incompleteReason === 'citations_only' ? 'error' : 'done',
      taskId: msg.taskId || null,
      result: { ...msg.result, body: msg.result.body || msg.content, citations: msg.result.citations || msg.citations || [] },
      ms: 0,
      llmCalls: msg.result.llmCalls,
    });
    replay.setBusy(false);
    if(msg.taskId) apiFetch(`/api/tasks/${encodeURIComponent(msg.taskId)}/steps`).then(async response=>{
      if(!response.ok) throw new Error('步骤记录暂不可用');
      const data=await response.json(); if(replay.node.isConnected) replay.replaySteps(data.steps || []);
    }).catch(()=>{ if(replay.node.isConnected) { const note=document.createElement('p');note.className='sys-line';note.textContent='步骤记录加载失败，重新打开会话可重试。';replay.node.append(note); } });
    return;
  }
  const node = document.createElement('div');
  node.className = 'msg assistant';
  const citations = citedSources(msg.content, msg.citations);
  const byId = new Map(citations.map((c) => [String(c.ref ?? c.id), c]));
  const order = [];

  const numberFor = (id) => {
    const key = String(id);
    if (!byId.has(key)) return { n: '?', title: '未检索到的文献', bad: true };
    if (!order.includes(key)) order.push(key);
    return { n: order.indexOf(key) + 1, title: byId.get(key).title };
  };

  const isNoEvidence = msg.content.startsWith('（未查到依据）');
  node.innerHTML = `
    <div class="msg-head"><span class="avatar">${brandMark({ size: 22 })}</span><span>知衡</span><span class="lat" style="margin-left:auto"></span></div>
    <div class="answer"></div>
    <div class="extra"></div>
  `;
  const answer = node.querySelector('.answer');
  const extra = node.querySelector('.extra');

  if (isNoEvidence) {
    answer.innerHTML = `<div class="noev"><div class="noev-head"><span class="mark">${icon('search', { size: 20 })}</span>知识库中未查到依据</div><p>${escapeHtml(
      msg.content.replace('（未查到依据）', '')
    )}</p></div>`;
  } else {
    answer.innerHTML = renderMarkdown(msg.content, { numberFor });
  }

  appendEvidenceCards(extra, citations, false, { conversationId, messageId: msg.id });

  if (!isNoEvidence) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML =
      `<button class="act" data-copy>${icon('copy', { size: 14 })} 复制</button>` +
      (citations.length ? `<button class="act" data-bib>${icon('quote', { size: 14 })} 引用清单</button>` : '');
    actions.querySelector('[data-copy]').addEventListener('click', (e) => copyWithFeedback(e.currentTarget, msg.content || ''));
    actions.querySelector('[data-bib]')?.addEventListener('click', (e) => copyWithFeedback(e.currentTarget, formatBibliography(citations)));
    if (citations.length && msg.id) addReferenceDownload(actions, '/api/conversations/' + encodeURIComponent(conversationId) + '/messages/' + encodeURIComponent(msg.id) + '/references');
    if (msg.taskId) attachFeedback(actions, msg.taskId);
    extra.appendChild(actions);
  }

  el.messages.appendChild(node);
}

/* 顶栏上下文压力 pill（数据来自 done 事件的 context:{tokens,budget}） */
function updateCtxPill(ctx, steps) {
  const pill = document.getElementById('pill-ctx');
  if (!pill || !ctx?.budget) return;
  const pct = Math.round((ctx.tokens / ctx.budget) * 100);
  const compacts = steps ? [...steps.values()].filter((s) => s.name === 'compact' && s.status === 'ok').length : 0;
  pill.hidden = false;
  const dot = pill.querySelector('.dot');
  const label = pill.querySelector('span:last-child');
  if (pct >= 84) {
    label.textContent = `上下文紧张 ${pct}%`;
    dot.className = 'dot warn';
    pill.title = '将自动摘要并继续（保留最近消息原文）';
  } else {
    label.textContent = compacts ? `上下文 ${pct}% · 压缩${compacts}次` : `上下文 ${pct}%`;
    dot.className = 'dot';
    pill.title = `距自动压缩还有 ${Math.max(0, 84 - pct)}%`;
  }
}

/* ------------------------------------------------------------------ 会话 */

function renderEmptyState() {
  const corpus = state.corpus || {};
  const researching = state.taskMode === 'knowledge';
  const count = Number.isFinite(corpus.papers) ? `${corpus.papers.toLocaleString('zh-CN')} ${escapeHtml(corpus.unit || '篇文献')}` : '';
  el.messages.innerHTML = `
    <div class="empty" data-mode="${state.taskMode}">
      <div class="empty-hero">
        <div class="empty-copy">
          <p class="eyebrow" lang="en">ZHIHENG / ${researching ? 'KNOWLEDGE RESEARCH' : 'AGENT WORKSPACE'}</p>
          <h2>${researching ? '从书页之间，<br><span>找到有据的答案。</span>' : '将想法，<br><span>推进成结果。</span>'}</h2>
          <p class="lede">${researching ? '让问题与资料相遇。<br>追溯原文、比较证据，积累可信的认识。' : '从一份资料、一个问题或一个项目开始。<br>研究、编写、验证，直到交付。'}</p>
        </div>
        <div class="studio-sculpture"><span class="sculpture-halo" aria-hidden="true"></span><img class="empty-art" src="${researching ? '/assets/illustrations/research-library.webp' : '/assets/brand/studio-sculpture.png'}" width="${researching ? 1536 : 1280}" height="${researching ? 1024 : 1280}" alt="${researching ? '图书与知识的研究书房' : '知衡三角环绕的协作符号'}" decoding="async" /></div>
      </div>
      <div class="studio-starters" aria-label="任务起点">
        <button type="button" data-starter="research"><span class="starter-icon">${icon('search',{size:22})}</span><strong>研究一个问题</strong><small>检索、比较与核对来源</small>${icon('chevron-right',{size:15})}</button>
        <button type="button" data-starter="create"><span class="starter-icon">${icon('spark',{size:22})}</span><strong>创作一份交付物</strong><small>文档、表格、演示与图解</small>${icon('chevron-right',{size:15})}</button>
        <button type="button" data-starter="project"><span class="starter-icon">${icon('folder',{size:22})}</span><strong>推进一个项目</strong><small>读取文件、制定计划与执行</small>${icon('chevron-right',{size:15})}</button>
      </div>
      ${state.taskMode === 'knowledge' ? '<zh-question-index></zh-question-index>' : ''}
      <div class="hint-line">
        ${icon('database', { size: 16 })}
        <span>${escapeHtml(corpus.name || '知识库')}${count ? ` · ${count}` : ''}</span>
        <button class="empty-import" id="empty-import">导入文档 ${icon('chevron-right', { size: 13 })}</button>
      </div>
    </div>`;
  document.getElementById('empty-import').addEventListener('click', () => document.getElementById('file-input').click());
  for (const button of el.messages.querySelectorAll('[data-starter]')) button.addEventListener('click', () => {
    setTaskMode(button.dataset.starter === 'research' ? 'knowledge' : 'agent');
    const starters = { research: '请帮我研究这个问题，查找可靠来源并比较证据：', create: '请根据项目资料制作一份可交付的文档，先确认目标与结构：', project: '请查看当前项目，梳理文件结构并制定可执行的计划：' };
    if (!el.input.value.trim()) el.input.value = starters[button.dataset.starter];
    el.input.dispatchEvent(new Event('input')); el.input.focus();
  });
  document.querySelector('zh-question-index')?.connect(async (turn, signal) => {
    await preferenceStore.whenSettled();
    signal.throwIfAborted();
    const response = await apiFetch(`/api/kb/questions?turn=${turn}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    signal.throwIfAborted();
    if (data.discipline !== indexDiscipline) preferenceStore.accept({ discipline: data.discipline });
    return data.questions;
  }, (question, source) => {
    el.input.value = question;
    state.focusedSource = source?.ref ? { ref: source.ref, question, scope: preferenceStore.current().discipline || '' } : null;
    paintFocusedSource();
    send();
  });
}

function newConversation() {
  // Starting another conversation keeps the explicitly selected task mode.
  state.focusedSource = null;
  paintFocusedSource();
  setResearchStrategy(null);
  setSelectedSkill(null);
  el.reader.close();
  artifactPreview?.close();
  state.historyAbort?.abort();
  state.historyAbort = null;
  state.viewVersion += 1;
  state.conversationId = null;
  renderSidebar();
  renderEmptyState();
}

async function openConversation(id, { signal } = {}) {
  signal?.throwIfAborted();
  setTaskMode('agent');
  const known = state.conversations.find(c => c.id === id);
  if (known && (known.workspaceId || 'default') !== state.workspaceId) {
    try { await projectSidebar?.select(known.workspaceId || 'default'); }
    catch (error) { document.getElementById('hint-right').textContent = error.message; }
  }
  state.focusedSource = null;
  setResearchStrategy(null);
  setSelectedSkill(null);
  el.reader.close();
  artifactPreview?.close();
  state.historyAbort?.abort();
  const controller = new AbortController();
  const abortHistory = () => controller.abort();
  signal?.addEventListener('abort', abortHistory, { once: true });
  if (signal?.aborted) controller.abort();
  state.historyAbort = controller;
  const version = ++state.viewVersion;
  state.conversationId = id;
  renderSidebar();
  try {
    const res = await apiFetch(`/api/conversations/${id}/messages`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (controller.signal.aborted || version !== state.viewVersion || state.conversationId !== id) return;
    el.messages.innerHTML = '';
    if (!data.messages?.length && !data.activeTasks?.length) {
      renderEmptyState();
      return { conversationId: id, viewVersion: version };
    }
    for (const m of data.messages || []) {
      renderHistoryMessage(m, id);
      const node = el.messages.lastElementChild;
      if (!node || !m.id) continue;
      const rewind = document.createElement('button'); rewind.className = 'btn tiny rewind-message'; rewind.textContent = '回到这里';
      rewind.addEventListener('click', async () => {
        if (state.busy || state.conversationId !== id) return;
        if (!window.confirm('删除此消息之后的对话？此操作不可恢复，任务记录和工作区文件仍然保留。')) return;
        rewind.disabled = true;
        try {
          const response = await apiFetch(`/api/conversations/${id}/rewind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: m.id }) });
          if (!response.ok) throw new Error(response.status === 409 ? '会话仍有运行或等待确认的任务，请先处理。' : '无法回到此消息。');
          await openConversation(id); await refreshConversations();
        } catch (error) { rewind.textContent = error.message; rewind.disabled = false; }
      });
      node.append(rewind);
    }
    for (const entry of data.activeTasks || []) {
      if (!entry.approval) continue;
      const replay = createAssistantNode(entry.task?.question || '', { affectsBusy: false });
      replay.onEvent({ type: 'approval_required', approval: entry.approval, taskId: entry.task.id });
      replay.setBusy(false);
    }
    scrollToBottom(true);
    drainQueueForCurrent();
    return { conversationId: id, viewVersion: version };
  } catch (err) {
    if (err.name === 'AbortError' || version !== state.viewVersion) return;
    el.messages.innerHTML = `<div class="warn-note">会话加载失败：${escapeHtml(err.message)}</div>`;
  } finally {
    signal?.removeEventListener('abort', abortHistory);
    if (state.historyAbort === controller) state.historyAbort = null;
  }
}

async function refreshConversations() {
  const res = await apiFetch('/api/conversations');
  const data = await res.json();
  state.conversations = data.conversations || [];
  renderSidebar();
}

/* ------------------------------------------------------------------ 发送 */

function setSelectedSkill(name) {
  state.selectedSkill = name;
  const choose = document.getElementById('choose-skill');
  choose.innerHTML = icon('layers', { size: 13 }) + '<span>' + escapeHtml(name || '选择技能') + '</span>';
  choose.classList.toggle('selected', Boolean(name));
  choose.title = name ? `下一条消息使用「${name}」，点击更换` : '为下一条消息选择技能';
  document.getElementById('clear-skill').hidden = !name;
  document.getElementById('composer-skill-state').textContent = name ? '· 已选技能' : '';
}

const strategyLabels = { react: 'ReAct', ircot: 'IRCoT', tot: 'ToT' };
function setResearchStrategy(strategy) {
  state.researchStrategy = strategy;
  const button = document.getElementById('clear-research');
  button.hidden = !strategy;
  button.textContent = strategy ? `${strategyLabels[strategy]} ×` : '';
  button.setAttribute('aria-label', `移除本次文献策略 ${strategyLabels[strategy] || ''}`);
}

function renderQueueChips() {
  const box = document.getElementById('queue-chips');
  if (!box) return;
  box.innerHTML = state.queue
    .map((q, i) => `<button type="button" class="q-chip" data-i="${i}" title="${q.scopeChanged ? '范围已改变，点击回填草稿并核对' : '移出追问队列'}" aria-label="${q.scopeChanged ? '范围已改变，回填草稿' : '移出追问队列'}：${escapeHtml((q.text || String(q)).slice(0, 40))}">${icon(q.scopeChanged ? 'warning' : 'clock', { size: 12 })} ${q.scopeChanged ? '待核对范围 · ' : ''}${escapeHtml((q.text || String(q)).slice(0, 40))} ${icon('close', { size: 12 })}</button>`)
    .join('');
  box.querySelectorAll('.q-chip').forEach((chip) =>
    chip.addEventListener('click', () => {
      const index = Number(chip.dataset.i);
      const item = state.queue[index];
      if (!item) return;
      if (item.scopeChanged) {
        const hint = document.getElementById('hint-right');
        if (el.input.value.trim()) { hint.textContent = '输入框已有草稿。请先发送或清空，再恢复这条排队消息。'; el.input.focus(); return; }
        if (item.conversationId !== state.conversationId || (item.workspaceId || 'default') !== state.workspaceId) {
          hint.textContent = '请先切换回这条排队消息原来的项目与会话。'; return;
        }
        if (item.focusRef && !item.focusDocId && item.focusScope !== (preferenceStore.current().discipline || '')) {
          hint.textContent = '这条消息绑定了原文，请先恢复原来的资料范围，再回填草稿。'; return;
        }
        setTaskMode(item.mode); setSelectedSkill(item.skill); setResearchStrategy(item.strategy);
        fillDraft(item.text);
        state.focusedSource = item.focusRef ? { ref: item.focusRef, docId: item.focusDocId, scope: item.focusScope,
          question: item.text, sticky: Boolean(item.focusDocId) } : null;
        paintFocusedSource();
        hint.textContent = '已恢复原文、技能与策略，请核对资料范围后发送。';
      }
      state.queue.splice(index, 1);
      renderQueueChips();
    })
  );
}

function drainQueueForCurrent(delay = 400) {
  if (state.busy || !state.queue.length || state.queueTimer) return;
  state.queueTimer = setTimeout(() => {
    state.queueTimer = null;
    if (state.busy) return;
    const nextIndex = state.queue.findIndex((item) => !item.scopeChanged && item.conversationId === state.conversationId && (item.workspaceId || 'default') === state.workspaceId);
    if (nextIndex < 0) return;
    const [next] = state.queue.splice(nextIndex, 1);
    renderQueueChips();
    send(next);
  }, delay);
}

async function send(queuedItem = null) {
  const fromQueue = Boolean(queuedItem && typeof queuedItem === 'object' && typeof queuedItem.text === 'string');
  const text = String(fromQueue ? queuedItem.text : el.input.value).trim();
  const skill = fromQueue ? queuedItem.skill : state.selectedSkill;
  const strategy = fromQueue ? queuedItem.strategy : state.researchStrategy;
  const mode = fromQueue ? queuedItem.mode || 'agent' : state.taskMode;
  const focused = !fromQueue && (state.focusedSource?.sticky || state.focusedSource?.question === text) ? state.focusedSource : null;
  const focusRef = fromQueue ? queuedItem.focusRef : focused?.ref;
  const focusDocId = fromQueue ? queuedItem.focusDocId : focused?.docId;
  const focusScope = fromQueue ? queuedItem.focusScope : focused?.scope;
  const targetWorkspace = fromQueue ? queuedItem.workspaceId || 'default' : state.workspaceId;
  if (!text) return;
  const draftHint = document.getElementById('hint-right');
  if (draftHint.dataset.draft) { draftHint.textContent = ''; delete draftHint.dataset.draft; }
  if (!fromQueue && text === '/context') { configure?.(false,'context'); el.input.value = ''; el.input.dispatchEvent(new Event('input')); return; }
  if (fromQueue && (queuedItem.conversationId !== state.conversationId || targetWorkspace !== state.workspaceId)) {
    state.queue.unshift(queuedItem);
    renderQueueChips();
    return;
  }
  if (fromQueue && queuedItem.scopeSignature && queuedItem.scopeSignature !== taskScopeSignature(mode, preferenceStore.current())) {
    state.queue.unshift({ ...queuedItem, scopeChanged: true }); renderQueueChips();
    document.getElementById('hint-right').textContent = '排队期间资料范围已改变，该消息已暂停，请点击队列核对后发送。';
    return;
  }
  if (state.busy) {
    // 追问队列：当前任务忙时入队，完成后按序自动发送（可点 chip 移出）
    if (state.queue.length < 5) {
      state.queue.push(fromQueue ? queuedItem : { text, skill, strategy, mode, focusRef, focusDocId, focusScope, scopeSignature: taskScopeSignature(mode, preferenceStore.current()), conversationId: state.conversationId, workspaceId: targetWorkspace, viewVersion: state.viewVersion });
      if (!fromQueue) {
        setResearchStrategy(null);
        setSelectedSkill(null);
        state.focusedSource = null;
        paintFocusedSource();
        el.input.value = '';
        el.input.style.height = 'auto';
      }
      renderQueueChips();
    }
    return;
  }

  if (!isConfigured(state.provider)) {
    openSettings({
      provider: state.provider,
      onSave: (p) => {
        state.provider = p;
        updateModelPill();
      },
    });
    return;
  }

  const empty = el.messages.querySelector('.empty');
  if (empty) empty.remove();

  if (!fromQueue) {
    setResearchStrategy(null);
    setSelectedSkill(null);
    state.focusedSource = null;
    paintFocusedSource();
    el.input.value = '';
    el.input.style.height = 'auto';
  }
  state.busy = true;
  setSendState(true);
  el.send.title = '停止（会清空追问队列）';

  const targetConversation = fromQueue ? queuedItem.conversationId : state.conversationId;
  const originViewVersion = state.viewVersion;
  state.historyAbort?.abort();
  state.historyAbort = null;
  const sendViewVersion = ++state.viewVersion;
  const userNode = addUserMessage(text);
  const msg = createAssistantNode(text);
  scrollToBottom(true);

  const controller = new AbortController();
  state.abort = controller;
  let paused = false; // 审批暂停不算终态：不出队追问（等用户决策）
  let aborted = false;

  try {
    // The server reads preferences when a task starts. A click followed by
    // Enter must use the setting the user just selected.
    const saved = await preferenceStore.whenSettled();
    controller.signal.throwIfAborted();
    if (!saved) {
      if (state.viewVersion === sendViewVersion && !el.input.value) {
        if (!state.selectedSkill) setSelectedSkill(skill);
        if (!state.researchStrategy) setResearchStrategy(strategy);
        el.input.value = text;
        el.input.dispatchEvent(new Event('input'));
        if (focusRef && (focusDocId || focusScope === (preferenceStore.current().discipline || ''))) state.focusedSource = { ref: focusRef, scope: focusScope, question: text,docId:focusDocId,sticky:Boolean(focusDocId) };
        paintFocusedSource();
      }
      throw new Error('偏好未能保存，本次提问未发送。请重新选择后再试。');
    }
    // Saving can finish after a later scope selection. Re-check at the request
    // boundary, not only when the queued message first leaves the queue.
    if (fromQueue && queuedItem.scopeSignature && queuedItem.scopeSignature !== taskScopeSignature(mode, preferenceStore.current())) {
      state.queue.unshift({ ...queuedItem, scopeChanged: true });
      userNode.remove(); msg.node.remove();
      document.getElementById('hint-right').textContent = '保存偏好期间资料范围已改变，该消息已暂停，请点击队列核对后发送。';
      return;
    }
    await streamPost(
      '/api/chat',
      { message: text, mode, ...(skill ? { skill } : {}), ...(strategy && mode === 'knowledge' ? { researchStrategy: strategy } : {}),
        ...(mode === 'knowledge' && focusRef && (focusDocId || focusScope === (preferenceStore.current().discipline || '')) ? { focusRef, ...(focusDocId ? {focusDocId} : {}) } : {}),
        conversationId: targetConversation, workspaceId: targetWorkspace, provider: state.provider },
      (ev) => {
        if (ev.type === 'conversation') {
          if (state.viewVersion === sendViewVersion) state.conversationId = ev.conversationId;
          for (const item of state.queue) {
            if (item.conversationId == null &&
                (item.viewVersion === sendViewVersion || (targetConversation == null && item.viewVersion === originViewVersion))) {
              item.conversationId = ev.conversationId;
              item.viewVersion = sendViewVersion;
            }
          }
          state.lastTaskId = ev.taskId;
        }
        if (ev.type === 'approval_required') paused = true;
        if (ev.type === 'done' || ev.type === 'error') paused = false;
        if (ev.type === 'error' && terminalPresentation(ev).state === 'stopped') aborted = true;
        msg.onEvent(ev);
      },
      controller.signal
    );
  } catch (err) {
    aborted = err.name === 'AbortError';
    if (err.httpStatus && state.viewVersion === sendViewVersion && !el.input.value) {
      el.input.value = text;
      el.input.dispatchEvent(new Event('input'));
      if (focusRef && (focusDocId || focusScope === (preferenceStore.current().discipline || ''))) state.focusedSource = { ref: focusRef, scope: focusScope, question: text,docId:focusDocId,sticky:Boolean(focusDocId) };
      paintFocusedSource();
      if (!state.selectedSkill && !['skill_not_found', 'skills_disabled'].includes(err.code)) setSelectedSkill(skill);
      if (!state.researchStrategy && err.code !== 'invalid_research_strategy') setResearchStrategy(strategy);
    }
    const recovered = !aborted && err.code === 'stream_incomplete'
      ? await reconcileTask(err.taskId, msg)
      : { recovered: false, paused: false };
    if (recovered.paused) paused = true;
    if (recovered.cancelled || state.abort?.signal.aborted) aborted = true;
    if (!recovered.recovered) msg.onEvent({ type: 'error', message: aborted ? '已停止' : err.message });
  } finally {
    if (state.abort === controller) { state.busy = false; state.abort = null; setSendState(false); }
    msg.setBusy(false);
    refreshConversations();
    refreshLearnBadge?.();
    if (aborted && state.queue.length) {
      // 用户主动停止 = 停止整个队列（要发新问题是显式动作，不隐式续跑）
      state.queue = [];
    }
    renderQueueChips();
    if (!paused && !aborted && state.queue.length) {
      drainQueueForCurrent(); // 稍作停顿再发同一会话的追问
    }
  }
}

/* ------------------------------------------------------------------ 监控 */

async function openMonitor() {
  let m;
  try { const res=await apiFetch('/api/metrics',{signal:AbortSignal.timeout(15000)});if(!res.ok)throw new Error(`HTTP ${res.status}`);m=await res.json(); }
  catch(error) { const panel=document.createElement('dialog');panel.className='modal-mask';panel.innerHTML=`<section class="modal"><div class="modal-head"><h2>运行监控</h2><button data-close aria-label="关闭运行监控">${icon('close')}</button></div><div class="modal-body panel-load-error"><strong>运行状态加载失败</strong><p>${escapeHtml(error.message)}</p><button class="btn" data-retry-load>重试</button></div></section>`;const close=showDialog(panel);panel.querySelector('[data-retry-load]').onclick=()=>{close();openMonitor();};return; }

  const mask = document.createElement('dialog');
  mask.className = 'modal-mask';
  const lat = (x) => (x && x.count ? `p50 ${x.p50}ms · p95 ${x.p95}ms` : '—');
  const c = m.counters || {};

  mask.innerHTML = `
    <div class="modal wide">
      <div class="modal-head"><h2 class="icon-label">${icon('activity', { size: 20 })} 运行监控</h2><button data-close aria-label="关闭运行监控">${icon('close', { size: 16 })}</button></div>
      <div class="modal-body">
        <div class="metrics">
          <div class="metric"><span class="mv">${c.tasks_total || 0}</span><span class="mk">任务总数</span></div>
          <div class="metric"><span class="mv ok">${c.tasks_completed || 0}</span><span class="mk">已完成</span></div>
          <div class="metric"><span class="mv bad">${c.tasks_failed || 0}</span><span class="mk">失败</span></div>
          <div class="metric"><span class="mv">${c.llm_calls || 0}</span><span class="mk">模型调用</span></div>
          <div class="metric"><span class="mv">${c.llm_retries || 0}</span><span class="mk">重试</span></div>
          <div class="metric"><span class="mv">${c.rag_queries || 0}</span><span class="mk">检索次数</span></div>
        </div>
        <div class="lat-grid">
          <div><b>检索延迟</b><span>${lat(m.latency?.rag)}</span></div>
          <div><b>模型延迟</b><span>${lat(m.latency?.llm)}</span></div>
          <div><b>任务耗时</b><span>${lat(m.latency?.task)}</span></div>
        </div>
        <div class="stack-line">
          存储 <b>${m.stack.store}</b> · 缓存 <b>${m.stack.cache}</b> · 熔断 <b>${m.stack.llm.open ? '已打开' : '正常'}</b>
          · 文献 <b>${m.corpus.papers}</b> 篇 · 上传文档 <b>${m.corpus.docs || 0}</b> 篇
        </div>
        <div class="stack-line" style="margin-top:6px">
          向量 <b>${m.stack.vector?.engine || 'off'}</b>（${m.stack.vector?.embedding || '未启用'}）
          · 知识库 <b>${m.stack.kb?.engine || '-'}</b>
          · 外部源 <b>${m.stack.external?.mode || 'off'}</b>
        </div>
        <h3 class="sec">待审批 ${m.approvals.length}</h3>
        <div class="mon-list">${
          m.approvals.length
            ? m.approvals
                .map(
                  (a) => `<div class="mon-row"><span class="tagx">${escapeHtml(a.action)}</span>
              <span class="mon-text">${escapeHtml(JSON.stringify(a.payload))}</span>
              <button class="btn tiny" data-approve="${a.id}" data-task="${a.taskId}">批准</button>
              <button class="btn tiny" data-reject="${a.id}" data-task="${a.taskId}">拒绝</button></div>`
                )
                .join('')
            : '<div class="mon-empty">无</div>'
        }</div>
        <h3 class="sec">失败任务 ${m.failed.length}</h3>
        <div class="mon-list">${
          m.failed.length
            ? m.failed
                .map(
                  (t) => `<div class="mon-row"><span class="tagx bad">失败</span>
              <span class="mon-text">${escapeHtml(t.question.slice(0, 40))} · ${escapeHtml((t.error || '').slice(0, 40))}</span>
              <button class="btn tiny" data-retry="${t.id}">重试</button></div>`
                )
                .join('')
            : '<div class="mon-empty">无</div>'
        }</div>
        <h3 class="sec">最近任务</h3>
        <div class="mon-list">${
          m.tasks
            .slice(0, 8)
            .map(
              (t) => `<div class="mon-row"><span class="tagx ${t.status === 'completed' ? '' : 'warnx'}">${t.status}</span>
            <span class="mon-text">${escapeHtml(t.question.slice(0, 46))}</span>
            <span class="mon-time">${new Date(t.createdAt).toLocaleTimeString('zh-CN')}</span></div>`
            )
            .join('') || '<div class="mon-empty">无</div>'
        }</div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>关闭</button></div>
    </div>`;

  const close = showDialog(mask);

  mask.querySelectorAll('[data-approve],[data-reject],[data-retry]').forEach(button => {
    if(button.dataset.approve) button.textContent='查看并处理';
    if(button.dataset.reject) { button.remove(); return; }
    button.addEventListener('click',async()=>{
      if(state.busy){button.textContent='请先等待当前任务';return;}
      button.disabled=true;
      try {
        const response=await apiFetch(`/api/tasks/${encodeURIComponent(button.dataset.task || button.dataset.retry)}`);
        if(!response.ok)throw new Error('任务暂不可用');const {task}=await response.json();
        close();await openConversation(task.conversationId);
        if(button.dataset.retry){
          await resumeFailedTask(task.id);
        }
      }catch(error){button.textContent=error.message;button.disabled=false;}
    });
  });

}

/* ------------------------------------------------------------------ 学习与记忆面板 */

async function refreshLearnBadge() {
  try {
    const res = await apiFetch('/api/learn/status');
    if (!res.ok) return;
    const st = await res.json();
    const btn = document.getElementById('btn-learn');
    if (!btn) return;
    const n = st.skills?.count || 0;
    const p = st.pending?.count || 0;
    btn.innerHTML = `${icon('learning', { size: 17 })}<span>学习</span>${p > 0 ? `<span class="toolbar-count">${Number(p)}</span>` : ''}`;
    btn.title = `技能 ${n} 个 · 待审候选 ${p} 条 · 审查 ${st.state?.reviews_run || 0} 次`;
    btn.classList.toggle('has-pending', p > 0);
  } catch {
    /* 学习面板不可用不影响主功能 */
  }
}

/* ---------------- Phase A：产物文件卡片 / 计划面板 / 工作区抽屉 ---------------- */

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** 文件卡片（按 path 去重：patch 覆盖 write 的旧卡片信息） */
function renderBackgroundTask(host, task) {
  if (!task?.taskId) return;
  let card = [...host.querySelectorAll('.background-task-card')].find(node => node.dataset.taskId === task.taskId);
  if (card) return;
  card = document.createElement('div'); card.className = 'background-task-card'; card.dataset.taskId = task.taskId;
  card.innerHTML = `${icon('branch',{size:20})}<div><strong>${escapeHtml(task.title || '后台任务')}</strong><small>已建立独立任务 · 在任务中心查看实时进度</small></div><button class="btn tiny" type="button">查看任务</button>${task.conversationId ? '<button class="btn tiny" type="button" data-conversation>打开会话</button>' : ''}`;
  card.querySelector('button').addEventListener('click', () => agentActivity?.open());
  card.querySelector('[data-conversation]')?.addEventListener('click', () => openConversation(task.conversationId));
  host.append(card);
}

function renderFileCard(host, a, { animate = true } = {}) {
  if (!host || !a?.path) return;
  if (a.kind === 'viz') return renderVisualization(host, a, { fetch: apiFetch, url: workspaceFileUrl(a.path, a.workspaceId, 'download') });
  const dl = workspaceFileUrl(a.path, a.workspaceId, 'download');
  const fileIcon = a.action === 'patch' ? 'edit' : 'document';
  const identity = JSON.stringify([a.workspaceId || 'default', a.path]);
  let card = [...host.querySelectorAll('.file-card')].find((c) => c.dataset.fp === identity);
  const fresh = !card;
  if (!card) {
    card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.fp = identity;
    host.appendChild(card);
  }
  card.innerHTML = `
    <span class="fc-icon">${icon(fileIcon, { size: 22 })}</span>
    <span class="fc-name" title="${escapeHtml(a.path)}">${escapeHtml(a.path)}</span>
    <span class="fc-size">${fmtBytes(a.bytes)}${a.scan?.findings?.some(f => f.severity === 'warning') ? ' · 内容待检查' : ''}</span>
    <a class="btn tiny fc-dl" href="${dl}" download>${icon('download', { size: 14 })} 下载</a>
    <a class="btn tiny fc-window" href="${artifactPreviewUrl(a.path, a.workspaceId)}" target="_blank" rel="noopener noreferrer" title="在新窗口渲染预览" aria-label="在新窗口打开${escapeHtml(a.path)}">${icon('external',{size:14})}</a>
    <button class="btn tiny fc-view">${icon('eye', { size: 14 })} 预览</button>`;
  card.querySelector('.fc-view').addEventListener('click', () => previewWorkspaceFile(a.path, a.workspaceId));
  if (animate && fresh) animateIn(card, { kind: 'citation' });
}

/** 计划清单面板（同一消息内唯一，增量更新） */
function renderPlanPanel(host, items, { animate = true } = {}) {
  if (!host) return;
  let panel = host.querySelector('.plan-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'plan-panel';
    panel.innerHTML = `<div class="plan-head">${icon('document', { size: 16 })} 任务计划 <span class="plan-count"></span></div><ul class="plan-list"></ul>`;
    host.prepend(panel);
  }
  const done = items.filter((i) => i.status === 'completed').length;
  panel.querySelector('.plan-count').textContent = `${done}/${items.length}`;
  const list = panel.querySelector('.plan-list');
  const previous = new Map([...list.children].map((row) => [row.dataset.planKey, row]));
  const occurrences = new Map();
  const states = { completed: ['check', '已完成'], in_progress: ['loader', '进行中'], pending: ['clock', '待执行'] };
  items.forEach((item, index) => {
    const identity = String(item.id || item.content);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    const key = JSON.stringify([identity, occurrence]);
    let row = previous.get(key);
    const fresh = !row;
    if (fresh) {
      row = document.createElement('li');
      row.dataset.planKey = key;
      row.innerHTML = '<span class="plan-ico" aria-hidden="true"></span><span class="plan-text"></span><span class="sr-only plan-state"></span>';
    }
    const oldStatus = row.dataset.status;
    const status = Object.hasOwn(states, item.status) ? item.status : 'pending';
    row.className = `pl-${status}`;
    row.dataset.status = status;
    if (fresh || oldStatus !== status) row.querySelector('.plan-ico').innerHTML = icon(states[status][0], { size: 14 });
    row.querySelector('.plan-text').textContent = item.content;
    row.querySelector('.plan-state').textContent = states[status][1];
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    previous.delete(key);
    if (animate) {
      if (fresh) animateIn(row, { kind: 'step', delay: Math.min(index * 30, 120) });
      else if (oldStatus !== status) animateState(row);
    }
  });
  for (const row of previous.values()) row.remove();
}

function workspaceFileUrl(path, workspaceId = 'default', mode = 'preview') {
  return '/api/workspace/asset?' + new URLSearchParams({ path, workspace: workspaceId, [mode]: '1' });
}

async function previewWorkspaceFile(path, workspaceId) {
  el.reader.close();
  artifactPreview.open({ path, workspaceId });
}

async function refreshWorkspaceBadge() {
  const el2 = document.getElementById('ws-count');
  if (!el2) return;
  try {
    const { files } = await apiFetch('/api/workspace/files').then((r) => r.json());
    el2.textContent = files?.length ? String(files.length) : '';
    el2.hidden = !files?.length;
  } catch { /* 静默 */ }
}

async function openWorkspace() {
  const m = document.createElement('dialog');
  m.className = 'modal-mask';
  m.innerHTML = `<div class="modal modal-wide"><div class="modal-head"><h2 class="icon-label">${icon('folder', { size: 20 })} 工作区</h2>
      <button data-x aria-label="关闭工作区">${icon('close', { size: 16 })}</button></div>
    <div class="modal-body"><section class="ws-binding" aria-label="当前文件夹">
      <div class="ws-location"><small>当前文件夹</small><strong data-ws-name>加载中…</strong><span data-ws-path></span></div>
      <div class="ws-actions"><button class="btn" data-ws-choose disabled>${icon('folder', { size: 16 })} 选择电脑文件夹</button>
      <button class="btn tiny" data-ws-reset hidden>恢复默认</button></div>
    </section><p class="ws-notice" role="status"></p><div class="ws-list"></div></div></div>`;
  showDialog(m);
  const list = m.querySelector('.ws-list');
  const choose = m.querySelector('[data-ws-choose]');
  const reset = m.querySelector('[data-ws-reset]');
  const notice = m.querySelector('.ws-notice');
  const controller = new AbortController();
  m.addEventListener('close', () => controller.abort(), { once: true });

  async function select(action) {
    choose.disabled = reset.disabled = true;
    notice.textContent = action === 'choose' ? '请在系统窗口中选择文件夹。' : '';
    let message;
    try {
      const response = await apiFetch('/api/workspace/select', { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-workspace-picker': '1' }, body: JSON.stringify({ action }) });
      const result = await response.json();
      if (response.ok) {
        message = result.cancelled ? '已取消选择。' : '项目已添加到侧栏。';
        if (!result.cancelled) { state.workspaceId = result.workspace.id; state.queue = []; renderQueueChips(); newConversation(); await projectSidebar.refresh(); await refreshFilePermission(); }
      }
      else message = ({ workspace_busy: '有任务或文件夹选择窗口正在运行，请稍后再试。',
        protected_folder: '请选择独立的项目文件夹。磁盘根目录和应用数据目录无法作为工作区。',
        picker_unavailable: '无法打开系统窗口，请确认知衡服务运行在当前 Windows 桌面会话中。' })[result.error] || '未能切换工作区。';
    } catch { message = '文件夹选择已中断。'; }
    if (!m.open) return;
    await refresh();
    notice.textContent = message;
    refreshWorkspaceBadge();
  }
  choose.addEventListener('click', () => select('choose'));
  reset.addEventListener('click', () => select('reset'));

  async function refresh() {
    let data;
    try {
      const response = await apiFetch('/api/workspace/files');
      if (!response.ok) throw new Error();
      data = await response.json();
    } catch { notice.innerHTML='读取工作区失败。 <button type="button" class="btn tiny" data-workspace-retry>重试</button>';notice.querySelector('button').onclick=refresh;return; }
    const { files, workspace, canChoose } = data;
    m.querySelector('[data-ws-name]').textContent = workspace.name;
    m.querySelector('[data-ws-path]').textContent = workspace.root || '任务生成的文件保存在此处';
    choose.disabled = !canChoose;
    reset.hidden = workspace.id === 'default' || !canChoose;
    reset.disabled = false;
    notice.textContent = !workspace.available ? '目录已移动或不可用，请重新选择。' :
      !canChoose ? '使用本机 Windows 浏览器打开 localhost 后可选择电脑文件夹。' : '';
    if (!files?.length) {
      list.innerHTML = '<div class="mon-empty">当前没有可列出的文件。</div>';
      return;
    }
    list.innerHTML = files
      .map(
        (f) => `<div class="ws-row">
          <span class="ws-icon">${icon('document', { size: 20 })}</span>
          <span class="ws-name" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
          <span class="ws-size">${fmtBytes(f.bytes)}</span>
          <span class="ws-time">${(f.mtime || '').slice(0, 16).replace('T', ' ')}</span>
          <a class="btn tiny" href="${workspaceFileUrl(f.path, workspace.id, 'download')}" download>下载</a>
          <button class="btn tiny" data-prev="${escapeHtml(f.path)}">预览</button>
          <button class="btn tiny danger" data-del="${escapeHtml(f.path)}">删除</button>
        </div>`
      )
      .join('');
    list.querySelectorAll('[data-prev]').forEach((b) => b.addEventListener('click', () => {
      m.addEventListener('close', () => previewWorkspaceFile(b.dataset.prev, workspace.id), { once: true }); m.close();
    }));
    list.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`删除「${b.dataset.del}」？（移入工作区回收站，不会物理删除）`)) return;
        const response = await apiFetch('/api/workspace/file', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: b.dataset.del, workspaceId: workspace.id }) });
        if (!response.ok) return alert(response.status === 409 ? '工作区已切换，请重新打开。' : '未能将文件移入回收站。');
        refresh();
        refreshWorkspaceBadge();
      })
    );
  }
  await refresh();
  window.__wsRefresh = refresh;
}

async function openLearn(tab = 'memory') {
  if(activateWorkbenchPanel('learning')) return;
  const mask = document.createElement('dialog');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal wide learn-modal">
      <div class="modal-head"><h2 class="icon-label">${icon('learning', { size: 20 })} 学习与记忆</h2><button data-close aria-label="关闭学习与记忆">${icon('close', { size: 16 })}</button></div>
      <div class="tabs" role="tablist" aria-label="学习分类">
        <button role="tab" aria-selected="false" data-tab="memory">记忆</button>
        <button role="tab" aria-selected="false" data-tab="skills">技能</button>
        <button role="tab" aria-selected="false" data-tab="effectiveness">技能效用</button>
        <button role="tab" aria-selected="false" data-tab="pending">待审候选</button>
        <button role="tab" aria-selected="false" data-tab="ledger">台账与状态</button>
      </div>
      <div class="modal-body" id="learn-body"><div class="mon-empty">加载中…</div></div>
      <div class="modal-foot"><button class="btn" data-close>关闭</button></div>
    </div>`;
  showWorkbenchPanel(mask,'learning');
  const body = mask.querySelector('#learn-body');

  const H = { 'content-type': 'application/json' };
  let activeTab=tab, generation=0;
  const isCurrent = version => version === generation && body.isConnected;
  const panelError=(error,retry)=>{if(error.name==='AbortError'||!body.isConnected)return;body.innerHTML=`<div class="panel-load-error"><strong>加载未完成</strong><p>${escapeHtml(error.message || '请求失败')}</p><button class="btn" data-learn-retry>重试</button></div>`;body.querySelector('[data-learn-retry]').onclick=retry;};
  const read=async(url,options={})=>{
    const version=generation;
    try {
      const r=await apiFetch(url,{...options,signal:AbortSignal.timeout(15000)});
      const data=await r.json();
      if(!isCurrent(version))throw new DOMException('页面已切换','AbortError');
      if(!r.ok)throw new Error(data.message || data.error || `HTTP ${r.status}`);
      return data;
    } catch(error) {
      if(!isCurrent(version))throw new DOMException('页面已切换','AbortError');
      throw error;
    }
  };
  const post=async(url,data)=>{try{return await read(url,{method:'POST',headers:H,body:JSON.stringify(data)});}catch(error){panelError(error,()=>select(activeTab));return {ok:false,stale:error.name==='AbortError',message:error.message};}};

  let memoryTarget = 'memory';
  async function renderMemory() {
    const m = await read('/api/memory');
    const store = (key, label) => {
      const s = m[key];
      const pct = Math.min(100, Math.round((s.chars / s.limit) * 100));
      const rows = s.entries.length
        ? s.entries.map((e, i) => `<div class="mem-row"><span class="mem-text">${escapeHtml(e)}</span>
            <button class="btn tiny" data-del="${key}" data-i="${i}" title="删除这条记忆" aria-label="删除这条记忆">${icon('trash', { size: 14 })}</button></div>`).join('')
        : '<div class="mon-empty">（空）</div>';
      return `<h3 class="sec">${label} <span class="mem-budget">${s.chars}/${s.limit} 字符</span></h3>
        <div class="budget-bar"><i style="width:${pct}%"></i></div>${rows}`;
    };
    body.innerHTML =
      '<section class="conversation-profile" aria-label="跨会话画像">载入画像…</section>' +
      store('user', '手动与已确认的用户记忆') +
      store('memory', '环境事实（知识库使用经验）') +
      `<h3 class="sec">新增记忆</h3>
       <div class="mem-add">
         <fieldset class="choice-set memory-target" id="mem-target"><legend>保存位置</legend><div class="choice-options">
           <label class="choice-item"><input type="radio" name="mem-target-${mask.querySelector('h2').id}" value="memory" ${memoryTarget === 'memory' ? 'checked' : ''}><span class="choice-face">环境事实</span></label>
           <label class="choice-item"><input type="radio" name="mem-target-${mask.querySelector('h2').id}" value="user" ${memoryTarget === 'user' ? 'checked' : ''}><span class="choice-face">用户画像</span></label>
         </div></fieldset>
         <textarea id="mem-text" rows="2" placeholder="一句话事实（陈述句，≤800 字符）。写入会过安全扫描与预算门槛。"></textarea>
         <button class="btn primary" id="mem-add-btn">写入</button>
         <span class="mem-msg" id="mem-msg"></span>
       </div>`;
    renderConversationProfile(body.querySelector('.conversation-profile'), apiFetch);
    body.querySelector('#mem-target').addEventListener('change', event => {
      if (event.target.checked) memoryTarget = event.target.value;
    });
    body.querySelectorAll('[data-del]').forEach((b) =>
      b.addEventListener('click', async () => {
        const key = b.dataset.del;
        const entry = m[key].entries[Number(b.dataset.i)];
        if (!confirm(`删除这条记忆？\n「${entry.slice(0, 60)}」`)) return;
        const r = await post('/api/memory', { target: key, operations: [{ action: 'remove', old_text: entry }] });
        if (r.stale) return;
        if (!r.ok) return alert(r.message || '删除失败');
        select('memory');
      })
    );
    body.querySelector('#mem-add-btn').addEventListener('click', async () => {
      const text = body.querySelector('#mem-text').value.trim();
      const target = body.querySelector('#mem-target input:checked').value;
      const msg = body.querySelector('#mem-msg');
      if (!text) return;
      const r = await post('/api/memory', { target, operations: [{ action: 'add', content: text }] });
      if (r.stale) return;
      msg.innerHTML = r.ok ? `${icon('check', { size: 14 })} 已写入` : `${icon('warning', { size: 14 })} ${escapeHtml(r.message || r.code || '写入失败')}`;
      if (r.ok) select('memory');
    });
  }

  async function renderSkills() {
    const version = generation;
    const [{ skills }, st0] = await Promise.all([
      read('/api/skills'),
      read('/api/learn/status').catch(() => ({})),
    ]);
    if (!isCurrent(version)) return;
    // R03（N-01）：pin/归档是管理员策展操作，非管理员不渲染按钮
    const canCurate = Boolean(st0.admin);
    if (!skills.length) {
      body.innerHTML = st0.enabled === false
        ? '<div class="mon-empty">此服务已关闭学习与技能。启用 LEARNING_ENABLED 后可选择任务技能。</div>'
        : '<div class="mon-empty">还没有可用技能。完成任务后可在此查看积累的经验。</div>';
      return;
    }
    body.innerHTML = skills
      .map(
        (s) => `<div class="skill-row">
          <div class="skill-main">
            <button class="skill-name" data-view="${escapeHtml(s.name)}">${escapeHtml(s.name)}
              <span class="tagx">${s.scope === 'global' ? '全局种子' : '自有'}</span>
              ${s.state !== 'active' ? `<span class="tagx ${s.state === 'stale' ? 'warnx' : ''}">${s.state}</span>` : ''}
              ${s.pinned ? `<span class="tagx icon-label">${icon('pin', { size: 12 })} 已置顶</span>` : ''}</button>
            <div class="skill-desc">${escapeHtml(s.description)}</div>
            <div class="skill-meta">注入 ${s.use_count} 次 · 修订 ${s.patch_count} 次 · 来源 ${escapeHtml(s.created_by)}</div>
          </div>
          <div class="skill-acts"><button type="button" class="btn tiny" data-use-skill="${escapeHtml(s.name)}" ${st0.enabled === false ? 'disabled title="服务已关闭技能调用"' : ''}>用于下一条消息</button>${
            canCurate || s.scope === 'own'
              ? `<button class="btn tiny" data-pin="${escapeHtml(s.name)}" data-on="${s.pinned ? '' : '1'}">${s.pinned ? '取消pin' : 'pin'}</button>
            <button class="btn tiny" data-arch="${escapeHtml(s.name)}">归档</button>`
              : ''
          }</div>
        </div>`
      )
      .join('');
    body.querySelectorAll('[data-use-skill]').forEach(button =>
      button.addEventListener('click', () => {
        setSelectedSkill(button.dataset.useSkill);
        mask.close();
        el.input.focus();
      })
    );
    body.querySelectorAll('[data-view]').forEach((b) =>
      b.addEventListener('click', async () => {
        const s = await read(`/api/skills/${b.dataset.view}`).catch(error=>{panelError(error,()=>select(activeTab));return null;});
        if(!s)return;
        const m2 = document.createElement('dialog');
        m2.className = 'modal-mask';
        m2.innerHTML = `<div class="modal"><div class="modal-head"><h2>${escapeHtml(s.name)}</h2><button data-x aria-label="关闭技能详情">${icon('close', { size: 16 })}</button></div>
          <div class="modal-body"><pre class="skill-full">${escapeHtml(s.body)}</pre></div>
          <div class="modal-foot skill-export"><span role="status" aria-live="polite"></span>
          <button type="button" class="btn" data-skill-export>${icon('download', { size: 16 })}导出 Agent Skills ZIP</button></div></div>`;
        const lifetime = new AbortController();
        const exportButton = m2.querySelector('[data-skill-export]');
        const status = m2.querySelector('[role=status]');
        exportButton.addEventListener('click', async () => {
          exportButton.disabled = true;
          status.textContent = '正在准备技能文件…';
          try {
            const url = `/api/skills/${encodeURIComponent(s.name)}/export?scope=${encodeURIComponent(s.scope)}`;
            const response = await apiFetch(url, { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]) });
            if (!response.ok) {
              const error = await response.json().catch(() => ({}));
              const detail = error.issues?.[0]?.message;
              throw new Error([error.message || `技能导出失败（HTTP ${response.status}）`, detail].filter(Boolean).join(' '));
            }
            const blob = await response.blob();
            if (!m2.open) return;
            const link = document.createElement('a');
            link.download = s.name + '.zip';
            link.href = URL.createObjectURL(blob);
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
            status.textContent = '已开始下载技能文件。';
          } catch (error) {
            if (m2.open) status.textContent = error.message;
          } finally {
            exportButton.disabled = false;
          }
        });
        showDialog(m2, { onClose: () => lifetime.abort() });
      })
    );
    body.querySelectorAll('[data-pin]').forEach((b) =>
      b.addEventListener('click', async () => {
        const result = await post(`/api/skills/${b.dataset.pin}`, { action: b.dataset.on ? 'pin' : 'unpin' });
        if (result.ok) select('skills');
      })
    );
    body.querySelectorAll('[data-arch]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`归档技能「${b.dataset.arch}」？归档只移动到 .archive/，不会删除。`)) return;
        const result = await post(`/api/skills/${b.dataset.arch}`, { action: 'archive' });
        if (result.ok) select('skills');
      })
    );
  }

  async function renderPending() {
    const st = await read('/api/learn/status');
    const list = st.pending?.head || [];
    body.innerHTML = list.length
      ? list.map((p) => `<div class="pend-row">
          <span class="tagx ${p.kind.startsWith('skill') ? '' : 'warnx'}">${escapeHtml(p.kind)}</span>
          <span class="pend-text">${escapeHtml((p.statement || '').slice(0, 140))}</span>
          <span class="pend-why">${p.reason === 'needs_user_confirm' ? '等待你的确认——确认后才会写入并注入后续任务' : `拒绝原因：${escapeHtml(p.reason || '')}`}</span>
          <button class="btn tiny ${p.reason === 'needs_user_confirm' ? 'primary' : ''}" data-restore="${escapeHtml(p.fp)}" data-confirm="${p.reason === 'needs_user_confirm' ? '1' : ''}">${p.reason === 'needs_user_confirm' ? '确认写入' : '恢复提交'}</button>
        </div>`).join('')
      : '<div class="mon-empty">没有待确认的记忆建议或被门槛拦下的候选。</div>';
    body.querySelectorAll('[data-restore]').forEach((b) =>
      b.addEventListener('click', async () => {
        // R06：needs_user_confirm 走确认路由；被门槛拦下的候选走恢复路由（同一套归属校验）
        const route = b.dataset.confirm ? '/api/learn/pending/confirm' : '/api/learn/pending/restore';
        const r = await post(route, { fp: b.dataset.restore });
        if (r.stale) return;
        if (!r.ok) return alert(r.message || '操作失败（格式门槛对用户通道同样生效）');
        select('pending');
      })
    );
  }

  async function renderLedger() {
    const st = await read('/api/learn/status');
    const s = st.state || {};
    body.innerHTML = `
      <div class="metrics">
        <div class="metric"><span class="mv">${s.reviews_run || 0}</span><span class="mk">审查次数</span></div>
        <div class="metric"><span class="mv">${s.tasks_since_review || 0}</span><span class="mk">距下次例行审查</span></div>
        <div class="metric"><span class="mv">${s.curator_runs || 0}</span><span class="mk">curator 运行</span></div>
        <div class="metric"><span class="mv">${st.skills?.count || 0}</span><span class="mk">技能总数</span></div>
      </div>
      <div class="stack-line">最近审查：${s.last_review_at ? new Date(s.last_review_at).toLocaleString('zh-CN') : '—'} · curator：${s.last_curator_at ? new Date(s.last_curator_at).toLocaleString('zh-CN') : '—'}</div>
      <h3 class="sec">台账（最近 ${st.ledger?.length || 0} 条，均可回滚）</h3>
      <div class="mon-list">${(st.ledger || []).map((e) => `<div class="mon-row">
          <span class="tagx">${escapeHtml(e.action)}</span>
          <span class="mon-text">${escapeHtml(e.kind)}:${escapeHtml(e.name || '')} · ${escapeHtml(e.actor)}${e.reason ? ` · ${escapeHtml(String(e.reason).slice(0, 40))}` : ''}</span>
          <span class="mon-time">${new Date(e.ts).toLocaleString('zh-CN')}</span>
          ${e.before_sha && e.before_sha !== e.after_sha ? `<button class="btn tiny" data-rollback="${escapeHtml(e.id)}">回滚</button>` : ''}
        </div>`).join('') || '<div class="mon-empty">无</div>'}</div>
      <h3 class="sec">手动审查</h3>
      <div class="mem-add">
        <label class="chk"><input type="checkbox" id="rev-dry" /> dry-run（只看会审什么，不写入）</label>
        <button class="btn primary" id="rev-run">对最近任务跑一次审查</button>
        <span class="mem-msg" id="rev-msg"></span>
      </div>
      <pre class="rev-out" id="rev-out" hidden></pre>`;
    body.querySelectorAll('[data-rollback]').forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('按这条台账回滚？回滚本身也会记一条台账。')) return;
        const r = await post('/api/learn/ledger/restore', { id: b.dataset.rollback });
        if (r.stale) return;
        alert(r.ok ? r.message : `回滚失败：${r.message}`);
        if (r.ok) select('ledger');
      })
    );
    body.querySelector('#rev-run').addEventListener('click', async () => {
      const msg = body.querySelector('#rev-msg');
      const out = body.querySelector('#rev-out');
      if (!isConfigured(state.provider)) return alert('先在右上角配置模型接口');
      msg.textContent = '审查中…';
      const r = await post('/api/learn/review', { provider: state.provider, dryRun: body.querySelector('#rev-dry').checked });
      if (r.stale) return;
      msg.textContent = '';
      out.hidden = false;
      out.textContent = JSON.stringify(r, null, 2).slice(0, 3000);
    });
  }

  const renderers = { effectiveness: () => {
    // A late response may only update its own view, never the newly selected tab.
    const view = document.createElement('div'); body.replaceChildren(view);
    return renderSkillEffectiveness(view, apiFetch);
  }, memory: renderMemory, skills: renderSkills, pending: renderPending, ledger: renderLedger };
  const select = (t) => {
    const version = ++generation;
    activeTab=t;paintLearningTab(t);
    body.innerHTML='<div class="mon-empty">加载中…</div>';
    Promise.resolve(renderers[t]()).catch(error=>{if(isCurrent(version))panelError(error,()=>select(t));});
  };
  const paintLearningTab = bindTabs(mask.querySelector('[aria-label="学习分类"]'), body, select, tab);
  select(tab);
}

/* ------------------------------------------------------------------ 主题 */

function applyTheme() {
  const saved = localStorage.getItem('csl.theme');
  const dark = ['light','dark'].includes(saved) ? saved === 'dark' : window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  updateThemeButton();
}

function updateThemeButton() {
  const button = document.getElementById('btn-theme');
  if (!button) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  button.innerHTML = icon(dark ? 'sun' : 'moon', { size: 17 });
  button.title = dark ? '切换到浅色主题' : '切换到深色主题';
  button.setAttribute('aria-label', button.title);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('csl.theme', next);
  updateThemeButton();
}

/* ------------------------------------------------------------------ 启动 */

function showBooting(attempt, info = {}) {
  const host = document.getElementById('app');
  const steps = info.steps
    ? Object.entries(info.steps)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')
    : '';
  host.innerHTML = `
    <div class="boot-screen">
      ${brandMark({ size: 48 })}
      <div class="boot-spin" aria-hidden="true"></div>
      <h2>知衡 · Agent 工作台</h2>
      <p class="boot-lede">正在连接项目、工具与知识索引…</p>
      <p class="boot-meta">${
        attempt ? `第 ${attempt} 次重试 · 已等待 ${Math.round((info.elapsedMs || 0) / 1000)}s` : '连接中…'
      }</p>
      ${steps ? `<p class="boot-steps">${escapeHtml(steps)}</p>` : ''}
      ${info.bootError ? `<p class="boot-error">${escapeHtml(info.bootError)}</p>` : ''}
    </div>`;
}

/** 服务端初始化期间会返回 503，这里退避重试而不是直接报错 */
async function waitBootstrap(maxWaitMs = 90000) {
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    // R02：身份只认服务端签发的 HttpOnly Cookie，bootstrap 不再携带任何自报 id
    const res = await fetch('/api/bootstrap');
    if (res.status !== 503) {
      if (!res.ok) throw new Error(`bootstrap ${res.status}`);
      return res.json();
    }
    const info = await res.json().catch(() => ({}));
    // 初始化明确失败时不再空转重试，直接把原因抛给上层
    if (info.bootError) throw new Error(`服务初始化失败：${info.bootError}`);
    if (Date.now() - t0 > maxWaitMs) throw new Error('服务启动超时，请刷新页面重试');
    showBooting(attempt + 1, info);
    await new Promise((r) => setTimeout(r, Math.min(2000, 400 + attempt * 300)));
  }
}

async function boot() {
  installFormFeedback();
  showBooting(0);
  const data = await waitBootstrap();
  state.provider = await restoreProvider(state.provider);
  try {
    localStorage.setItem('csl.uid', data.user?.id || '');
  } catch {}
  renderShell();
  const stopStudio = mountStudioInteractions(document.querySelector('.shell'));
  window.addEventListener('pagehide', stopStudio, { once: true });
  state.user = data.user;
  state.conversations = data.conversations || [];
  state.corpus = data.corpus;
  state.stack = data.stack;
  state.upload = data.config?.upload || null;
  if (Array.isArray(state.upload?.extensions)) document.getElementById('file-input').accept = state.upload.extensions.map(ext => `.${ext}`).join(',');
  state.jointCapabilities = data.config?.jointResearch || null;
  projectSidebar = createProjectSidebar({ host: document.getElementById('projects-slot'), apiFetch,
    onUpdated(projects) {
      state.workspaceId = projects.activeId;
      state.workspaceName = projects.projects.find(p => p.id === projects.activeId)?.name || '个人工作区';
      state.conversations = projects.conversations;
      document.getElementById('studio-project-title').textContent = projects.projects.find(p => p.id === projects.activeId)?.name || '个人工作区';
      paintTaskContext();
    },
    async onProjectChange(workspace) {
      state.workspaceId = workspace.id; state.queue = []; renderQueueChips();
      newConversation(); await refreshWorkspaceBadge(); await refreshFilePermission();
    },
    onOpenConversation: id => { el.closeSidebar?.(); return openConversation(id); },
    onNewConversation: () => { el.closeSidebar?.(); newConversation(); el.input.focus(); },
    async onDeleteConversation(id) {
      const response = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('会话删除失败，请稍后重试。');
      if (state.conversationId === id) newConversation();
    },
  });
  await projectSidebar.refresh();
  window.addEventListener('pagehide', () => { projectSidebar.dispose(); artifactPreview.destroy(); }, {once:true});

  const panel = document.querySelector('zh-preferences');
  preferenceStore = createPreferenceStore({
    initial: data.preferences,
    persist: savePreference,
    async reload() {
      const res = await apiFetch('/api/bootstrap', { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { preferences } = await res.json();
      if (!preferences || typeof preferences !== 'object') throw new Error('偏好读取失败');
      return preferences;
    },
    render(view) {
      panel.update({ ...view, capabilities: state.jointCapabilities, disciplines: [...(state.corpus.disciplines || []), ...state.sections.map(s => ({ name: s.name, value: s.id }))] });
      paintTaskContext();
      const jointTrigger = document.getElementById('joint-research-trigger');
      jointTrigger.dataset.enabled = String(view.preferences.jointResearch === true);
      jointTrigger.querySelector('span').textContent = view.preferences.jointResearch ? `联合研究 · ${view.preferences.localWeight ?? 70}/${100 - (view.preferences.localWeight ?? 70)}` : '联合研究';
      jointTrigger.title = view.preferences.jointResearch ? '调整本地与外部证据占比' : '开启本地知识与权威外部来源联合研究';
      if (indexDiscipline !== view.preferences.discipline) {
        if(!state.focusedSource?.docId) state.focusedSource = null;
        paintFocusedSource();
        indexDiscipline = view.preferences.discipline;
        document.querySelector('zh-question-index')?.invalidate();
      }
    },
  });
  panel.addEventListener('preference-change', (event) => preferenceStore.change(event.detail));

  renderTopbar();
  renderSidebar();
  refreshWorkspaceBadge();
  agentActivity = createAgentActivity({ apiFetch, onOpenConversation: openConversation, button: document.getElementById('btn-activity') });
  const stopDictation = mountDictation({ input: el.input, host: document.getElementById('dictation-slot'), onError: text => { document.getElementById('hint-right').textContent = text; } });
  window.addEventListener('pagehide', () => { stopDictation(); agentActivity.close(); }, { once: true });
  document.getElementById('background-submit').addEventListener('click', async event => {
    const message = el.input.value.trim();
    if (!message || state.busy) { el.input.focus(); return; }
    if (!isConfigured(state.provider)) { document.getElementById('pill-model').click(); return; }
    event.currentTarget.disabled = true;
    if(state.focusedSource?.docId) { document.getElementById('hint-right').textContent='单篇文档研究请在前台发送，确保范围与原文可核对。';document.getElementById('background-submit').disabled=false;return; }
    const context = { conversationId: state.conversationId, workspaceId: state.workspaceId, mode:state.taskMode, provider: state.provider, ...(state.selectedSkill ? { skill: state.selectedSkill } : {}), ...(state.researchStrategy && state.taskMode === 'knowledge' ? { researchStrategy: state.researchStrategy } : {}) };
    try {
      if (!await preferenceStore.whenSettled()) throw new Error('请先保存偏好。');
      const response = await apiFetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, background: true, ...context }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message || '后台任务未能启动');
      el.input.value = ''; el.input.dispatchEvent(new Event('input')); setSelectedSkill(null); setResearchStrategy(null);
      await refreshConversations(); await agentActivity.open();
    } catch (error) { document.getElementById('hint-right').textContent = error.message; }
    finally { document.getElementById('background-submit').disabled = false; }
  });
  const carry = document.createElement('button'); carry.className = 'toolbar-button'; carry.innerHTML = icon('layers', { size: 16 }) + '<span>携摘要开启新会话</span>';
  document.querySelector('.status-popover').append(carry);
  carry.addEventListener('click', async () => {
    if (!state.conversationId || state.busy) return;
    carry.disabled = true;
    try {
      const response = await apiFetch(`/api/conversations/${state.conversationId}/new-context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await response.json(); if (!response.ok) throw new Error('新会话未能创建');
      await openConversation(data.conversation.id); await refreshConversations(); document.getElementById('runtime-status').open = false;
    } catch (error) { document.getElementById('hint-right').textContent = error.message; }
    finally { carry.disabled = false; }
  });

  const last = state.conversations.find(c => (c.workspaceId || 'default') === state.workspaceId);
  if (last) await openConversation(last.id);
  else renderEmptyState();

  el.input.addEventListener('input', () => {
    if (!state.focusedSource?.sticky && state.focusedSource?.question !== el.input.value.trim()) state.focusedSource = null;
    paintFocusedSource();
    el.input.style.height = 'auto';
    el.input.style.height = `${Math.min(el.input.scrollHeight, 160)}px`;
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    if (e.key === 'Escape' && !el.input.value.trim() && state.queue.length) {
      state.queue = [];
      renderQueueChips();
    }
  });
  el.send.addEventListener('click', () => {
    if (state.busy && state.abort) {
      state.abort.abort();
      return;
    }
    send();
  });

  document.getElementById('btn-new').addEventListener('click', () => { el.closeSidebar?.(); newConversation(); });
  document.getElementById('btn-knowledge').addEventListener('click',openKnowledge);
  const tools = document.getElementById('composer-tools');
  document.addEventListener('pointerdown', event => {
    if (tools.open && !tools.contains(event.target) && !document.querySelector('dialog[open]')) tools.open = false;
  });
  tools.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
      event.stopPropagation(); tools.open = false; tools.querySelector('summary').focus();
    }
  });
  document.getElementById('configure-first-model').addEventListener('click', () => document.getElementById('pill-model').click());
  document.querySelector('[data-context-project]').addEventListener('click', openWorkspace);
  document.querySelector('[data-context-scope]').addEventListener('click', () => configure?.(false, 'preferences'));
  document.getElementById('focused-source-chip').addEventListener('click',()=>{state.focusedSource=null;paintFocusedSource();el.input.focus();});
  document.querySelectorAll('[data-task-mode]').forEach(button=>button.addEventListener('click',()=>setTaskMode(button.dataset.taskMode)));
  setTaskMode(state.taskMode);
  document.getElementById('btn-section').addEventListener('click', () => editSection());
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('file-input').click());
  document.getElementById('file-input').addEventListener('change', (e) => {
    importFiles([...e.target.files]);
    e.target.value = '';
  });
  document.getElementById('btn-monitor').addEventListener('click', openMonitor);
  document.getElementById('btn-logic').addEventListener('click', () => openLogicWorkbench({
    initialAlgorithm: preferenceStore.current().logicAlgorithm,
    initialStrategy: state.researchStrategy || 'react',
    modelLabel: isConfigured(state.provider) ? state.provider.model : '',
    onSelectStrategy(strategy) {
      setTaskMode('knowledge');
      setResearchStrategy(strategy);
      setTimeout(() => el.input.focus(), 0);
      return true;
    },
    onUseForChat(algorithm) {
      preferenceStore.change({ logicAlgorithm: algorithm });
      return preferenceStore.whenSettled();
    },
  }));
  refreshKb(false).catch(err => { document.getElementById('kblist').textContent = err.message; });
  refreshLearnBadge();
  document.getElementById('pill-model').addEventListener('click', () => {
    openSettings({
      provider: state.provider,
      onSave: (p) => {
        state.provider = p;
        updateModelPill();
      },
    });
  });
  document.getElementById('btn-command').addEventListener('click',openCommands);
  document.getElementById('btn-workspace').addEventListener('click', () => openWorkspace());
  configure = (focusJoint = false, section = '') => openConfiguration({
    focusJoint, section,
    apiFetch,
    conversationId:state.conversationId,
    onOpenConversation:openConversation,
    onPermissionsChanged: paintFilePermission,
    onSearchChanged(capabilities) { if (capabilities) { state.jointCapabilities = capabilities; preferenceStore.paint(); } },
    panel: document.querySelector('zh-preferences'),
    provider: state.provider,
    onModel: () => openSettings({ provider: state.provider, onSave: p => { state.provider = p; updateModelPill(); } }),
    onLearning: () => openLearn('memory'),
    onMonitor: openMonitor,
    onTheme: theme => { localStorage.setItem('csl.theme', theme); applyTheme(); },
  });
  document.getElementById('btn-settings').addEventListener('click', () => configure());
  document.getElementById('file-permission-trigger').addEventListener('click', () => openFilePermissions({ apiFetch, onChange: paintFilePermission }));
  refreshFilePermission();
  const capabilityNavigator = createCapabilityNavigator({ apiFetch, button: document.getElementById('btn-capabilities'),
    onCompose(text) { el.input.value = text; el.input.dispatchEvent(new Event('input')); el.input.focus(); },
    onNavigate(action) {
      if (action.startsWith('settings-')) configure(false, action.slice(9));
      else if (action === 'workspace') openWorkspace();
      else if (action === 'activity') agentActivity.open();
      else if (action === 'learning') openLearn();
      else if (action === 'logic') document.getElementById('btn-logic').click();
      else if (action === 'model') document.getElementById('pill-model').click();
      else if (action === 'monitor') openMonitor();
      else if (action === 'knowledge') openKnowledge();
      else if (action === 'knowledge-conclusions') openKnowledge('conclusions');
      else configure(false, action);
    },
  });
  window.addEventListener('pagehide', () => capabilityNavigator.close(), { once: true });
  document.getElementById('joint-research-trigger').addEventListener('click', () => configure(true));
  document.getElementById('btn-learn').addEventListener('click', () => openLearn());
  document.getElementById('choose-skill').addEventListener('click', () => openLearn('skills'));
  document.getElementById('clear-skill').addEventListener('click', () => { setSelectedSkill(null); el.input.focus(); });
  document.getElementById('clear-research').addEventListener('click', () => { setResearchStrategy(null); el.input.focus(); });
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!['light','dark'].includes(localStorage.getItem('csl.theme'))) applyTheme();
  });
  applyTheme();

  document.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cite]');
    if (!chip) return;
    const holder = chip.closest('.msg');
    const source = [...(holder?.querySelectorAll('.ev') || [])].find((card) => card.dataset.ref === chip.dataset.cite);
    if (source) source.click();
  });

  updateModelPill();
  playStudioIntro();
}

boot().catch((err) => {
  document.getElementById('app').innerHTML =
    `<div style="padding:40px;font-family:system-ui">启动失败：${escapeHtml(err.message)}</div>`;
});
