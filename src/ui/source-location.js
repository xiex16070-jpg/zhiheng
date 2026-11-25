/** Page numbers come only from extraction metadata; offsets never imply pages. */
export function sourceLocationLabel(source, highlight) {
  const start = highlight?.start, end = highlight?.end;
  const located = highlight?.locatable !== false && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= String(source.content || '').length;
  const pages = [...new Set((source.locations || []).filter(block =>
    Number.isInteger(block.page) && block.page > 0 &&
    (!located || (Number.isInteger(block.start) && Number.isInteger(block.end) && block.start < end && block.end > start))
  ).map(block => block.page))].sort((a, b) => a - b);
  const page = pages.length ? `原文件第 ${pages.slice(0, 12).join('、')} 页${pages.length > 12 ? '等' : ''}` : '未提供页码';
  return `${located ? `命中 · 字符 ${start}–${end}` : `${String(source.content || '').length} 字`} · ${page}`;
}
