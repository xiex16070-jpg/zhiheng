import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveSafe, writeArtifact } from '../workspace.mjs';
import { runCommand } from '../exec.mjs';
import { readWorkspaceBinary, scanArtifact } from '../file-tools.mjs';

// TeX is programmable: shell-escape off alone is not a filesystem sandbox.
// Accept a deliberately small literal subset, with no macro definitions, file reads,
// category-code changes, dynamically constructed commands or package-controlled inputs.
const COMMANDS = new Set(('documentclass usepackage begin end title author date maketitle section subsection subsubsection paragraph textbf textit texttt emph underline textsf textrm textnormal small large Large LARGE huge Huge tiny normalsize centering raggedright raggedleft hfill vfill hspace vspace noindent par newline linebreak newpage clearpage item label ref eqref cite footnote caption rule frac dfrac tfrac sqrt sum prod int iint lim min max log ln exp sin cos tan left right big Big bigg Bigg mathbb mathcal mathfrak mathrm mathbf mathit mathsf mathop operatorname overline underline widehat widetilde hat tilde bar vec dot ddot dots ldots cdots vdots ddots alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega forall exists nexists in notin subset subseteq supset supseteq cup cap setminus emptyset varnothing land lor neg lnot to gets implies iff Rightarrow Leftarrow Leftrightarrow rightarrow leftarrow leftrightarrow mapsto longrightarrow leq geq neq approx equiv sim cong propto infty partial nabla times cdot div pm mp oplus otimes perp parallel mid lvert rvert lVert rVert langle rangle lceil rceil lfloor rfloor top bot true false quad qquad thinspace medspace thickspace text boxed cases matrix pmatrix bmatrix vmatrix Vmatrix multicolumn hline cline toprule midrule bottomrule addlinespace tableofcontents').split(' '));
const ENVIRONMENTS = new Set('document abstract itemize enumerate description center flushleft flushright equation equation* align align* aligned gather gather* split multline multline* displaymath math cases matrix pmatrix bmatrix vmatrix Vmatrix array tabular table figure quote quotation proof'.split(' '));
const PACKAGES = new Set('amsmath amssymb amsthm mathtools booktabs array geometry'.split(' '));

export function validateLatexSource(source) {
  if (typeof source !== 'string' || source.length > 100000 || !source.trim()) throw new Error('LaTeX 源文件须为 1–100000 字符。');
  if (source.includes('^^') || /[\x00\u200b-\u200f\u202a-\u202e]/.test(source)) throw new Error('LaTeX 不允许字符编码变换或隐藏控制字符。');
  for (const match of source.matchAll(/\\([A-Za-z@]+|.)/g)) {
    const cmd = match[1];
    if (!COMMANDS.has(cmd) && !['\\', '{', '}', '$', '%', '#', '&', '_', ',', ';', ':', '!', ' ', '[', ']', '(', ')'].includes(cmd)) throw new Error('LaTeX 安全子集不支持命令：\\' + cmd);
  }
  for (const match of source.matchAll(/\\(?:begin|end)\s*\{([^}]+)\}/g)) if (!ENVIRONMENTS.has(match[1])) throw new Error('LaTeX 环境未获支持：' + match[1]);
  for (const match of source.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) if (match[1].split(',').some(n => !PACKAGES.has(n.trim()))) throw new Error('仅允许本地缓存的基础数学排版包。');
  for (const match of source.matchAll(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) if (!['article', 'report', 'book'].includes(match[1])) throw new Error('仅允许 article/report/book 文档类。');
  if (!/\\documentclass\s*(?:\[[a-zA-Z0-9,= .-]*\])?\s*\{(?:article|report|book)\}/.test(source)) throw new Error('请使用 article/report/book 的自包含文档。');
  // Demand literal arguments; a valid-looking declaration must not hide a second dynamic one.
  for (const m of source.matchAll(/\\(documentclass|usepackage|begin|end)\b/g)) {
    const rest = source.slice(m.index + m[0].length);
    if (!/^\s*(?:\[[a-zA-Z0-9,= .-]*\])?\s*\{[A-Za-z0-9,* ]+\}/.test(rest)) throw new Error('文档类、宏包与环境名称必须为直接字面值。');
  }
  return true;
}

