export function parseNotebook(buffer) {
  if (buffer.length > 2 * 1024 * 1024) throw new Error('notebook_size');
  const document = JSON.parse(buffer.toString('utf8'));
  if (document?.nbformat !== 4 || !Array.isArray(document.cells) || document.cells.length > 500) throw new Error('notebook_format');
  for (const cell of document.cells) {
    if (!['code', 'markdown', 'raw'].includes(cell?.cell_type) || !(typeof cell.source === 'string' || (Array.isArray(cell.source) && cell.source.every(s => typeof s === 'string')))) throw new Error('notebook_cell');
  }
  return document;
}

export function extractNotebook(buffer) {
  const doc = parseNotebook(buffer);
  return { text: doc.cells.map((c, i) => `## Cell ${i + 1} [${c.cell_type}]\n${Array.isArray(c.source) ? c.source.join('') : c.source}`).join('\n\n'), kind: 'ipynb', pages: 0, parser: 'notebook-source', warnings: ['仅提取单元源代码与 Markdown；不执行代码，也不展示运行输出。'] };
}
