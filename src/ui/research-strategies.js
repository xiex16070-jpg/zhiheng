import { icon } from './icons.js';

const methods = [
  { id: 'react', name: '工具核查', short: 'ReAct', icon: 'search',
    description: '随工具结果决定下一步，适合找出处、核对引文。',
    paper: 'https://react-lm.github.io/' },
  { id: 'ircot', name: '逐步追检', short: 'IRCoT', icon: 'layers',
    description: '用已找到的证据确定下一个检索问题，适合多步论证。',
    paper: 'https://aclanthology.org/2023.acl-long.557/' },
  { id: 'tot', name: '分支比较', short: 'ToT', icon: 'inference',
    description: '列出备选解释或证明路径，再按证据比较。',
    paper: 'https://proceedings.neurips.cc/paper/2023/hash/271db9922b8d1f4dd7aaef84ed5ac703-Abstract.html' },
];

export function researchPanelHtml() {
  return `<form class="research-form">
    <fieldset class="research-methods"><legend><span class="logic-folio">01</span> 选择推理方法</legend>
      <div class="research-method-grid">${methods.map((m,i) => `<label class="research-method"><input type="radio" name="research-method" value="${m.id}" ${i === 0 ? 'checked' : ''}>
        <span class="method-content"><span class="method-sigil">${icon(m.icon, { size: 19 })}<span>${m.short}</span></span><strong>${m.name}</strong><small>${m.description}</small></span></label>`).join('')}</div>
    </fieldset>
    <p class="research-context">选择方法后，在对话底部的主输入框提问。</p>
    <div class="research-actions"><span class="research-model"></span><button type="submit" class="btn primary">用于当前提问 ${icon('chevron-right', { size: 15 })}</button></div>
    <p class="research-feedback" role="status"></p>
    <details class="logic-help research-reading"><summary>方法与文献</summary>
      <p>工作台在当前知识库范围内组织检索和工具调用，完成的回答和引用会进入当前对话。</p>
      <p class="research-links">${methods.map(m => `<a href="${m.paper}" target="_blank" rel="noopener noreferrer">${m.short} 原文 ↗</a>`).join('')}</p>
      <p>GraphRAG 的局部与全局检索依赖实体关系图或社区报告。这里沿用项目已有的文献索引。<a href="https://microsoft.github.io/graphrag/query/overview/" target="_blank" rel="noopener noreferrer">GraphRAG 文档 ↗</a></p>
    </details></form>`;
}

export function bindResearchPanel(panel, { initialStrategy, modelLabel, onSelectStrategy, close }) {
  const form = panel.querySelector('form');
  const start = form.querySelector('[type=submit]');
  const feedback = form.querySelector('.research-feedback');
  const active = () => methods.find(method => method.id === form.elements['research-method'].value);
  const saved = methods.find(method => method.id === initialStrategy);
  if (saved) form.elements['research-method'].value = saved.id;
  form.querySelector('.research-model').textContent = modelLabel ? `当前模型 · ${modelLabel}` : '可在设置中配置对话模型';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (start.disabled) return;
    if (!onSelectStrategy) { feedback.textContent = '请从对话页面选择推理方法。'; return; }
    start.disabled = true;
    feedback.textContent = '正在应用方法…';
    try {
      const accepted = await onSelectStrategy(active().id);
      if (accepted === false) throw new Error('当前方法未能保存，请重试。');
      close();
    } catch (error) {
      feedback.textContent = error.message || '未能开始推理，请重试。';
    } finally { start.disabled = false; }
  });
}
