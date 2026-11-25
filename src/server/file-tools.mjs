import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveSafe, writeArtifact } from './workspace.mjs';
import { parseNotebook } from './extract/ipynb.mjs';
import { readOfficeZip } from './extract/office-zip.mjs';
import { threatScan } from './memory.mjs';

const LIMIT = 25 * 1024 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const filePath = { type: 'string', minLength: 1, maxLength: 240 };
const schema = (name, description, properties, required) => ({ type: 'function', function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } });
export const FILE_CAPABILITY_SCHEMAS = [
  schema('pdf_inspect', '读取工作区 PDF 页数与真实 AcroForm 字段定义。填写前必须先检查字段名称/类型；不执行 PDF 中的脚本。', { path: filePath }, ['path']),
  schema('pdf_fill', '填写已存在的 PDF AcroForm 字段并另存新 PDF，不修改原件。中文等非西欧文字需要工作区 TTF/OTF font_path。不支持重写普通 PDF 正文。', { path: filePath, output_path: filePath, fields: { type: 'object', minProperties: 1, maxProperties: 100, additionalProperties: { anyOf: [{ type: 'string', maxLength: 8000 }, { type: 'boolean' }, { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 1000 } }] } }, font_path: filePath, flatten: { type: 'boolean' } }, ['path', 'output_path', 'fields']),
  schema('pdf_split', '将选定页另存一个新 PDF。pages 使用从 1 开始的页码，按指定顺序输出，不修改原件。', { path: filePath, output_path: filePath, pages: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'integer', minimum: 1 } } }, ['path', 'output_path', 'pages']),
  schema('pdf_merge', '依次合并当前工作区内的 PDF 到新文件，最多 12 个、合计 25 MiB、最多 500 页。保留页面，交互式表单应先填好并展平。', { paths: { type: 'array', minItems: 2, maxItems: 12, items: filePath }, output_path: filePath }, ['paths', 'output_path']),
  schema('notebook_read', '只读 Jupyter .ipynb 单元源代码和元数据摘要。绝不执行单元，也不加载输出 HTML/图片。', { path: filePath, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, ['path']),
  schema('notebook_edit', '将指定 Notebook 单元的源代码替换后另存新文件；必须提供 notebook_read 返回的 revision 防止覆盖并发修改。不执行代码，清空全部旧输出和执行计数，去掉信任状态。cell_index 从 0 开始。', { path: filePath, output_path: filePath, revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, cell_index: { type: 'integer', minimum: 0, maximum: 499 }, source: { type: 'string', maxLength: 100000 }, cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'] } }, ['path', 'output_path', 'revision', 'cell_index', 'source']),
  schema('artifact_scan', '本地静态检查产物的脚本、疑似凭据和外部链接。只报告类别，不回显密钥，不上传文件；扫描无命中不代表绝对安全。', { path: filePath }, ['path']),
  schema('latex_compile', '审批后用本机已配置的 Tectonic 离线编译自包含 LaTeX 安全子集。禁用 shell-escape、动态命令与文件引入，不联网拉包。依赖未配置时返回 unavailable；普通报告可改用 create_document PDF。', { source_path: filePath, output_path: filePath }, ['source_path', 'output_path']),
];

export async function readWorkspaceBinary(userId, relative, { signal, maxBytes = LIMIT } = {}) {
  signal?.throwIfAborted();
  const target = resolveSafe(userId, relative);
  if (target.error) throw new Error(`workspace_${target.error}`);
  const handle = await fs.open(target.abs, READ_FLAGS);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > maxBytes) throw new Error('file_size_or_type');
    const size = Number(stat.size);
    const allocation = Buffer.alloc(size + 1); let offset = 0;
    while (offset < allocation.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(allocation, offset, Math.min(65536, allocation.length - offset), offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset !== size) throw new Error('workspace_file_changed');
    const fresh = resolveSafe(userId, relative);
    if (fresh.error || fresh.abs !== target.abs) throw new Error('workspace_file_changed');
    // Windows Node 22.12 reports different device IDs for a path stat and an
    // open handle. Compare two opened handles so the volume and full inode still count.
    const namedHandle = await fs.open(fresh.abs, READ_FLAGS);
    try {
      const current = await namedHandle.stat({ bigint: true });
      if (!current.isFile() || current.nlink !== 1n || current.dev !== stat.dev || current.ino !== stat.ino ||
          current.size !== stat.size || current.mtimeNs !== stat.mtimeNs || resolveSafe(userId, relative).abs !== fresh.abs) {
        throw new Error('workspace_file_changed');
      }
    } finally { await namedHandle.close(); }
    signal?.throwIfAborted();
    return allocation.subarray(0, offset);
  } finally { await handle.close(); }
}

async function pdfLibrary() {
  if (process.env.PDF_TOOLS === '0') throw new Error('PDF_TOOLS=0：PDF 编辑能力已关闭。');
  return import('pdf-lib');
}

async function loadPdf(userId, name, ctx, budget = LIMIT) {
  if (!/\.pdf$/i.test(name)) throw new Error('需要工作区内 .pdf 文件。');
  const data = await readWorkspaceBinary(userId, name, { signal: ctx.signal, maxBytes: budget });
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('不是有效 PDF 文件。');
  const { PDFDocument } = await pdfLibrary();
  const document = await PDFDocument.load(data, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false });
  ctx.signal?.throwIfAborted();
  if (document.getPageCount() > 500 || document.context.enumerateIndirectObjects().length > 50000) throw new Error('PDF 超过 500 页或对象预算。');
  return { document, bytes: data.length };
}

