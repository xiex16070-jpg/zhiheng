import { showDialog } from './dialog.js';
import { escapeHtml } from '../agent/text.js';
import { icon } from './icons.js';
import { bindResearchPanel, researchPanelHtml } from './research-strategies.js';
import { prefersReducedMotion } from './motion.js';
import { disclosureSummary } from './disclosure.js';

const SAMPLES = [
  { name: '充分条件与未知', program: '事实 已验证(程序甲)。\n规则 安全保证：若 已验证(?程序) 则 满足规范(?程序)。\n查询 满足规范(程序甲)。\n查询 已验证(程序乙)。' },
  { name: '只有……才……', program: '事实 可发布(项目甲)。\n规则 发布要求：只有 审核通过(?项目) 才 可发布(?项目)。\n查询 审核通过(项目甲)。\n事实 审核通过(项目乙)。\n查询 可发布(项目乙)。' },
  { name: '显式否定与冲突', program: '事实 安全(模块甲)。\n事实 非 安全(模块甲)。\n事实 非 安全(模块乙)。\n查询 安全(模块甲)。\n查询 安全(模块乙)。\n查询 安全(模块丙)。' },
  { name: '默认规则与例外', program: '事实 审核通过(项目甲)。\n事实 审核通过(项目乙)。\n事实 存在漏洞(项目乙)。\n规则 默认发布：若 审核通过(?项目) 则 可发布(?项目) 除非 存在漏洞(?项目)。\n查询 可发布(项目甲)。\n查询 可发布(项目乙)。' },
  { name: '递归路径 · 比较算法', program: [
    ...Array.from({ length: 9 }, (_, i) => `事实 边(${i}，${i + 1})。`),
    '规则 单步：若 边(?起，?止) 则 路(?起，?止)。',
    '规则 连接：若 路(?起，?中) 且 路(?中，?止) 则 路(?起，?止)。', '查询 路(7，9)。',
  ].join('\n') },
];
const LABELS = { true: '成立', false: '不成立', both: '冲突', unknown: '未知' };
const ALGORITHMS = {
  naive: ['分层正向', '按规则逐轮推出全部结论'],
  'semi-naive': ['半朴素增量', '用新增事实推进递归规则'],
  'magic-sets': ['查询导向', '按查询对象缩小推导范围'],
};
const printable = (value) => typeof value === 'string' ? value : JSON.stringify(value);

