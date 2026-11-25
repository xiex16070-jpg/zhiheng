import path from 'node:path';
import { readOfficeZip, xmlText, xmlAttribute } from './office-zip.mjs';

const textRuns = xml => [...String(xml).matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => xmlText(m[1])).join('');

/** Values only. Formulas and macros are never evaluated; cached results are labelled. */
export function extractXlsx(buffer, options = {}) {
  const members = readOfficeZip(buffer, options);
  if (!members.has('xl/workbook.xml')) throw new Error('xlsx_workbook_missing');
  const workbook = members.get('xl/workbook.xml').toString('utf8');
  const relationships = members.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const rels = new Map([...relationships.matchAll(/<Relationship\s([^>]+)\/?\s*>/g)].filter(m => xmlAttribute(m[1], 'TargetMode') !== 'External').map(m => [xmlAttribute(m[1], 'Id'), xmlAttribute(m[1], 'Target')]));
  const shared = [...(members.get('xl/sharedStrings.xml')?.toString('utf8') || '').matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map(m => textRuns(m[1]));
  if (shared.length > 100000) throw new Error('xlsx_shared_string_budget');
  const sections = [], sourceMap = []; let chars = 0, formulas = 0, truncated = false;
  const sheets = [...workbook.matchAll(/<sheet\s([^>]+)\/?\s*>/g)];
  if (sheets.length > 64) throw new Error('xlsx_sheet_budget');
  for (const sheet of sheets) {
    options.signal?.throwIfAborted();
    const name = xmlAttribute(sheet[1], 'name') || '工作表';
    const target = rels.get(xmlAttribute(sheet[1], 'r:id'));
    if (!target || /(^[a-z]+:|\\)/i.test(target)) continue;
    const member = target.startsWith('/') ? target.slice(1) : path.posix.normalize('xl/' + target);
    if (!member.startsWith('xl/') || !members.has(member)) throw new Error('xlsx_sheet_relationship');
    const xml = members.get(member).toString('utf8'), lines = [`## ${name}`]; let rows = 0;
    for (const row of xml.matchAll(/<row(?:\s([^>]*))?>([\s\S]*?)<\/row>/g)) {
      if (++rows > 2000) { truncated = true; break; }
      const cells = [];
      for (const cell of row[2].matchAll(/<c(?:\s([^>]*))?>([\s\S]*?)<\/c>/g)) {
        if (cells.length >= 64) { truncated = true; break; }
        const type = xmlAttribute(cell[1] || '', 't'), address = xmlAttribute(cell[1] || '', 'r');
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(cell[2]);
        const formula = /<f(?:\s[^>]*)?>/.test(cell[2]); if (formula) formulas++;
        let value = type === 's' ? shared[Number(v?.[1])] || '' : type === 'inlineStr' ? textRuns(cell[2]) : type === 'b' ? v?.[1] === '1' ? 'TRUE' : 'FALSE' : xmlText(v?.[1] || '');
        if (formula) value = value ? value + '（公式缓存值）' : '（公式无缓存值）';
        cells.push(`${address || cells.length + 1}: ${value.replace(/[\r\n\t]+/g, ' ').slice(0, 4000)}`);
      }
      if (cells.length) lines.push(cells.join(' | '));
    }
    const text = lines.join('\n');
    if (chars + text.length > 2_000_000) { truncated = true; break; }
    const start = chars + (sections.length ? 2 : 0); sections.push(text); chars = start + text.length;
    sourceMap.push({ sheet: name, start, end: chars });
  }
  return { text: sections.join('\n\n'), kind: 'xlsx', pages: sheets.length, parser: 'bounded-ooxml', sourceMap, warnings: [...(formulas ? ['公式只读取缓存结果，可能不是最新值；未执行任何公式。'] : []), ...(truncated ? ['工作簿内容超过读取预算，已截断。'] : [])], truncated };
}
