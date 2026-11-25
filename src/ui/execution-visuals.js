import { escapeHtml as esc } from '../agent/text.js';
import { icon } from './icons.js';

export const EXECUTION_PHASES = Object.freeze([
  { id: 'context', title: '准备', symbol: 'layers' },
  { id: 'retrieval', title: '取证', symbol: 'search' },
  { id: 'reasoning', title: '求解', symbol: 'branch' },
  { id: 'action', title: '行动', symbol: 'terminal' },
  { id: 'review', title: '核查', symbol: 'shield' },
  { id: 'delivery', title: '交付', symbol: 'document' },
]);
const complete = new Set(['ok', 'empty', 'skipped', 'ended', 'returned']);
const failed = new Set(['error', 'tripped', 'cancelled', 'rejected']);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const metric = (title, value) => `<div><strong>${esc(String(value))}</strong><span>${esc(title)}</span></div>`;

export function executionPhase(step) {
  const name = step.detail?.tool || step.name || '';
  if (/^(?:verify|inference_audit|support_check|verify_quote|answer_contract_repair)$/.test(name)) return 'review';
  if (/^(?:research_|reason#|logic_|propose_logic_program)/.test(name)) return 'reasoning';
  if (/^(?:retrieve|selected_source|authority_retrieve|evidence_mix|search_knowledge|read_source|web_search|web_fetch|scholar_search)/.test(name)) return 'retrieval';
  if (/^(?:intake|compact|local_context_compact|trace)$/.test(name)) return 'context';
  if (/^(?:finalize|persist)$/.test(name)) return 'delivery';
  return 'action';
}

/** Keep the navigation destination and the phase label tied to the same recorded event. */
export function executionPhaseSummary(steps) {
  const waiting = steps.find(step => ['waiting', 'paused'].includes(step.status));
  if (waiting) return { state: 'paused', step: waiting };
  const running = steps.find(step => step.status === 'running');
  if (running) return { state: 'running', step: running };
  const error = steps.find(step => failed.has(step.status));
  if (error) return { state: 'error', step: error };
  return { state: steps.every(step => complete.has(step.status)) ? 'ok' : 'ended', step: steps[0] };
}

const channelNames = { paper: '公共文献', doc: '导入文档', lexical: '词法', vector: '向量', authority: '权威来源', ragflow: 'RAGFlow' };
export const STRATEGY_STOPS = Object.freeze({ complete: '已完成本轮策略', budget: '辅助调用预算已用完', hop_limit: '到达追检轮次上限', invalid_plan: '检索方案无效，保留已有证据', repeated_query: '检索词重复，停止追检', no_evidence: '没有取得可用补充证据', no_new_evidence: '没有取得新证据', model_unavailable: '规划服务未完成', search_unavailable: '追加检索未完成' });

/** Only measured tool/algorithm metadata is shown. No generated private reasoning text. */
export function executionStepHtml(step) {
  const d = step.detail || {}, metrics = [];
  for (const [key, title] of [['hits', '命中'], ['searches', '追加检索'], ['hops', '深度'], ['evaluated', '比较分支'], ['modelCalls', '辅助调用'], ['citations', '引用'], ['unverified', '未知引用'], ['count', '核对项']]) {
    if (key === 'evaluated' && step.name === 'research_ircot') continue;
    if (number(d[key])) metrics.push(metric(title, d[key]));
  }
  if (number(d.preTokens) && number(d.postTokens)) metrics.push(metric('上下文 token', `${d.preTokens} → ${d.postTokens}`));
  if (d.counts && number(d.counts.local) && number(d.counts.external)) metrics.push(metric('本地证据', d.counts.local), metric('外部证据', d.counts.external));
  let html = metrics.length ? `<div class="execution-metrics">${metrics.join('')}</div>` : '';
  const channels = Array.isArray(d.channels) ? d.channels.filter(channel => number(channel.hits)).slice(0, 12) : [];
  if (channels.length) {
    const max = Math.max(1, ...channels.map(channel => channel.hits));
    html += `<div class="execution-channels" aria-label="各检索通道实际命中数">${channels.map(channel => `<div><span>${esc(channelNames[channel.name] || channel.name || '检索通道')}</span><meter min="0" max="${max}" value="${channel.hits}" aria-label="${esc(channelNames[channel.name] || channel.name || '检索通道')}命中数"></meter><b>${channel.hits}</b></div>`).join('')}</div>`;
  }
  const process = Array.isArray(d.process) ? d.process.slice(0, 8) : [];
  if (process.length) {
    const selected = Array.isArray(d.selected) ? d.selected : [];
    html += `<ol class="execution-paths" aria-label="实际检索路径">${process.map(path => {
      const retained = selected.includes(path.id) || path.retained === true;
      return `<li class="execution-path" data-depth="${Number(path.depth) || 1}" data-selected="${retained}"><span class="execution-path-marker">${icon(retained ? 'check' : 'search', { size: 14 })}</span><div><strong>${path.parent ? `路径 ${esc(String(path.parent))} → ${esc(String(path.id))}` : `路径 ${esc(String(path.id))}`}</strong><span>第 ${Number(path.depth) || 1} 层 · ${number(path.hits) ? `命中 ${path.hits} 条` : '检索未完成'}${number(path.novel) ? ` · 新增 ${path.novel} 条` : ''}${number(path.score) ? ` · 相关性 ${path.score.toFixed(2)}` : ''}${retained ? ' · 已选用' : ''}</span></div></li>`;
    }).join('')}</ol>`;
    if (step.name === 'research_tot') html += '<p class="execution-note">分支得分只衡量检索相关性，不表示结论正确的概率。</p>';
  } else if (step.name === 'research_ircot' || step.name === 'research_tot') {
    html += '<p class="execution-note">本次记录没有逐路径数据，仅展示已记录的统计。</p>';
  }
  if (/^reason#/.test(step.name)) {
    const tools = Array.isArray(d.tools) ? d.tools : [];
    html += `<div class="execution-cycle" aria-label="本轮模型与工具流程"><span>${icon('chip', { size: 15 })} 模型调用</span><i aria-hidden="true">→</i><span>${tools.length ? `${icon('terminal', { size: 15 })} 请求 ${tools.length} 项工具` : step.status === 'running' ? '等待实际结果' : `${icon('document', { size: 15 })} 返回文本`}</span></div>`;
  }
  const message = d.summary || d.message || d.reason;
  if (typeof message === 'string' && message) html += `<p class="execution-outcome">${esc(message)}</p>`;
  if (typeof d.weak === 'boolean') html += `<p class="execution-note">${d.weak ? '检索证据较弱，回答仍需核查。' : '检索已返回候选证据，仍需核查其支持关系。'}</p>`;
  if (d.stop && Object.hasOwn(STRATEGY_STOPS, d.stop)) html += `<p class="execution-note">${esc(STRATEGY_STOPS[d.stop])}</p>`;
  return html || '<p class="execution-note">展开技术记录可查看本步骤已公开的参数与状态。</p>';
}
