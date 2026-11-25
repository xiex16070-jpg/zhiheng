/** Office writers use official OOXML libraries. User data never becomes formulas or code. */
export async function renderXlsx({ markdown, rows, title, references, signal }) {
  const { default: ExcelJS } = await import('exceljs');
  let tables;
  if (rows !== undefined) tables = [{ name: title || '研究数据', rows }];
  else {
    const { Lexer } = await import('marked');
    let heading = title || '研究数据'; tables = [];
    for (const t of Lexer.lex(markdown, { gfm: true })) {
      if (t.type === 'heading') heading = t.text;
      if (t.type === 'table') tables.push({ name: heading, rows: [t.header.map(c => c.text), ...t.rows.map(row => row.map(c => c.text))] });
    }
    if (!tables.length) throw new Error('XLSX 需要 Markdown 表格或 rows 二维数组。');
  }
  if (references?.length) tables.push({ name: '参考来源', rows: [['编号', '来源', '链接', '证据范围'], ...references] });
  if (tables.length > 16) throw new Error('工作簿最多 16 张工作表。');
  const book = new ExcelJS.Workbook(); book.creator = '知衡'; book.title = title || '研究数据';
  const used = new Set();
  for (const table of tables) {
    signal?.throwIfAborted();
    if (!Array.isArray(table.rows) || !table.rows.length || table.rows.length > 2001 || table.rows.some(r => !Array.isArray(r) || !r.length || r.length > 32)) throw new Error('每张表最多 2000 条数据、32 列，首行作为表头。');
    let base = String(table.name).replace(/[\\/*?:\[\]]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 25) || '研究数据';
    let name = base, suffix = 1; while (used.has(name.toLowerCase())) name = base + ' ' + ++suffix; used.add(name.toLowerCase());
    const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }], properties: { defaultRowHeight: 24 } });
    let totalChars = 0;
    for (const row of table.rows) {
      const values = row.map(v => {
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new Error('单元格只接受文本、数字、布尔值或 null；禁止公式对象。');
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('单元格数字必须有限。');
        if (typeof v === 'string') { totalChars += v.length; if (v.length > 16000 || totalChars > 2_000_000) throw new Error('工作表文本超过预算。'); }
        // ExcelJS stores strings as strings even if they begin with =,+,-,@. No formula property is accepted.
        return v;
      });
      const excelRow = sheet.addRow(values);
      excelRow.eachCell(cell => { cell.font = { name: 'Microsoft YaHei', size: 11, color: { argb: 'FF263E3B' } }; cell.alignment = { vertical: 'middle', wrapText: true }; });
    }
    const columns = Math.max(...table.rows.map(r => r.length));
    for (let i = 1; i <= columns; i++) sheet.getColumn(i).width = Math.min(48, Math.max(16, ...table.rows.slice(0, 80).map(r => Math.min(48, String(r[i - 1] ?? '').length * 1.4 + 4))));
    sheet.getRow(1).height = 30; sheet.getRow(1).eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF315B55' } }; cell.font = { name: 'Microsoft YaHei', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; });
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: columns } };
    sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:1' };
  }
  const data = await book.xlsx.writeBuffer(); signal?.throwIfAborted(); return Buffer.from(data);
}

function plain(tokens) { return (tokens || []).map(t => t.type === 'image' ? '' : t.tokens ? plain(t.tokens) : t.text || '').join(''); }

export async function renderPptx(document, signal) {
  const { default: PptxGenJS } = await import('pptxgenjs');
  const deck = new PptxGenJS(); deck.layout = 'LAYOUT_WIDE'; deck.author = '知衡'; deck.subject = '文献研究'; deck.title = document.title || '研究简报'; deck.lang = 'zh-CN';
  deck.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei', lang: 'zh-CN' };
  let count = 0, heading = document.title || '研究简报', slide, y;
  function next(title, cover = false) {
    signal?.throwIfAborted(); if (++count > 60) throw new Error('演示文稿最多 60 页，请精简正文。');
    slide = deck.addSlide(); slide.background = { color: cover ? '24433F' : 'F8F7F2' };
    slide.addShape(deck.ShapeType.rect, { x: 0.5, y: 0.58, w: 0.07, h: cover ? 4.9 : 0.55, fill: { color: 'B69B62' }, line: { transparency: 100 } });
    slide.addText(cover ? '知衡 / RESEARCH NOTES' : '知衡 · 文献研究', { x: 0.85, y: cover ? 1.0 : 0.35, w: 10.9, h: 0.3, fontSize: 11, charSpacing: 2, color: cover ? 'D2BE8B' : '6D7D76', margin: 0 });
    slide.addText(title, { x: 0.85, y: cover ? 2.0 : 0.95, w: 11.5, h: cover ? 2.1 : 0.9, fontSize: cover ? 36 : 25, bold: true, color: cover ? 'FFFFFF' : '24433F', margin: 0, breakLine: false, fit: 'shrink' });
    slide.addShape(deck.ShapeType.line, { x: 0.85, y: 6.85, w: 11.65, h: 0, line: { color: cover ? '54746C' : 'D6DDD6', width: 0.6 } });
    slide.addText(String(count).padStart(2, '0'), { x: 11.7, y: 6.98, w: 0.8, h: 0.25, fontSize: 10, align: 'right', color: cover ? 'D2BE8B' : '6D7D76', margin: 0 });
    y = 2.05; return slide;
  }
  if (document.title) next(document.title, true);
  function textBlock(value, code = false) {
    const chunks = String(value).match(/[\s\S]{1,360}/g) || [];
    for (const text of chunks) {
      // One bounded block per page keeps Chinese paragraphs legible without tiny overflow text.
      next(heading);
      slide.addText(text, { x: 0.92, y, w: 11.5, h: 4.25, fontSize: code ? 17 : 22, color: '263E3B', margin: 0, valign: 'top', breakLine: false, lineSpacingMultiple: 1.2, fontFace: code ? 'Consolas' : 'Microsoft YaHei', fit: 'shrink' });
    }
  }
  for (const token of document.tokens) {
    signal?.throwIfAborted();
    if (token.type === 'heading') { heading = plain(token.tokens) || token.text; continue; }
    if (token.type === 'space' || token.type === 'hr') continue;
    if (token.type === 'table') {
      // Small bounded page groups preserve the repeated header and avoid uncontrolled auto-pagination.
      for (let offset = 0; offset < Math.max(1, token.rows.length); offset += 5) {
        next(heading);
        const rows = [token.header, ...token.rows.slice(offset, offset + 5)].map((r, i) => r.map(c => ({ text: plain(c.tokens) || c.text, options: { bold: i === 0, color: i === 0 ? 'FFFFFF' : '263E3B', fill: i === 0 ? '315B55' : i % 2 ? 'FFFFFF' : 'EDF2EE' } })));
        const cellBudget = Math.min(80, Math.floor(96 / token.header.length));
        if (rows.some(r => r.some(c => c.text.length > cellBudget))) throw new Error(`当前 ${token.header.length} 列幻灯片表格每格最多 ${cellBudget} 字，请先汇总长文本或改用 PDF。`);
        slide.addTable(rows, { x: 0.85, y, w: 11.65, h: 4.3, fontSize: 15, margin: 0.12, border: { type: 'solid', pt: 0.5, color: 'D6DDD6' }, autoPage: false, valign: 'mid' });
      }
      continue;
    }
    if (token.type === 'list') textBlock(token.items.map((item, i) => `${i + 1}. ${plain(item.tokens)}`).join('\n\n'));
    else if (token.type === 'blockquote') textBlock(plain(token.tokens));
    else textBlock(token.type === 'code' ? token.text : plain(token.tokens || [{ text: token.text }]), token.type === 'code');
    for (const image of (token.tokens || []).filter(t => t.type === 'image')) {
      const asset = document.assets.get(image.href); if (!asset) continue;
      next(image.text || heading);
      const width = Math.min(11.5, 4.3 * asset.width / asset.height), height = width * asset.height / asset.width;
      slide.addImage({ data: `data:image/${asset.type === 'jpg' ? 'jpeg' : 'png'};base64,${asset.data.toString('base64')}`, x: (13.333 - width) / 2, y: 2.05 + (4.3 - height) / 2, w: width, h: height });
    }
  }
  if (!count) next(heading);
  const data = await deck.write({ outputType: 'nodebuffer', compression: true }); signal?.throwIfAborted(); return Buffer.from(data);
}
