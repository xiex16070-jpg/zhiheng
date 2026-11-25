import { showDialog } from './dialog.js';
/**
 * 本机模型凭据保存在服务端加密库；浏览器只保存不含密钥的连接引用。
 */

import { icon } from './icons.js';

const KEY = 'lkba.provider.v1';
// 各预设的 API Key 分开存，切换预设不会互相覆盖
const KEYS_KEY = 'lkba.keys.v2';

function loadKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEYS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function saveKey(presetId, apiKey) {
  if (!presetId) return;
  const m = loadKeys();
  if (apiKey) m[presetId] = apiKey;
  else delete m[presetId];
  try { localStorage.setItem(KEYS_KEY, JSON.stringify(m)); } catch { /* Server vault remains authoritative. */ }
}

export const PRESETS = [
  {
    id: 'zhiheng-local',
    name: '知衡 Qwen 本地',
    baseUrl: 'http://127.0.0.1:8018/v1',
    model: 'qwen3-8b-base',
    profileId: 'local-qwen',
    note: '配套本地服务 · 4096 上下文 · 检索、知衡推演与工作区工具，无命令执行和联网工具',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '支持函数调用，性价比高',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '需可访问的网络环境',
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    note: '长上下文',
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    note: '免费额度较多',
  },
  {
    id: 'dashscope',
    name: '阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: '阿里云百炼公共站 · OpenAI 兼容模式，Key 以 sk- 开头；专属实例请填 <实例ID>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  },
  {
    id: 'bailian-intl',
    name: '百炼·国际',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: '阿里云百炼国际站，账号开在新加坡等区域时使用',
  },
  {
    id: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    note: '需本机运行，地址须可被服务端访问',
  },
];

export function loadProvider() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...defaultProvider() };
    return { ...JSON.parse(raw) };
  } catch {
    return { ...defaultProvider() };
  }
}

export function saveProvider(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* Browsers may disable local storage. */ }
}

