import { icon } from './icons.js';
import { EXECUTION_PHASES, executionPhase, executionPhaseSummary, executionStepHtml } from './execution-visuals.js';

const states = { running:'进行中', ok:'完成', error:'失败', empty:'无结果', skipped:'跳过', paused:'等待确认', waiting:'等待确认', ended:'结束', returned:'已返回', cancelled:'已取消', tripped:'已停止', rejected:'已拒绝' };
const preview = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const stepKey = step => step.key || `${step.attempt || 1}:${step.detail?.callId || step.name}`;
const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

/** Stable nodes preserve open details, selections and progress while tokens stream. */
export function createTimeline({ root, summary, label = x => x }) {
  const rows = new Map(), groups = new Map(), progress = new Map();
  let round = 0, elapsed = 0, context;
  const overview = document.createElement('nav');
  overview.className = 'execution-overview'; overview.setAttribute('aria-label', '已发生的执行阶段');
  root.append(overview);
  const phases = new Map();
  const note = document.createElement('p'); note.className = 'execution-note execution-boundary';
  note.textContent = '根据实际调用与算法记录绘制；模型评估意见仍需回源核查。'; root.append(note);
  const meter=document.createElement('meter');meter.className='timeline-context';meter.min=0;meter.max=100;meter.hidden=true;meter.setAttribute('aria-label','估算上下文占用');summary.after(meter);
  const group = number => {
    if (!groups.has(number)) {
      const section = document.createElement('section'); section.className = 'timeline-round';
      const heading = document.createElement('h4'); heading.textContent = number ? `第 ${number} 轮 · 模型与工具` : '准备与核查';
      section.append(heading); root.append(section); groups.set(number, section);
    }
    return groups.get(number);
  };
  function paintSummary() {
    const values = [...rows.values()].map(row => row.step);
    const done = values.filter(s => !['running','paused','waiting'].includes(s.status)).length;
    const tools = values.filter(s => s.detail?.tool || /^tool[:#]/.test(s.name)).length;
    const failed = values.filter(s => ['error', 'tripped'].includes(s.status)).length;
    const paused = values.some(s => ['paused', 'waiting'].includes(s.status));
    const millis = elapsed || values.reduce((sum,s) => sum + (Number(s.ms) || 0), 0);
    summary.textContent = `${paused ? '等待确认 · ' : ''}${done}/${values.length} 步 · ${tools} 工具${failed ? ` · ${failed} 项异常` : ''} · ${(millis/1000).toFixed(1)}s`;
    const budget=context?.maxTokens || context?.budget;
    if (budget) {const pct=Math.min(100,Math.round(100*(context.tokens || context.estimatedTokens || 0)/budget));meter.hidden=false;meter.value=pct;meter.title=`估算上下文 ${pct}%`;summary.append(` · 上下文 ${pct}%`);}
    for (const phase of EXECUTION_PHASES) {
      const subset = values.filter(step => executionPhase(step) === phase.id);
      if (!subset.length) continue;
      let button = phases.get(phase.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.dataset.phase = phase.id;
        button.innerHTML = `${icon(phase.symbol, { size: 16 })}<strong>${phase.title}</strong><small></small>`;
        button.addEventListener('click', () => {
          const row = rows.get(button.dataset.targetStep);
          if (row) { row.element.open = true; row.element.scrollIntoView({ block: 'nearest', behavior: 'instant' }); row.element.querySelector('summary').focus({ preventScroll: true }); }
        });
        phases.set(phase.id, button);
        // The order reflects the first actual occurrence, not an invented plan.
        overview.append(button);
      }
      const { state, step } = executionPhaseSummary(subset);
      button.dataset.targetStep = stepKey(step);
      button.dataset.status = state;
      button.querySelector('small').textContent = `${states[state]} · ${subset.length}`;
    }
  }
  function upsert(step) {
    const key = stepKey(step);
    let row = rows.get(key);
    if (!row) {
      const element = document.createElement('details'); element.className = 'timeline-step'; element.dataset.stepKey = key;
      element.innerHTML = '<summary><span class="timeline-state"></span><strong></strong><span class="timeline-param"></span><span class="timeline-duration"></span><span class="timeline-chevron" aria-hidden="true">›</span></summary><div class="timeline-detail"><div class="timeline-visual"></div><details class="timeline-technical"><summary>技术记录</summary><pre class="timeline-args"></pre><pre class="timeline-result"></pre></details><div class="timeline-streams"></div><div class="timeline-approval"></div></div>';
      row = { element, step: {} }; rows.set(key,row);
      group(step.detail?.round ?? (/^reason#(\d+)$/.exec(step.name)?.[1] ? Number(step.name.split('#')[1]) : /^(?:reason#|tool[:#]|approval)/.test(step.name) ? round : 0)).append(element);
    }
    row.step = { ...row.step, ...step, detail:{...row.step.detail,...step.detail} };
    const s = row.step, detail = s.detail, el = row.element;
    const status = states[s.status] ? s.status : 'ended'; el.dataset.status = status;
    el.dataset.tool = detail.tool || s.name.replace(/^tool[#:]\d+[:#]?/, '');
    if (detail.callId) el.dataset.callId = detail.callId;
    const state = el.querySelector('.timeline-state'); state.innerHTML = icon(status === 'running' ? 'loader' : ['error','tripped','rejected','cancelled'].includes(status) ? 'warning' : ['paused','waiting'].includes(status) ? 'pause' : 'check',{size:14}); state.setAttribute('aria-label',states[status]);
    el.querySelector('strong').textContent = label(detail.tool || s.name);
    const args = detail.args || detail.arguments;
    const keyArg = args?.path || args?.query || args?.url || args?.command || detail.summary || '';
    el.querySelector('.timeline-param').textContent = preview(keyArg).slice(0,140);
    el.querySelector('.timeline-duration').textContent = s.ms == null ? states[status] : `${states[status]} · ${s.ms}ms`;
    setText(el.querySelector('.timeline-args'), args ? preview(args) : '');
    el.querySelector('.timeline-args').hidden = !args;
    const result = Object.fromEntries(Object.entries(detail).filter(([k])=>!['args','arguments','round','callId','tool'].includes(k)));
    setText(el.querySelector('.timeline-result'), Object.keys(result).length ? preview(result) : states[status]);
    const visual = executionStepHtml(s);
    if (row.visual !== visual) { el.querySelector('.timeline-visual').innerHTML = visual; row.visual = visual; }
    paintSummary(); return el;
  }
  return {
    round(value) { round = Number(value)||0; },
    upsert,
    replay(steps) { for(const step of steps) upsert(step); },
    finish(ms) { elapsed=Number(ms)||elapsed; paintSummary(); },
    context(value) { context=value; paintSummary(); },
    progress(event) {
      const id=event.sessionId || event.callId || `round-${round}`;
      let output=progress.get(id);
      if(!output) {
        output=document.createElement('pre'); output.className='tool-output'; output.dataset.streamId=id;
        const row=[...rows.values()].reverse().find(r=>(event.callId && r.step.detail?.callId===event.callId) || (event.sessionId && r.step.detail?.sessionId===event.sessionId));
        (row?.element.querySelector('.timeline-streams') || group(round)).append(output); progress.set(id,output);
      }
      output.textContent=(output.textContent+(event.delta || '')).slice(-32000);
    },
    approval(card, approval) {
      const match=[...rows.values()].reverse().find(r=>r.step.detail?.callId===approval.callId || r.element.dataset.tool===approval.action || r.step.status==='paused');
      if(match) { match.element.open=true; match.element.querySelector('.timeline-approval').append(card); }
      else { const el=upsert({name:`approval:${approval.id}`,status:'paused',detail:{tool:approval.action,summary:approval.reason}});el.open=true;el.querySelector('.timeline-approval').append(card); }
    },
  };
}
