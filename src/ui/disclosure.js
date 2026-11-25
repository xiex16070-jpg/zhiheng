import { escapeHtml } from '../agent/text.js';
import { icon } from './icons.js';

/** Native details provide keyboard interaction and keep disclosure state in the DOM. */
export function disclosureSummary(title, { symbol = 'layers', meta = '', className = '' } = {}) {
  return `<summary class="disclosure-summary ${escapeHtml(className)}"><span class="disclosure-symbol">${icon(symbol, { size: 16 })}</span><span class="disclosure-copy"><strong>${escapeHtml(title)}</strong>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</span><span class="disclosure-toggle"><span class="when-closed">展开</span><span class="when-open">收起</span>${icon('chevron-right', { size: 14 })}</span></summary>`;
}