function downloadLogicResult(result) {
  if (!result) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = '知衡-推演证明.json';
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Formal derivation has a separate presentation from model-assessed inference. */
export function logicResultHtml(result) {
  if (!result || result.ok === false) return `<p class="logic-error">${escapeHtml(result?.error?.message || '推演未完成')}</p>`;
  const proofs = result.proofs || [];
  const rows = (result.queries || []).map((query) => `<div class="logic-query">
    <span class="logic-verdict ${Object.hasOwn(LABELS, query.status) ? query.status : 'unknown'}">${escapeHtml(LABELS[query.status] || '未知')}</span>
    <code>${escapeHtml(printable(query.query))}</code>
    <span class="logic-proof-ref">${escapeHtml([query.positiveProof, query.negativeProof].filter(Boolean).join(' / '))}</span>
  </div>`).join('');
  const records = proofs.slice(0, 100).map((proof) => `<li class="logic-proof-node" data-proof="${escapeHtml(proof.id)}"><div class="logic-proof-inputs">${proof.premises?.length ? `${proof.premises.map(id => `<code>${escapeHtml(id)}</code>`).join('<span>+</span>')}<span aria-hidden="true">→</span>` : icon('pin', { size: 14 })}<span>${proof.kind === 'fact' ? '输入事实' : `规则 ${escapeHtml(proof.rule || '')}`}</span></div><div class="logic-proof-conclusion"><code>${escapeHtml(proof.id)}</code><strong>${escapeHtml(printable(proof.conclusion))}</strong></div>
    <small>第 ${Number(proof.line) || '?'} 行${proof.refs?.length ? ` · 来源 ${escapeHtml(proof.refs.join(', '))}` : ''}</small>
    ${proof.assumptions?.length ? `<small class="logic-default">默认假设：${escapeHtml(proof.assumptions.map((a) => `未推导出 ${printable(a.literal)}`).join('；'))}</small>` : ''}</li>`).join('');
  return `<div class="logic-result"><p class="logic-scope">${icon('inference', { size: 16 })} 确定性推演 · 结论相对于给定事实与规则成立；前提真实性和原文转写需另行核对。</p>
    ${Object.hasOwn(ALGORITHMS, result.algorithm) && result.stats ? `<p class="logic-run-stats">${ALGORITHMS[result.algorithm][0]} · ${Number(result.stats.comparisons)} 次候选事实匹配 · ${Number(result.stats.derivedFacts)} 条派生事实 · ${result.factScope === 'query' ? '查询及分层依赖' : '完整闭包'}</p>` : ''}
    ${rows || '<p>没有查询。请用「查询 谓词(对象)。」查看结论。</p>'}
    <details class="logic-proofs result-disclosure">${disclosureSummary('规则证明路径', { symbol: 'branch', meta: `${proofs.length} 个节点 · 前提 → 规则 → 结论` })}<div class="disclosure-body"><ol class="logic-proof-graph">${records}</ol>${proofs.length > 100 ? '<p>界面显示前 100 条，完整记录可下载为 JSON。</p>' : ''}</div></details>
    ${(result.warnings || []).length ? `<p class="logic-note">${result.warnings.map((w) => `<span>${escapeHtml(printable(w))}</span>`).join(' ')}</p>` : ''}
  </div>`;
}

export function appendLogicResult(host, result) {
  const key = result?.program || JSON.stringify(result?.queries || result?.error);
  if ([...host.querySelectorAll('.logic-chat-panel')].some((panel) => panel.logicKey === key)) return;
  const panel = document.createElement('details');
  panel.className = 'logic-chat-panel result-disclosure';
  panel.logicKey = key;
  panel.innerHTML = `${disclosureSummary('知衡 · 规则推演', { symbol: 'inference', meta: result?.ok === false ? '推演未完成' : `${result?.queries?.length || 0} 项查询 · ${result?.proofs?.length || 0} 个证明节点` })}<div class="disclosure-body"><div class="logic-toolbar"><button type="button" class="btn tiny logic-export">${icon('download', { size: 14 })} 下载完整证明</button></div>${logicResultHtml(result)}</div>`;
  panel.querySelector('.logic-export').addEventListener('click', () => downloadLogicResult(result));
  host.appendChild(panel);
}

export function openLogicWorkbench({ initialAlgorithm, onUseForChat, initialStrategy, modelLabel, onSelectStrategy } = {}) {
  const mask = document.createElement('dialog');
  mask.className = 'modal-mask logic-mask';
  mask.innerHTML = `<section class="modal logic-workbench">
    <div class="modal-head logic-masthead"><div><div class="logic-kicker"><i></i> ZH / REASONING LAB</div><h2 id="logic-title">知衡推演</h2><p>查阅文献依据，检验推理路径。</p></div>
      <svg class="logic-engraving" viewBox="0 0 195 64" fill="none" aria-hidden="true"><path d="M5 32h28m0 0 34-20h32M33 32l34 20h32m0-40 36 20-36 20m36-20h47" stroke="currentColor"/><g fill="currentColor"><circle cx="33" cy="32" r="3"/><circle cx="99" cy="12" r="3"/><circle cx="99" cy="52" r="3"/><circle cx="135" cy="32" r="3"/></g><circle cx="184" cy="32" r="6" stroke="currentColor"/></svg>
      <button type="button" data-close aria-label="关闭知衡工作台">${icon('close', { size: 17 })}</button></div>
    <nav class="logic-tabs" role="tablist" aria-label="推演模式">
      <button role="tab" type="button" id="logic-tab-research" aria-selected="true" aria-controls="logic-page-research">${icon('learning', {size: 16})} 文献推理</button>
      <button role="tab" type="button" id="logic-tab-rules" aria-selected="false" aria-controls="logic-page-rules" tabindex="-1">${icon('inference', {size: 16})} 规则验算</button>
    </nav>
    <div class="modal-body" role="tabpanel" id="logic-page-research" aria-labelledby="logic-tab-research">${researchPanelHtml()}</div>
    <div class="modal-body" role="tabpanel" id="logic-page-rules" aria-labelledby="logic-tab-rules" hidden>
      <p class="logic-intro">选择示例比较求解算法。运行结果仅相对于示例中的事实与规则成立。</p>
      <fieldset class="logic-algorithms"><legend>求解算法</legend><div>${Object.entries(ALGORITHMS).map(([value, [name, summary]]) => `<label><input type="radio" name="logic-algorithm" value="${value}" ${value === 'naive' ? 'checked' : ''}><span><strong>${name}</strong><small>${summary}</small></span></label>`).join('')}</div></fieldset>
      ${onUseForChat ? '<div class="logic-chat-default"><button class="btn tiny" type="button" id="logic-use-chat">用于后续对话</button><span role="status"></span></div>' : ''}
      <fieldset class="choice-set logic-sample-group" id="logic-sample"><legend>选择示例</legend>
        <div class="choice-options">${SAMPLES.map((sample, index) => `<label class="choice-item"><input type="radio" name="logic-sample" value="${index}" ${index === 0 ? 'checked' : ''}><span class="choice-face"><span class="choice-number" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>${sample.name}</span></label>`).join('')}</div>
      </fieldset>
      <details class="logic-example-source"><summary>查看示例前提与规则</summary><pre><code id="logic-sample-source"></code></pre></details>
      <details class="logic-help"><summary>语法与推断边界</summary><p>声明以「。」结束；变量以 ? 开头。若 A 则 B 表示充分条件，只有 A 才 B 表示 B 推出 A，不能反向套用。非 A 是明确的否定；未知表示没有推导出任一侧；冲突表示正反两侧都有依据。</p><p>「除非」仅表示在本程序当前事实集合中未推出例外，不代表现实中不存在例外。工作台示例作为假设处理，不自动当作文献事实。</p></details>
      <div class="logic-toolbar"><button class="btn primary" id="logic-run">${icon('inference', { size: 16 })} 运行示例</button><button class="btn" id="logic-download" hidden>${icon('download', { size: 15 })} 下载完整证明</button><span id="logic-status" role="status" aria-live="polite"></span></div>
      <div id="logic-output"></div>
    </div></section>`;
  const source = mask.querySelector('#logic-sample-source');
  const status = mask.querySelector('#logic-status');
  const run = mask.querySelector('#logic-run');
  const output = mask.querySelector('#logic-output');
  const download = mask.querySelector('#logic-download');
  let controller = null;
  let result = null;
  let generation = 0;
  let selectedSample = 0;
  source.textContent = SAMPLES[selectedSample].program;
  const algorithms = mask.querySelector('.logic-algorithms');
  if (Object.hasOwn(ALGORITHMS, initialAlgorithm)) algorithms.querySelector(`[value="${initialAlgorithm}"]`).checked = true;
  const chatDefault = mask.querySelector('#logic-use-chat');
  if (chatDefault) chatDefault.addEventListener('click', async () => {
    const algorithm = algorithms.querySelector(':checked').value;
    const feedback = chatDefault.nextElementSibling;
    chatDefault.disabled = true;
    feedback.textContent = '正在保存…';
    try {
      if (await onUseForChat(algorithm) === false) throw new Error('偏好未保存，请重试。');
      feedback.textContent = `后续对话将使用${ALGORITHMS[algorithm][0]}`;
    } catch (error) {
      feedback.textContent = error.message || '偏好未保存，请重试。';
    } finally { chatDefault.disabled = false; }
  });
  const invalidate = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    result = null;
    output.replaceChildren();
    download.hidden = true;
    run.disabled = false;
    status.textContent = '示例已切换，请重新运行';
  };
  algorithms.addEventListener('change', () => {
    invalidate();
    status.textContent = '算法已切换，请重新运行';
  });
  mask.querySelector('#logic-sample').addEventListener('change', (event) => {
    if (event.target.name !== 'logic-sample' || !event.target.checked) return;
    selectedSample = Number(event.target.value);
    source.textContent = SAMPLES[selectedSample].program;
    invalidate();
  });
  const tabs = [...mask.querySelectorAll('[role=tab]')];
  const selectTab = tab => {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      mask.querySelector('#' + item.getAttribute('aria-controls')).hidden = !selected;
    }
    tab.focus();
    mask.dispatchEvent(new Event('workbench:panel'));
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let index = i;
      if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) index = 1 - i;
      else return;
      event.preventDefault();
      selectTab(tabs[index]);
    });
  });
  let disposeSequence;
  let closed = false;
  const close = showDialog(mask, { initialFocus: tabs[0], onClose: () => {
    closed = true;
    disposeSequence?.();
    generation += 1;
    controller?.abort();
  } });
  if (!prefersReducedMotion()) {
    import('/assets/vendor/workbench.js').then(({ createWorkbenchSequence }) => {
      if (!closed && mask.isConnected) disposeSequence = createWorkbenchSequence(mask);
    }).catch(() => {}); // The workbench is already fully functional before decoration loads.
  }
  bindResearchPanel(mask.querySelector('#logic-page-research'), { initialStrategy, modelLabel, onSelectStrategy, close });
  run.addEventListener('click', async () => {
    const version = ++generation;
    const program = SAMPLES[selectedSample].program;
    controller?.abort();
    const request = new AbortController();
    controller = request;
    result = null;
    run.disabled = true;
    download.hidden = true;
    output.replaceChildren();
    status.textContent = '正在推演…';
    try {
      const algorithm = algorithms.querySelector(':checked').value;
      const response = await (window.apiFetch || fetch)('/api/logic/evaluate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ program, algorithm }), signal: request.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(`${data.line ? `第 ${data.line} 行${data.column ? `第 ${data.column} 列` : ''}：` : ''}${data.message || data.error}`);
      if (!mask.isConnected || version !== generation || request.signal.aborted) return;
      result = { ...data, program };
      output.innerHTML = logicResultHtml(result);
      status.textContent = '推演完成';
      download.hidden = false;
    } catch (error) { if (error.name !== 'AbortError' && mask.isConnected && version === generation) { status.textContent = '推演未完成'; output.innerHTML = `<p class="logic-error">${escapeHtml(error.message)}</p>`; } }
    finally { if (version === generation) { run.disabled = false; if (controller === request) controller = null; } }
  });
  download.addEventListener('click', () => {
    downloadLogicResult(result);
  });
}