export async function latexAvailability(userId) {
  const { getRuntimeSettings } = await import('../runtime-settings.mjs');
  const engine = String(getRuntimeSettings(userId).latexEnginePath);
  if (!path.isAbsolute(engine) || !/^tectonic(?:\.exe)?$/i.test(path.basename(engine))) return { available: false, reason: '未配置可信 Tectonic 绝对路径（LATEX_ENGINE_PATH）。可使用 create_document 生成 PDF。' };
  try { const stat = await fs.lstat(engine); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(); }
  catch { return { available: false, reason: '配置的 Tectonic 不存在或不是普通可执行文件。' }; }
  return { available: true, engine };
}

export async function compileLatex(args, ctx, { availability: detect = latexAvailability, run = runCommand } = {}) {
  const availability = await detect(ctx.userId);
  if (!availability.available) return { ok: false, code: 'unavailable', message: availability.reason };
  if (ctx.approvalVerified !== true) return { ok: false, code: 'approval_required', message: 'LaTeX 编译必须先通过本次参数绑定的命令执行审批。' };
  if (!/\.tex$/i.test(args.source_path) || !/\.pdf$/i.test(args.output_path)) throw new Error('需要 .tex 源文件和新的 .pdf 输出路径。');
  const output = resolveSafe(ctx.userId, args.output_path); if (output.error) throw new Error('输出路径必须位于当前工作区。');
  const source = (await readWorkspaceBinary(ctx.userId, args.source_path, { signal: ctx.signal, maxBytes: 400000 })).toString('utf8');
  validateLatexSource(source);
  // A newly allocated, private scratch directory is an implementation detail of the
  // approved compilation. Its fixed input name is not a second workspace artifact grant.
  await fs.mkdir(output.root, { recursive:true });
  const buildAbs=await fs.mkdtemp(path.join(output.root,'.latex-build-'));
  const buildRel=path.basename(buildAbs),build=resolveSafe(ctx.userId,buildRel);
  if(build.error||build.abs!==buildAbs)throw new Error('编译目录不可用。');
  try {
    const input=resolveSafe(ctx.userId,buildRel+'/source.tex');
    if(input.error||path.dirname(input.abs)!==build.abs)throw new Error('编译输入目录已变化。');
    await fs.writeFile(input.abs,source,{flag:'wx',mode:0o600,signal:ctx.signal});
    const argv = [availability.engine, '-X', 'compile', '--untrusted', '--only-cached', '--outfmt', 'pdf', '--reruns', '1', 'source.tex'];
    const result = await run({ userId: ctx.userId, taskId: ctx.taskId || randomUUID(), argv, cwd: buildRel, timeoutMs: 60000, signal: ctx.signal, approved: true });
    ctx.signal?.throwIfAborted();
    if (!result.ok) return { ok: false, code: result.timedOut ? 'timeout' : 'compile_failed', message: String(result.reason || result.stderr || '离线编译失败；请确认本机已安装且已缓存所需 TeX 包。').slice(0, 2000) };
    const bytes = await readWorkspaceBinary(ctx.userId, buildRel + '/source.pdf', { signal: ctx.signal });
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('编译器未生成有效 PDF。');
    if (resolveSafe(ctx.userId, args.output_path).abs !== output.abs) throw new Error('workspace_changed');
    const saved = await writeArtifact(ctx.userId, args.output_path, bytes, { signal: ctx.signal });
    if (!saved.ok) return saved;
    const scan = await scanArtifact(ctx.userId, saved.path, ctx);
    return { ...saved, offline: true, scan, artifact: { kind: 'file', action: 'write', path: saved.path, bytes: saved.bytes, format: 'pdf', scan } };
  } finally {
    // Remove only known filenames after rechecking the workspace. Never recursively delete user paths.
    const current = resolveSafe(ctx.userId, buildRel);
    if (!current.error && current.abs === build.abs) {
      for (const name of ['source.tex', 'source.pdf', 'source.log', 'source.aux', 'source.out', 'source.toc']) {
        const file = resolveSafe(ctx.userId, buildRel + '/' + name); if (!file.error) await fs.unlink(file.abs).catch(() => {});
      }
      await fs.rmdir(build.abs).catch(() => {});
    }
  }
}
