import { mountJudgeSettings } from './judge-settings.js';
import { showDialog } from './dialog.js';
import { icon } from './icons.js';
import { escapeHtml } from '../agent/text.js';
import { mountWebSearchSettings } from './web-search-settings.js';
import { mountExtensions } from './extensions-settings.js';
import { mountIntegrationSettings } from './integration-settings.js';
import { mountFilePermissions } from './file-permissions.js';
import { playStudioIntro } from './studio.js';
import { mountRuntimeSettings } from './runtime-settings.js';
import { mountContextInsights } from './context-insights.js';
import { mountAgentTeams } from './agent-teams.js';
import { CONFIGURATION_SECTIONS, resolveConfigurationSection } from './configuration-sections.js';
export { CONFIGURATION_SECTIONS } from './configuration-sections.js';

/** Reuse the mounted preference panel and the existing configuration entry points. */
export function openConfiguration({ panel, provider, onModel, onLearning, onMonitor, onTheme, focusJoint = false, section = '', apiFetch, onSearchChanged, onPermissionsChanged, conversationId, onOpenConversation }) {
  const existing = document.querySelector('dialog.app-settings[open]');
  if (existing) {
    if (section || focusJoint) existing.dispatchEvent(new CustomEvent('configuration:section', { detail: focusJoint ? 'joint' : section }));
    else existing.querySelector('#app-settings-close').focus();
    return;
  }
  const home = panel.parentElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'modal-mask app-settings';
  dialog.innerHTML = `<section class="modal configuration-panel">
    <div class="modal-head configuration-heading"><div><span class="configuration-eyebrow">WORKSPACE / SETTINGS</span><h2>${icon('settings', { size: 19 })} 工作台设置</h2></div>
      <button id="app-settings-close" type="button" data-close aria-label="关闭设置">${icon('close', { size: 17 })}</button></div>
    <nav class="configuration-navigation" aria-label="设置分区">${CONFIGURATION_SECTIONS.map((item, index) => `<button type="button" data-settings-section="${item.id}" aria-controls="${item.selector.slice(1)}"${index === 0 ? ' aria-current="location"' : ''}>${icon(item.icon, { size: 16 })}<span>${item.label}</span></button>`).join('')}</nav>
    <div class="modal-body configuration-body">
      <div class="configuration-overview" id="configuration-overview"><div class="configuration-section-intro"><span class="configuration-eyebrow">YOUR WORKBENCH</span><h3>让工作台适合你的工作方式</h3><p>选择上方分区直接定位；连接、权限与偏好分别保存。</p></div><div class="configuration-links">
        <button class="configuration-link" id="settings-model" type="button">${icon('settings', { size: 19 })}<span><strong>模型与接口</strong><small>${escapeHtml(provider?.model || '配置对话模型与访问凭据')}</small></span>${icon('chevron-right', { size: 15 })}</button>
        <button class="configuration-link" id="settings-learning" type="button">${icon('learning', { size: 19 })}<span><strong>学习与记忆</strong><small>用户画像、记忆与技能</small></span>${icon('chevron-right', { size: 15 })}</button>
        <button class="configuration-link" id="settings-monitor" type="button">${icon('activity', { size: 19 })}<span><strong>运行状态</strong><small>任务、工具调用与服务状态</small></span>${icon('chevron-right', { size: 15 })}</button>
        <button class="configuration-link" id="settings-search" type="button">${icon('search', { size: 19 })}<span><strong>网站搜索</strong><small>搜索密钥与连接测试</small></span>${icon('chevron-right', { size: 15 })}</button>
        <button class="configuration-link" id="settings-extensions" type="button">${icon('workspace', { size: 19 })}<span><strong>能力与插件</strong><small>PDF、Word、浏览器与 MCP</small></span>${icon('chevron-right', { size: 15 })}</button>
        <button class="configuration-link" data-settings-jump="runtime" type="button">${icon('terminal', { size: 19 })}<span><strong>执行环境</strong><small>命令、进程、本机浏览器与数学排版</small></span>${icon('chevron-right',{size:15})}</button>
        <button class="configuration-link" data-settings-jump="context" type="button">${icon('layers', { size: 19 })}<span><strong>上下文洞察</strong><small>组成、趋势、用量与压缩</small></span>${icon('chevron-right',{size:15})}</button>
        <button class="configuration-link" data-settings-jump="teams" type="button">${icon('branch', { size: 19 })}<span><strong>智能体团队</strong><small>多模型角色与本机代理协作</small></span>${icon('chevron-right',{size:15})}</button>
      </div></div>
      <section id="configuration-appearance" class="configuration-appearance" aria-labelledby="appearance-heading"><div class="configuration-theme"><h3 id="appearance-heading">界面外观</h3>
        <div class="configuration-theme-options" role="group" aria-label="界面主题">
          <button type="button" class="btn" data-settings-theme="light">${icon('sun', { size: 16 })} 浅色</button>
          <button type="button" class="btn" data-settings-theme="dark">${icon('moon', { size: 16 })} 深色</button>
          <button type="button" class="btn" data-settings-theme="system">${icon('workspace', { size: 16 })} 跟随系统</button>
        </div>
      </div>
      <div class="studio-appearance"><div><strong>开屏动画</strong><small>每次浏览器会话播放一次；可跳过，遵循减少动态效果。</small></div><button type="button" class="btn" id="settings-intro-toggle" aria-pressed="true">已开启</button><button type="button" class="btn" id="settings-intro-replay">重播</button></div></section>
      <div id="settings-file-permissions"></div>
      <div id="settings-runtime-slot"></div>
      <div id="settings-context-slot"></div>
      <div id="settings-teams-slot"></div><div id="settings-judge-slot"></div>
      <div id="settings-search-slot"></div>
      <div id="settings-extensions-slot"></div>
      <div id="settings-integrations-slot"></div>
      <div id="settings-preferences-slot"></div>
    </div></section>`;
  dialog.querySelector('#settings-preferences-slot').append(panel);
  mountFilePermissions(dialog.querySelector('#settings-file-permissions'), { apiFetch, onChange: onPermissionsChanged });
  const cleanupRuntime=mountRuntimeSettings(dialog.querySelector('#settings-runtime-slot'),{apiFetch});
  const cleanupContext=mountContextInsights(dialog.querySelector('#settings-context-slot'),{apiFetch,conversationId,onOpenConversation:id=>{dialog.addEventListener('close',()=>onOpenConversation?.(id),{once:true});dialog.close();}});
  const cleanupJudge=mountJudgeSettings(dialog.querySelector('#settings-judge-slot'),{apiFetch});
  const cleanupTeams=mountAgentTeams(dialog.querySelector('#settings-teams-slot'),{apiFetch,getProvider:()=>provider});
  const cleanupSearch = mountWebSearchSettings(dialog.querySelector('#settings-search-slot'), { apiFetch, onChanged: onSearchChanged });
  const cleanupExtensions = mountExtensions(dialog.querySelector('#settings-extensions-slot'), { apiFetch });
  const cleanupIntegrations = mountIntegrationSettings(dialog.querySelector('#settings-integrations-slot'), { apiFetch,
    onExtensionsChanged: () => dialog.querySelector('#extension-reload')?.click() });
  const body = dialog.querySelector('.configuration-body');
  const navigation = dialog.querySelector('.configuration-navigation');
  const sections = CONFIGURATION_SECTIONS.map(item => ({ ...item, node: dialog.querySelector(item.selector) }));
  for (const item of sections) {
    item.node.dataset.configurationSection = item.id;
    item.node.tabIndex = -1;
    item.node.setAttribute('aria-label', item.label);
  }
  let frame = 0, scrollTimer = 0, navigating = false, jumpTarget = null;
  const setCurrent = id => {
    for (const button of navigation.querySelectorAll('[data-settings-section]')) {
      if (button.dataset.settingsSection === id) button.setAttribute('aria-current', 'location');
      else button.removeAttribute('aria-current');
    }
  };
  const updateCurrent = () => {
    frame = 0;
    if (navigating || !dialog.open) return;
    const edge = body.getBoundingClientRect().top + 28;
    let current = sections[0];
    for (const item of sections) if (item.node.getBoundingClientRect().top <= edge) current = item;
    if (body.scrollHeight - body.scrollTop - body.clientHeight < 3) current = sections.at(-1);
    setCurrent(current.id);
  };
  const scheduleCurrent = () => { if (!frame) frame = requestAnimationFrame(updateCurrent); };
  const sizeObserver = new ResizeObserver(() => {
    // Sections load independently. Keep an explicitly focused destination aligned
    // when an earlier form grows; relinquish ownership on user navigation.
    if (jumpTarget?.node === document.activeElement && dialog.open) {
      const delta = jumpTarget.node.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
      if (Math.abs(delta) > 1) body.scrollTo({ top: Math.max(0, body.scrollTop + delta), behavior: 'instant' });
      setCurrent(jumpTarget.section);
    }
    scheduleCurrent();
  });
  sizeObserver.observe(body);
  for (const item of sections) sizeObserver.observe(item.node);
  const jump = (id, { smooth = true, focus = true } = {}) => {
    const target = resolveConfigurationSection(id);
    if (!target) return false;
    if (target.panel) dialog.querySelector(`[data-panel="${target.panel}"]`)?.click();
    const node = dialog.querySelector(target.selector);
    if (!node) return false;
    clearTimeout(scrollTimer);
    navigating = true;
    setCurrent(target.section);
    const behavior = smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant';
    body.scrollTo({ top: Math.max(0, body.scrollTop + node.getBoundingClientRect().top - body.getBoundingClientRect().top - 12), behavior });
    if (focus) {
      if (!node.matches('button,input,textarea,select,a[href],[tabindex]')) node.tabIndex = -1;
      node.focus({ preventScroll: true });
      jumpTarget = { node, section: target.section };
    }
    scrollTimer = setTimeout(() => { navigating = false; scheduleCurrent(); }, behavior === 'smooth' ? 650 : 50);
    return true;
  };
  body.addEventListener('scroll', scheduleCurrent, { passive: true });
  const cancelNavigation = () => { jumpTarget = null; navigating = false; clearTimeout(scrollTimer); scheduleCurrent(); };
  body.addEventListener('wheel', cancelNavigation, { passive: true });
  body.addEventListener('touchstart', cancelNavigation, { passive: true });
  body.addEventListener('keydown', event => { if (['PageUp','PageDown','ArrowUp','ArrowDown','Home','End'].includes(event.key)) cancelNavigation(); });
  navigation.addEventListener('click', event => {
    const button = event.target.closest('[data-settings-section]');
    if (button) jump(button.dataset.settingsSection);
  });
  navigation.addEventListener('keydown', event => {
    const buttons = [...navigation.querySelectorAll('[data-settings-section]')];
    const index = buttons.indexOf(event.target);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  dialog.addEventListener('configuration:section', event => jump(event.detail));
  const close = showDialog(dialog, { initialFocus: dialog.querySelector(focusJoint ? '#joint-enabled' : '#app-settings-close'),
    onClose: () => { sizeObserver.disconnect(); cancelAnimationFrame(frame); clearTimeout(scrollTimer); cleanupSearch(); cleanupExtensions(); cleanupIntegrations(); cleanupRuntime(); cleanupContext(); cleanupTeams(); cleanupJudge(); home.append(panel); } });
  dialog.querySelectorAll('[data-settings-jump]').forEach(button => button.addEventListener('click', () => jump(button.dataset.settingsJump)));
  dialog.querySelector('#settings-extensions').addEventListener('click', () => jump('extensions'));
  dialog.querySelector('#settings-search').addEventListener('click', () => jump('search'));
  if (focusJoint || section) requestAnimationFrame(() => dialog.isConnected && jump(focusJoint ? 'joint' : section, { smooth: false }));
  for (const [id, action] of [['settings-model', onModel], ['settings-learning', onLearning], ['settings-monitor', onMonitor]]) {
    dialog.querySelector('#' + id).addEventListener('click', () => {
      dialog.addEventListener('close', () => action(), { once: true });
      close();
    });
  }
  const paintTheme = () => {
    for (const button of dialog.querySelectorAll('[data-settings-theme]')) {
      button.setAttribute('aria-pressed', String(button.dataset.settingsTheme === (localStorage.getItem('csl.theme') || 'system')));
    }
  };
  for (const button of dialog.querySelectorAll('[data-settings-theme]')) {
    button.addEventListener('click', () => { onTheme(button.dataset.settingsTheme); paintTheme(); });
  }
  paintTheme();
  const intro = dialog.querySelector('#settings-intro-toggle');
  const paintIntro = () => { const enabled = localStorage.getItem('zh.intro') !== 'off'; intro.setAttribute('aria-pressed', String(enabled)); intro.textContent = enabled ? '已开启' : '已关闭'; };
  intro.addEventListener('click', () => { localStorage.setItem('zh.intro', intro.getAttribute('aria-pressed') === 'true' ? 'off' : 'on'); paintIntro(); });
  paintIntro();
  dialog.querySelector('#settings-intro-replay').addEventListener('click', () => { dialog.addEventListener('close', () => playStudioIntro({ force: true }), { once: true }); close(); });
}
