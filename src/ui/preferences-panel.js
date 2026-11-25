import { icon } from './icons.js';
import { animateState } from './motion.js';
import { jointControlsMarkup, paintJointControls, paintJointWeight } from './joint-research.js';

// Only this static catalog is used to build HTML. Corpus names and API feedback
// are assigned to DOM properties so they remain plain text.
const groups = [
  { key: 'style', label: '回答风格', fallback: 'balanced', choices: [
    ['concise', '简洁'], ['balanced', '均衡'], ['detailed', '详细'],
  ] },
  { key: 'discipline', label: '学科范围', fallback: '', choices: [] },
  { key: 'inference', label: '推断方式', fallback: 'balanced', choices: [
    ['off', '仅陈述事实'], ['balanced', '适度推断'], ['active', '主动推断'],
  ] },
  { key: 'learning', label: '学习审查', fallback: 'on', choices: [
    ['on', '开启'], ['off', '关闭'],
  ] },
];

function choice(key, value, text) {
  const label = document.createElement('label');
  label.className = 'pref-choice';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = key;
  radio.value = value;
  const face = document.createElement('span');
  face.className = 'pref-face';
  face.textContent = text;
  label.append(radio, face);
  return label;
}

const statuses = { loading: '正在读取', idle: '', saving: '正在保存', saved: '已保存', error: '偏好未能保存' };

class PreferencesPanel extends HTMLElement {
  #initialized = false;
  #ready = false;

  connectedCallback() {
    this.#mount();
  }

  #mount() {
    if (this.#initialized) return;
    this.#initialized = true;
    this.classList.add('side-block', 'preferences-block');
    const fields = groups.map(({ key, label }, index) => `
      <fieldset class="pref-field" id="pref-${key}" disabled${key === 'learning' ? ' aria-describedby="learning-help"' : ''}>
        <legend><span class="pref-folio" aria-hidden="true">0${index + 1}</span>${label}</legend>
        <div class="pref-options"></div>
      </fieldset>`).join('');
    this.innerHTML = `
      ${jointControlsMarkup()}
      <section class="pref-card" aria-labelledby="pref-heading">
        <header class="pref-heading">
          <h2 id="pref-heading">${icon('settings', { size: 18 })}回答偏好</h2>
          <span class="pref-scale" aria-hidden="true"></span>
          <span id="pref-status" class="pref-status" role="status" aria-atomic="true">正在读取</span>
        </header>
        <div class="pref-body">
          ${fields}
          <label class="pref-quote">
            <span>${icon('quote', { size: 15 })}逐字引文</span>
            <input name="citeQuotes" id="pref-quote" type="checkbox" role="switch" disabled>
            <span class="pref-switch" aria-hidden="true"></span>
          </label>
        </div>
      </section>
      <details class="preference-help">
        <summary>${icon('info', { size: 13 })}偏好说明</summary>
        <p>推断会标明前提与限制。逐字引文要求给出可定位的原句。</p>
        <p id="learning-help">学习审查可能在任务后额外调用当前模型，费用按所用接口计算。记忆候选仍需审核。</p>
      </details>`;
    for (const { key, choices } of groups) {
      this.querySelector(`#pref-${key} .pref-options`).append(...choices.map(([value, text]) => choice(key, value, text)));
    }
    this.addEventListener('change', ({ target }) => {
      if (!this.#ready || !(target instanceof HTMLInputElement) || target.matches(':disabled')) return;
      const value = target.type === 'checkbox' ? target.checked : target.type === 'range' ? Number(target.value) : target.value;
      if (target.checked) animateState(target.nextElementSibling);
      this.dispatchEvent(new CustomEvent('preference-change', { bubbles: true, detail: { [target.name]: value } }));
    });
    this.querySelector('#joint-weight').addEventListener('input', event => paintJointWeight(this, Number(event.target.value)));
    this.querySelectorAll('[data-joint-weight]').forEach(button => button.addEventListener('click', () => {
      const input = this.querySelector('#joint-weight');
      if (input.matches(':disabled')) return;
      input.value = button.dataset.jointWeight;
      animateState(button);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }));
  }

  #syncDisciplines(disciplines, selected) {
    const names = new Map([['', '全部学科']]);
    for (const { name, value = name } of disciplines) if (typeof name === 'string' && name.length) names.set(value, name);
    if (selected && !names.has(selected)) names.set(selected, selected.startsWith('kb:') ? '所选分区' : selected);
    const host = this.querySelector('#pref-discipline .pref-options');
    const inputs = [...host.querySelectorAll('input')];
    const values = [...names];
    if (inputs.length === values.length && inputs.every((input, index) =>
      input.value === values[index][0] && input.nextElementSibling?.textContent === values[index][1])) return;
    const focused = inputs.find((input) => input === document.activeElement);
    host.replaceChildren(...values.map(([value, label]) => choice('discipline', value, label)));
    if (focused) {
      const next = [...host.querySelectorAll('input')].find((input) => input.value === focused.value);
      (next || host.querySelector('input')).focus({ preventScroll: true });
    }
  }

  update({ preferences, disciplines = [], capabilities, status = { kind: 'loading' } }) {
    this.#mount();
    if (status.kind === 'loading') this.#ready = false;
    else if (status.kind !== 'error' && preferences) this.#ready = true;
    paintJointControls(this, preferences, { ready: this.#ready, capabilities, status });
    this.#syncDisciplines(disciplines, preferences?.discipline);
    for (const { key, fallback } of groups) {
      const field = this.querySelector(`#pref-${key}`);
      field.disabled = !this.#ready;
      const inputs = [...field.querySelectorAll('input')];
      const selected = inputs.find((input) => input.value === preferences?.[key])
        || inputs.find((input) => input.value === fallback);
      if (selected) selected.checked = true;
    }
    const quote = this.querySelector('#pref-quote');
    quote.disabled = !this.#ready;
    quote.checked = preferences?.citeQuotes ?? true;
    const message = this.querySelector('#pref-status');
    message.dataset.kind = status.kind;
    const text = status.message || statuses[status.kind] || '';
    if (message.textContent !== text) message.textContent = text;
  }
}

customElements.define('zh-preferences', PreferencesPanel);