async function serverModels(method = 'GET', body) {
  const response = await (window.apiFetch || fetch)('/api/settings/models', { method,
    signal: AbortSignal.timeout(12000), headers: body ? { 'content-type': 'application/json', 'x-settings-request': '1' } : {},
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || '模型配置未能读取或保存');
  return data;
}

export async function restoreProvider(current) {
  try {
    const saved = await serverModels();
    const match = saved.profiles.find(p => (p.capability || 'chat') === 'chat' && p.baseUrl === current?.baseUrl);
    // A saved local model and its attested binding are one selection. Stale browser
    // names (or legacy keys) must not silently replace an explicitly saved adapter/base.
    if (match?.profileId === 'local-qwen' && isLoopbackProvider(match)) {
      saveProvider(match);
      if (current?.apiKey) saveKey(current.preset || 'custom', '');
      return match;
    }
    if (current?.apiKey) {
      const result = await serverModels('POST', { baseUrl: current.baseUrl, model: current.model,
        preset: current.preset || 'custom', apiKey: current.apiKey, revision: saved.revision });
      saveProvider(result.active); saveKey(current.preset || 'custom', '');
      return result.active;
    }
    const next = match ? { ...match, model: current.model || match.model } : saved.active || { ...current, savedKeyId: '' };
    if (next) saveProvider(next);
    return next;
  } catch { return current; } // Failed migration retains the usable old credential.
}

function defaultProvider() {
  const p = PRESETS.find((item) => item.id === 'deepseek');
  return { baseUrl: p.baseUrl, apiKey: '', model: p.model, preset: p.id };
}

function isLoopbackProvider(p) {
  try {
    const url = new URL(p?.baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

// Only a saved, attested profile configures arbitrary local model IDs. Legacy
// explicit adapter names remain compatible, but neither path accepts a remote URL.
export function isLocalQwenProvider(p) {
  return isLoopbackProvider(p) && ((p?.profileId === 'local-qwen' && /^[a-f0-9]{64}$/.test(p?.profileSha || ''))
    || /^qwen3-8b-zhiheng(?:$|[-:])/.test(String(p?.model || '')));
}

export function isConfigured(p) {
  return Boolean(p?.baseUrl && p?.model && (p?.apiKey || p?.savedKeyId || isLocalQwenProvider(p)));
}

export function openSettings({ provider, onSave }) {
  const mask = document.createElement('dialog');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h2 class="icon-label">${icon('settings', { size: 18 })}<span>接入大模型</span></h2>
        <button type="button" data-close title="关闭" aria-label="关闭模型设置">${icon('close', { size: 16 })}</button>
      </div>
      <div class="modal-body">
        <div class="presets" id="presets"></div>
        <div class="field">
          <label for="f-base">接口地址（OpenAI 兼容 Base URL）</label>
          <input id="f-base" spellcheck="false" placeholder="https://api.deepseek.com/v1" />
          <div class="hint">
            百炼公共站：<code>dashscope.aliyuncs.com/compatible-mode/v1</code>；
            专属实例：<code>&lt;实例ID&gt;.cn-beijing.maas.aliyuncs.com/compatible-mode/v1</code>
          </div>
        </div>
        <div class="field">
          <label for="f-key">API Key</label>
          <input id="f-key" type="password" spellcheck="false" placeholder="sk-..." />
          <div class="hint">
            加密保存在运行服务的本机，重启和更换浏览器后仍可读取配置。<br />
            已保存的密钥不会回填；留空保留。不同接口独立保存。
          </div>
        </div>
        <div class="field">
          <label for="f-model">模型名称</label>
          <input id="f-model" spellcheck="false" placeholder="deepseek-chat" />
          <div class="hint" id="local-profile-note" hidden>本地模式无需 API Key。提供检索、原文、引文、知衡推演、工作区与计划；不提供命令执行、联网工具和自动学习审查。上下文上限 4096 tokens，超限会提示新建会话。</div>
        </div>
        <fieldset class="choice-set"><legend>接口协议</legend><div class="choice-options"><label class="choice-item"><input type="radio" name="model-profile" value="" checked><span class="choice-face">通用模型</span></label><label class="choice-item"><input type="radio" name="model-profile" value="local-qwen"><span class="choice-face">知衡本地协议</span></label></div><p class="hint">本地协议保存时核验服务的提示词、工具与预算哈希；不匹配会拒绝启用。</p></fieldset><label class="integration-toggle model-vision-toggle"><input type="checkbox" id="f-vision"><span><strong>支持视觉输入</strong><small>仅当此模型能读取图片时开启，允许 Agent 查看工作区 PNG / JPEG。</small></span></label>
        <div class="status icon-label" id="status" role="status" aria-live="polite" aria-atomic="true"></div>
      </div>
      <div class="modal-foot">
        <button type="button" class="btn" id="btn-remove-model" hidden>移除保存的密钥</button>
        <button type="button" class="btn icon-label" id="btn-test">${icon('activity', { size: 15 })}<span>测试连接</span></button>
        <button type="button" class="btn primary icon-label" id="btn-save">${icon('check', { size: 15 })}<span>保存</span></button>
      </div>
    </div>
  `;

  const presetsEl = mask.querySelector('#presets');
  const baseEl = mask.querySelector('#f-base');
  const keyEl = mask.querySelector('#f-key');
  const modelEl = mask.querySelector('#f-model');
  const visionEl = mask.querySelector('#f-vision');
  visionEl.checked = provider?.vision === true;
  mask.querySelector(`[name=model-profile][value="${provider?.profileId==='local-qwen'?'local-qwen':''}"]`).checked=true;
  const statusEl = mask.querySelector('#status');
  const syncProfileHint = () => {
    const draft = { baseUrl: baseEl.value.trim(), model: modelEl.value.trim() };
    const local = isLoopbackProvider(draft) && (mask.querySelector('[name=model-profile]:checked').value === 'local-qwen' || isLocalQwenProvider(draft));
    mask.querySelector('#local-profile-note').hidden = !local;
    keyEl.placeholder = local ? '本地服务可留空' : matchingProfile()?.savedKeyId ? '密钥已保存；留空保留，无需重输' : 'sk-...';
    mask.querySelector('#btn-remove-model').hidden = !matchingProfile()?.savedKeyId;
  };
  baseEl.addEventListener('input', syncProfileHint);
  modelEl.addEventListener('input', syncProfileHint);
  mask.querySelectorAll('[name=model-profile]').forEach(input => input.addEventListener('change', syncProfileHint));

  let current = { ...provider };
  let activePreset = current.preset || '';
  let vault = { revision: 0, profiles: [] }, loading = true;
  const drafts = new Map();
  const matchingProfile = () => vault.profiles.find(p => (p.capability || 'chat') === 'chat' && p.baseUrl === baseEl.value.trim().replace(/\/$/, ''));

  PRESETS.forEach((p) => {
    const b = document.createElement('button');
    b.className = 'preset' + (p.id === activePreset ? ' active' : '');
    b.dataset.preset = p.id;
    b.textContent = p.name;
    b.title = p.note;
    b.addEventListener('click', () => {
      // 切换前先把当前输入框里的 Key 归到当前预设名下
      drafts.set(activePreset || 'custom', keyEl.value.trim());
      activePreset = p.id;
      baseEl.value = p.baseUrl;
      modelEl.value = p.model;
      mask.querySelector(`[name=model-profile][value="${p.profileId || ''}"]`).checked = true;
      visionEl.checked = matchingProfile()?.vision === true;
      keyEl.value = drafts.get(p.id) || loadKeys()[p.id] || '';
      syncProfileHint();
      presetsEl.querySelectorAll('.preset').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      markKeys();
      setStatus(matchingProfile()?.savedKeyId ? '服务端已保存此接口的密钥，无需重新输入。' : keyEl.value ? '已载入旧版浏览器密钥；保存后迁入本机加密库。' : '');
    });
    presetsEl.appendChild(b);
  });

  const savedKeys = loadKeys();
  baseEl.value = current.baseUrl || '';
  keyEl.value = savedKeys[activePreset] || current.apiKey || '';
  modelEl.value = current.model || '';
  syncProfileHint();

  // 有已保存 Key 的预设加个小圆点，一眼能看出哪些配过
  const markKeys = () => {
    const m = loadKeys();
    presetsEl.querySelectorAll('.preset').forEach((el) => {
      el.classList.toggle('has-key', Boolean(m[el.dataset.preset] || vault.profiles.some(p => p.preset === el.dataset.preset && p.savedKeyId)));
    });
  };
  markKeys();

  // 服务端返回的是错误码，这里翻成能看懂的话
  const ERR_TEXT = {
    private_upstream_blocked: '出于安全考虑不允许连接内网地址（本机 Ollama 需从本机访问）',
    provider_invalid: '接口地址格式不正确，需以 http:// 或 https:// 开头',
    provider_required: '请先填写接口地址',
  };
  const errText = (code) => ERR_TEXT[code] || code;

  const setStatus = (text, kind = '') => {
    statusEl.replaceChildren();
    statusEl.className = `status icon-label ${kind}`;
    if (text) {
      statusEl.insertAdjacentHTML('afterbegin', icon(kind === 'ok' ? 'check' : kind === 'err' || kind === 'warn' ? 'warning' : 'info', { size: 15 }));
      const label = document.createElement('span');
      label.textContent = text;
      statusEl.appendChild(label);
    }
  };

  mask.querySelector('#btn-test').addEventListener('click', async () => {
    setStatus('测试中…');
    try {
      const res = await (window.apiFetch || fetch)('/api/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseEl.value.trim(),
          apiKey: keyEl.value.trim(),
          model: modelEl.value.trim(),
          savedKeyId: matchingProfile()?.savedKeyId || current.savedKeyId || '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(errText(data.error) || `HTTP ${res.status}`);
      const ids = (data.data || []).map((m) => m.id);
      setStatus(
        data.message ||
          (ids.length ? `连接成功，可用模型 ${ids.length} 个，例如 ${ids.slice(0, 3).join('、')}` : '连接成功'),
        data.warn ? 'warn' : 'ok'
      );
    } catch (err) {
      setStatus(`连接失败：${err.message}`, 'err');
    }
  });

  mask.querySelector('#btn-save').addEventListener('click', async () => {
    if (loading) return;
    const next = {
      baseUrl: baseEl.value.trim().replace(/\/$/, ''),
      apiKey: keyEl.value.trim(),
      model: modelEl.value.trim(),
      preset: activePreset,
      vision: visionEl.checked,
      capability: 'chat',
      profileId:mask.querySelector('[name=model-profile]:checked').value,
    };
    if (!next.baseUrl || !next.model) {
      setStatus('接口地址与模型名称不能为空', 'err');
      return;
    }
    loading = true; mask.querySelector('#btn-save').disabled = true;
    try {
      const result = await serverModels('POST', { ...next, revision: vault.revision });
      saveKey(activePreset || 'custom', ''); saveProvider(result.active);
      onSave(result.active); close();
    } catch (err) { setStatus(err.message, 'err'); }
    finally { loading = false; mask.querySelector('#btn-save').disabled = false; }
  });
  mask.querySelector('#btn-remove-model').addEventListener('click', async () => {
    if (loading || !matchingProfile()?.savedKeyId) return;
    loading = true;
    try {
      const result = await serverModels('DELETE', { savedKeyId: matchingProfile().savedKeyId, revision: vault.revision });
      vault = result; keyEl.value = ''; saveKey(activePreset || 'custom', '');
      const next = result.active || { baseUrl: baseEl.value.trim(), model: modelEl.value.trim(), preset: activePreset, apiKey: '' };
      saveProvider(next); onSave(next); close();
    } catch (err) { setStatus(err.message, 'err'); }
    finally { loading = false; }
  });

  const close = showDialog(mask, { initialFocus: baseEl, onClose: () => { keyEl.value = ''; drafts.clear(); } });
  mask.querySelector('#btn-save').disabled = true;
  serverModels().then(data => {
    vault = data; loading = false; mask.querySelector('#btn-save').disabled = false;
    syncProfileHint(); markKeys();
    if (data.unreadable) setStatus('本机模型凭据库无法读取，请检查备份的 .credential-key；若无法恢复，请重新填写后保存。', 'warn');
    else if (matchingProfile()?.savedKeyId) setStatus('已载入本机配置；密钥无需重新输入。', 'ok');
  }).catch(err => setStatus(err.message + '。可关闭后重新打开。', 'err'));
}