function outputPath(args, sources, extension) {
  const output = String(args.output_path || '');
  if (!output.toLowerCase().endsWith(extension) || sources.some(p => p.replace(/\\/g, '/').toLowerCase() === output.replace(/\\/g, '/').toLowerCase())) throw new Error('请提供不同于原件的新输出文件名，扩展名 ' + extension);
  return output;
}

async function saveFile(userId, output, bytes, ctx) {
  ctx.signal?.throwIfAborted();
  if (ctx.fileWorkspaceRoot && resolveSafe(userId, output).root !== ctx.fileWorkspaceRoot) throw new Error('workspace_changed');
  const result = await writeArtifact(userId, output, Buffer.from(bytes), { signal: ctx.signal });
  if (!result.ok) return result;
  const scan = await scanArtifact(userId, output, ctx);
  return { ...result, scan, artifact: { kind: 'file', action: 'write', path: result.path, bytes: result.bytes, format: path.extname(output).slice(1), scan } };
}

function fieldInfo(field) {
  return { name: field.getName(), type: field.constructor.name, readOnly: field.isReadOnly(), ...(typeof field.getOptions === 'function' ? { options: field.getOptions() } : {}), ...(typeof field.getText === 'function' ? { value: field.getText() || '', maxLength: field.getMaxLength() ?? null } : {}), ...(typeof field.isChecked === 'function' ? { value: field.isChecked() } : {}), ...(typeof field.getSelected === 'function' ? { value: field.getSelected() } : {}) };
}

async function pdfAction(name, args, ctx) {
  const d = await pdfLibrary();
  if (name === 'pdf_merge') {
    if (!Array.isArray(args.paths) || args.paths.length < 2 || args.paths.length > 12) throw new Error('合并需要 2–12 个 PDF。');
    const output = outputPath(args, args.paths, '.pdf'), merged = await d.PDFDocument.create(); let bytes = 0;
    for (const filename of args.paths) {
      const input = await loadPdf(ctx.userId, filename, ctx, LIMIT - bytes); bytes += input.bytes;
      if (merged.getPageCount() + input.document.getPageCount() > 500) throw new Error('合并结果超过 500 页。');
      if (input.document.getForm().getFields().length) throw new Error('合并含表单的 PDF 前请先 pdf_fill flatten=true，避免丢失交互字段。');
      for (const page of await merged.copyPages(input.document, input.document.getPageIndices())) merged.addPage(page);
      ctx.signal?.throwIfAborted();
    }
    return { ...await saveFile(ctx.userId, output, await merged.save(), ctx), pages: merged.getPageCount() };
  }
  const { document } = await loadPdf(ctx.userId, args.path, ctx);
  if (name === 'pdf_inspect') {
    const fields = document.getForm().getFields(); if (fields.length > 1000) throw new Error('PDF 表单字段超过预算。');
    return { ok: true, pages: document.getPageCount(), fields: fields.slice(0, 100).map(fieldInfo), truncated: fields.length > 100 };
  }
  const output = outputPath(args, [args.path], '.pdf');
  if (name === 'pdf_split') {
    if (!Array.isArray(args.pages) || !args.pages.length || args.pages.length > 500 || args.pages.some(n => !Number.isInteger(n) || n < 1 || n > document.getPageCount())) throw new Error('pages 必须是有效的从 1 开始的页码数组。');
    if (document.getForm().getFields().length) throw new Error('拆分含表单的 PDF 前请先 pdf_fill flatten=true。');
    const split = await d.PDFDocument.create();
    for (const page of await split.copyPages(document, args.pages.map(n => n - 1))) split.addPage(page);
    return { ...await saveFile(ctx.userId, output, await split.save(), ctx), pages: split.getPageCount() };
  }
  const form = document.getForm(), values = args.fields;
  if (!values || Array.isArray(values) || typeof values !== 'object' || !Object.keys(values).length || Object.keys(values).length > 100) throw new Error('fields 应是字段名到值的对象，最多 100 项。');
  let font;
  if (args.font_path) {
    if (!/\.(ttf|otf)$/i.test(args.font_path)) throw new Error('字体需要工作区内的 .ttf/.otf。');
    const fontBytes = await readWorkspaceBinary(ctx.userId, args.font_path, { signal: ctx.signal, maxBytes: 10 * 1024 * 1024 });
    const { default: fontkit } = await import('@pdf-lib/fontkit'); document.registerFontkit(fontkit); font = await document.embedFont(fontBytes, { subset: true });
  } else font = await document.embedFont(d.StandardFonts.Helvetica);
  for (const [key, value] of Object.entries(values)) {
    const field = form.getField(key);
    if (field.isReadOnly()) throw new Error('不能修改只读字段：' + key.slice(0, 100));
    if (field instanceof d.PDFCheckBox && typeof value === 'boolean') value ? field.check() : field.uncheck();
    else if (field instanceof d.PDFTextField && typeof value === 'string' && value.length <= 8000) field.setText(value);
    else if ((field instanceof d.PDFDropdown || field instanceof d.PDFOptionList || field instanceof d.PDFRadioGroup) && (typeof value === 'string' || Array.isArray(value))) {
      const requested = Array.isArray(value) ? value : [value];
      if (requested.length > 30 || requested.some(v => typeof v !== 'string' || !field.getOptions().includes(v)) || (field instanceof d.PDFRadioGroup && requested.length !== 1)) throw new Error('选项值不在字段允许范围内：' + key.slice(0, 100));
      field.select(field instanceof d.PDFRadioGroup ? requested[0] : value);
    } else throw new Error('字段类型或值不支持：' + key.slice(0, 100));
  }
  try { form.updateFieldAppearances(font); }
  catch (error) { if (!args.font_path && /encode|WinAnsi/.test(error.message)) throw new Error('字段文字需要自定义字体，请传入覆盖这些字符的工作区 TTF/OTF font_path。'); throw error; }
  if (args.flatten === true) form.flatten();
  return { ...await saveFile(ctx.userId, output, await document.save(), ctx), fieldsUpdated: Object.keys(values).length, flattened: args.flatten === true };
}

export function scanArtifactText(text) {
  const findings = [];
  if (threatScan(text)) findings.push({ code: 'instruction_like_content', severity: 'warning', message: '包含可能被误用为指令的文本，请人工核对。' });
  if (/<script\b|\bon(?:error|load|click)\s*=|javascript:|\beval\s*\(|\bnew\s+Function\s*\(/i.test(text)) findings.push({ code: 'active_script', severity: 'warning', message: '包含脚本或动态执行语句。' });
  if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-|tvly-)[A-Za-z0-9_-]{16,}|\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?[A-Za-z0-9_./+-]{12,}/i.test(text)) findings.push({ code: 'possible_credential', severity: 'warning', message: '检测到疑似凭据样式；分享前请检查并脱敏。' });
  if (/\b(?:fetch|sendBeacon|XMLHttpRequest)\s*\(|<form\b[^>]*action\s*=|\b(?:curl|wget)\s+.*https?:/i.test(text)) findings.push({ code: 'network_action', severity: 'warning', message: '包含可向外部发送数据的网络操作。' });
  return findings;
}

export async function scanArtifact(userId, filename, ctx = {}) {
  try {
    const bytes = await readWorkspaceBinary(userId, filename, { signal: ctx.signal });
    const ext = path.extname(filename).toLowerCase(); let findings = [], inspection = 'text';
    if (['.xlsx', '.docx', '.pptx'].includes(ext)) {
      const members = readOfficeZip(bytes, { signal: ctx.signal }); inspection = 'office-structure';
      for (const [name, value] of members) {
        if (/vbaProject\.bin|embeddings\//i.test(name)) findings.push({ code: 'embedded_code_or_object', severity: 'warning', message: 'Office 文档包含宏或嵌入对象。' });
        if (/\.(xml|rels)$/.test(name)) {
          const text = value.toString('utf8'); findings.push(...scanArtifactText(text));
          if (/TargetMode=["']External["']/i.test(text)) findings.push({ code: 'external_reference', severity: 'info', message: '文档包含外部引用或超链接，请核对目标。' });
          if (ext === '.xlsx' && /<f(?:\s[^>]*)?>/.test(text)) findings.push({ code: 'spreadsheet_formula', severity: 'warning', message: '工作簿包含公式；本系统不计算或核实公式结果。' });
        }
      }
    } else if (ext === '.pdf') {
      inspection = 'pdf-structure';
      const { PDFDocument } = await import('pdf-lib'); const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      const objects = pdf.context.enumerateIndirectObjects(); if (objects.length > 50000) throw new Error('pdf_object_budget');
      for (const [, object] of objects) if (/\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia)\b/.test(object.toString().slice(0, 65536))) { findings.push({ code: 'pdf_active_content', severity: 'warning', message: 'PDF 包含脚本动作或嵌入内容。' }); break; }
    } else if (/\.(txt|md|markdown|html?|json|csv|tsv|js|mjs|css|py|tex|ipynb|svg|ya?ml)$/i.test(ext)) findings = scanArtifactText(bytes.toString('utf8'));
    else return { status: 'unsupported', inspection: 'none', findings: [], message: '未支持该格式的静态扫描。' };
    findings = [...new Map(findings.map(f => [f.code, f])).values()];
    const result = { status: findings.some(f => f.severity === 'warning') ? 'warning' : 'checked', inspection, findings, bytes: bytes.length, message: '启发式静态扫描，不代表完整安全证明。' };
    if (findings.length && typeof ctx.audit === 'function') await ctx.audit({ action: 'artifact_scan', userId, path: filename, codes: findings.map(f => f.code) });
    return result;
  } catch (error) { ctx.signal?.throwIfAborted(); return { status: 'incomplete', inspection: 'none', findings: [], message: '扫描未完成：' + String(error.message).slice(0, 160) }; }
}

async function notebookAction(name, args, ctx) {
  if (!/\.ipynb$/i.test(args.path)) throw new Error('需要 .ipynb 工作区文件。');
  const bytes = await readWorkspaceBinary(ctx.userId, args.path, { signal: ctx.signal, maxBytes: 2 * 1024 * 1024 });
  const notebook = parseNotebook(bytes), revision = crypto.createHash('sha256').update(bytes).digest('hex');
  if (name === 'notebook_read') {
    const offset = Math.max(0, Number(args.offset) || 0), limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
    return { ok: true, revision, totalCells: notebook.cells.length, cells: notebook.cells.slice(offset, offset + limit).map((cell, i) => { const source = Array.isArray(cell.source) ? cell.source.join('') : cell.source; return { cell_index: offset + i, cell_type: cell.cell_type, source: source.slice(0, 10000), truncated: source.length > 10000 }; }), executed: false };
  }
  if (args.revision !== revision) throw new Error('notebook_revision_changed：请重新读取文件后再编辑。');
  if (!Number.isInteger(args.cell_index) || !notebook.cells[args.cell_index] || typeof args.source !== 'string' || args.source.length > 100000 || (args.cell_type && !['code', 'markdown', 'raw'].includes(args.cell_type))) throw new Error('Notebook 单元参数无效。');
  const output = outputPath(args, [args.path], '.ipynb'), edited = notebook.cells[args.cell_index];
  edited.source = args.source.match(/[^\n]*\n|[^\n]+$/g) || []; if (args.cell_type) edited.cell_type = args.cell_type;
  for (const cell of notebook.cells) {
    delete cell.attachments; cell.metadata = {}; delete cell.outputs; delete cell.execution_count;
    if (cell.cell_type === 'code') { cell.outputs = []; cell.execution_count = null; }
  }
  // Preserve only inert kernel/language labels, never notebook trust/signature state or arbitrary metadata.
  notebook.metadata = {};
  return { ...await saveFile(ctx.userId, output, Buffer.from(JSON.stringify(notebook, null, 2) + '\n'), ctx), executed: false, outputsCleared: true };
}

export async function executeFileCapability(name, args, ctx) {
  ctx.signal?.throwIfAborted();
  if (!FILE_CAPABILITY_SCHEMAS.some(s => s.function.name === name)) return null;
  const root = resolveSafe(ctx.userId, 'artifact-probe').root;
  ctx = { ...ctx, fileWorkspaceRoot: root };
  try {
    let result;
    if (name.startsWith('pdf_')) result = await pdfAction(name, args, ctx);
    else if (name.startsWith('notebook_')) result = await notebookAction(name, args, ctx);
    else if (name === 'artifact_scan') result = { ok: true, scan: await scanArtifact(ctx.userId, args.path, ctx) };
    else if (name === 'latex_compile') { const { compileLatex } = await import('./docgen/latex.mjs'); result = await compileLatex(args, ctx); }
    else return null;
    return { ...result, text: JSON.stringify(result), summary: result.ok ? `${name} 完成` : `${name} 未完成`, evidence: [] };
  } catch (error) {
    ctx.signal?.throwIfAborted();
    const result = { ok: false, code: 'file_capability_failed', message: String(error.message).slice(0, 240) };
    return { ...result, text: JSON.stringify(result), summary: `${name} 未完成`, evidence: [] };
  }
}
