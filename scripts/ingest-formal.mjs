/**
 * Reproducible, offline-first import of licensed full-text formal-methods chapters.
 * node scripts/ingest-formal.mjs [--fetch [--via-gh]] [--check] [--output DIR]
 * Source code is retained as evidence, never executed or advertised as rechecked.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REVISION = '3f680b5130fe5495de9a3b7a63ae2591f15f055a';
export const REPOSITORY = 'Rocq-zh/SF-zh';
export const AUTHORS = ['Benjamin C. Pierce', 'Arthur Azevedo de Amorim', 'Chris Casinghino', 'Marco Gaboardi', 'Michael Greenberg', 'Cătălin Hriţcu', 'Vilhelm Sjöberg', 'Brent Yorgey'];
export const NOTICES = ['lf-current/LICENSE', 'plf-current/LICENSE', 'README.md', 'lf-current/index.html', 'plf-current/index.html'];
export const CATALOG = [
  ['lf', 'Basics', '函数式编程基础', '函数 定义 布尔 自然数 递归 归纳类型 functional programming boolean nat recursion'],
  ['lf', 'Induction', '归纳证明', '数学归纳法 归纳假设 归纳证明 结构归纳 induction hypothesis'],
  ['lf', 'Lists', '列表与数据结构', '列表 递归 数据结构 配对 list pair option'],
  ['lf', 'Poly', '多态与高阶函数', '多态 高阶函数 映射 折叠 polymorphism higher order map fold'],
  ['lf', 'Tactics', '证明策略', '证明 策略 假设 应用 泛化 反演 tactic apply intros inversion'],
  ['lf', 'Logic', 'Coq 中的逻辑系统', '逻辑 命题 合取 析取 否定 蕴含 等价 当且仅当 充分条件 必要条件 全称 存在 排中律 反证法 logic proposition conjunction disjunction negation implication quantifier classical constructive'],
  ['lf', 'IndProp', '归纳定义的命题', '归纳命题 推理规则 证据 关系 正则表达式 inductive proposition evidence relation'],
  ['lf', 'ProofObjects', '证明对象', '证明对象 Curry Howard 命题即类型 证明即程序 proof object proof irrelevance'],
  ['lf', 'IndPrinciples', '归纳原理', '归纳原理 归纳类型 证明 induction principle'],
  ['lf', 'Rel', '关系的性质', '关系 自反 传递 对称 反对称 偏序 闭包 relation reflexivity transitivity symmetry closure'],
  ['lf', 'Maps', '全映射与偏映射', '映射 环境 状态 全映射 偏映射 map total partial state'],
  ['lf', 'Imp', '命令式程序', '命令式语言 语法 语义 赋值 循环 条件 求值 imperative syntax semantics evaluation'],
  ['lf', 'ImpCEvalFun', '求值函数', '求值函数 终止 步数 超时 解释器 evaluation interpreter termination fuel'],
  ['plf', 'Equiv', '程序等价', '程序等价 行为等价 优化 语义 常量折叠 program equivalence semantics constant folding'],
  ['plf', 'Hoare', '霍尔逻辑', '霍尔逻辑 前置条件 后置条件 断言 赋值 规则 循环不变式 部分正确性 Hoare logic precondition postcondition assertion invariant'],
  ['plf', 'Hoare2', '霍尔逻辑进阶', '程序验证 装饰程序 循环不变式 最弱前置条件 Hoare decorated program invariant weakest precondition'],
  ['plf', 'HoareAsLogic', '作为逻辑的霍尔逻辑', '霍尔逻辑 可靠性 完备性 推导 证明 Hoare soundness completeness derivation'],
  ['plf', 'Smallstep', '小步操作语义', '小步 大步 操作语义 正规形 确定性 并发 small step big step operational semantics normal form'],
  ['plf', 'Types', '类型系统', '类型安全 进展 保持 类型健全性 类型推导 type safety progress preservation soundness'],
  ['plf', 'Stlc', '简单类型 Lambda 演算', '简单类型 Lambda 演算 类型推导 抽象 替换 函数 simple typed lambda calculus substitution'],
  ['plf', 'StlcProp', '简单类型 Lambda 演算的性质', '类型安全 进展 保持 替换 引理 弱化 唯一类型 progress preservation substitution weakening'],
  ['plf', 'MoreStlc', '简单类型 Lambda 演算扩展', '积类型 和类型 单元类型 递归 列表 类型系统 product sum unit fixpoint'],
  ['plf', 'Typechecking', '类型检查', '类型检查 可判定性 类型推导 算法 type checking decidability inference algorithm'],
  ['plf', 'Sub', '子类型', '子类型 子类型化 替换 宽度 深度 逆变 协变 subtyping contravariance covariance'],
  ['plf', 'Norm', '正规化', '正规化 终止 逻辑关系 可归约性 normalization termination logical relation reducibility'],
].map(([volume, chapter, title, keywords]) => ({
  volume, chapter, title, keywords,
  path: `${volume}-current/${chapter}.v`,
  sourceTitle: volume === 'lf' ? '软件基础 · 逻辑基础' : '软件基础 · 编程语言基础',
  category: volume === 'lf' ? '逻辑基础' : '程序语言基础',
}));

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function cleanDoc(text) {
  return text.replace(/\r\n?/g, '\n').replace(/_'([^\n]*?)'_/g, '$1')
    .replace(/^\s*\[\[\s*$/gm, '').replace(/^\s*\]\]\s*$/gm, '')
    .replace(/^[ \t]+/gm, '').replace(/[ \t]+$/gm, '').trim();
}

/** A balanced Coq comment scanner, not an evaluator; theorem code and printed output survive. */
export function parseCoqSections(input, chapterTitle = '正文') {
  const text = String(input).replace(/\r\n?/g, '\n');
  const lineAt = (offset) => 1 + (text.slice(0, offset).match(/\n/g) || []).length;
  const sections = [];
  let current = { heading: chapterTitle, blocks: [], ordinal: 0 };
  let codeStart = 0;
  let i = 0;
  let inString = false;
  const pushBlock = (body, start, end, kind) => {
    const clean = kind === 'prose' ? cleanDoc(body) : body.trim();
    if (clean) current.blocks.push({ text: clean, sourceStartLine: lineAt(start), sourceEndLine: lineAt(Math.max(start, end - 1)), kind });
  };
  const nextSection = (heading) => {
    if (current.blocks.length) sections.push(current);
    current = { heading: cleanDoc(heading), blocks: [], ordinal: sections.length };
  };
  while (i < text.length) {
    if (text[i] === '"') {
      if (inString && text[i + 1] === '"') { i += 2; continue; }
      inString = !inString;
      i += 1; continue;
    }
    if (inString || text.slice(i, i + 2) !== '(*') { i += 1; continue; }
    pushBlock(text.slice(codeStart, i), codeStart, i, 'code');
    const start = i;
    const isDoc = text[i + 2] === '*' && text[i + 3] !== ')';
    i += 2;
    let depth = 1;
    while (i < text.length && depth) {
      if (text.slice(i, i + 2) === '(*') { depth++; i += 2; }
      else if (text.slice(i, i + 2) === '*)') { depth--; i += 2; }
      else i++;
    }
    if (depth) throw new Error(`Unclosed Coq comment at line ${lineAt(start)}`);
    if (isDoc) {
      const body = text.slice(start + 3, i - 2).trim();
      const heading = body.match(/^\*{1,5}[ \t]+([^\n]+)(?:\n([\s\S]*))?$/);
      if (heading) {
        nextSection(heading[1]);
        if (heading[2]?.trim()) pushBlock(heading[2], start, i, 'prose');
      }
      else pushBlock(body, start, i, 'prose');
    } else {
      const body = text.slice(start + 2, i - 2).trim();
      if (body && !/^[#=*\s-]+$/.test(body) && !/^TODO\b/.test(body) && !/^\d{4}-\d\d-\d\d/.test(body)) {
        pushBlock(text.slice(start, i), start, i, 'code');
      }
    }
    codeStart = i;
  }
  pushBlock(text.slice(codeStart), codeStart, text.length, 'code');
  if (current.blocks.length) sections.push(current);
  return sections;
}

/** Chunk only at source-block boundaries; long proof blocks stay intact. */
export function chunkSections(sections, maxChars = 6500) {
  const chunks = [];
  for (const section of sections) {
    let pending = [];
    let length = 0;
    let part = 1;
    const flush = () => {
      if (!pending.length) return;
      chunks.push({ heading: section.heading, ordinal: section.ordinal, part: part++, text: pending.map((b) => b.text).join('\n\n'),
        sourceStartLine: pending[0].sourceStartLine, sourceEndLine: pending.at(-1).sourceEndLine,
        containsCode: pending.some((b) => b.kind === 'code'), prose: pending.filter((b) => b.kind === 'prose').map((b) => b.text).join('\n') });
      pending = []; length = 0;
    };
    for (const block of section.blocks) {
      if (pending.length && length + block.text.length > maxChars) flush();
      pending.push(block); length += block.text.length + 2;
    }
    flush();
  }
  return chunks;
}

export function stableId(sourcePath, heading, occurrence, part) {
  // 48 bits fit exactly in Number; separate from the former CSL 1..40000 namespace.
  return 900_000_000 + parseInt(sha256(`${REPOSITORY}\n${sourcePath}\n${heading}\n${occurrence}\n${part}`).slice(0, 12), 16);
}

/** Conservative metadata, not a translation: untranslated sections remain labelled English. */
export function sectionLanguage(prose) {
  const han = (prose.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (prose.match(/[A-Za-z]{3,}/g) || []).length;
  if (!han && !words) return 'code';
  if (words >= 20 && han < 20) return 'en';
  if (han >= 20 && words >= Math.max(40, han / 4)) return 'mixed';
  return han > 0 ? 'zh-CN' : 'en';
}

const CONCEPTS = [
  [['合取', 'conjunction'], ['合取', '逻辑与', 'conjunction']],
  [['析取', 'disjunction'], ['析取', '逻辑或', 'disjunction']],
  [['否定', 'negation'], ['否定', '逻辑非', 'negation']],
  [['蕴含', 'implication'], ['蕴含', '条件命题', '充分条件', '必要条件', 'implication']],
  [['逻辑等价', '当且仅当', 'if and only if'], ['逻辑等价', '充要条件', '当且仅当', 'iff']],
  [['全称', 'universal quantification'], ['全称量词', '全称量化', 'universal quantifier']],
  [['存在量', 'existential quantification'], ['存在量词', '存在量化', 'existential quantifier']],
  [['排中律', 'excluded middle'], ['排中律', '经典逻辑', '构造逻辑', 'excluded middle']],
  [['归纳假设', 'induction hypothesis'], ['归纳假设', '数学归纳法', 'induction hypothesis']],
  [['柯里', '霍华德', 'Curry', 'Howard', 'proofs as programs'], ['柯里霍华德对应', 'Curry Howard', '命题即类型', '证明即程序']],
  [['前置条件', 'precondition'], ['前置条件', 'precondition']],
  [['后置条件', 'postcondition'], ['后置条件', 'postcondition']],
  [['不变式', 'loop invariant'], ['循环不变式', '程序验证', 'loop invariant']],
  [['可进行', '进展', 'progress'], ['进展性质', '类型安全', 'progress']],
  [['保型', 'preservation'], ['类型保持', '保持性质', '类型安全', 'preservation']],
  [['可靠性', 'soundness'], ['可靠性', '健全性', 'soundness']],
  [['正规化', 'normalization'], ['正规化', '归一化', '终止', 'normalization']],
  [['协变', 'covariant'], ['协变', 'covariance']],
  [['逆变', 'contravariant'], ['逆变', 'contravariance']],
  [['小步', 'small-step', 'small step'], ['小步操作语义', 'small step semantics']],
  [['大步', 'big-step', 'big step'], ['大步操作语义', 'big step semantics']],
];

function containsTerm(text, term) {
  if (/[\u3400-\u9fff]/.test(term)) return text.includes(term);
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/** Index only concepts actually mentioned in this section, not every term in its chapter. */
export function sectionKeywords(chapter, chunk) {
  const text = `${chunk.heading}\n${chunk.text}`;
  const terms = new Set([chapter.category]);
  for (const term of chapter.keywords.split(/\s+/)) if (containsTerm(text, term)) terms.add(term);
  for (const [needles, aliases] of CONCEPTS) if (needles.some((term) => containsTerm(text, term))) aliases.forEach((term) => terms.add(term));
  return [...terms].join(' ');
}

export function buildCorpus(sourceTexts) {
  const records = [];
  const sourceEntries = [];
  const ids = new Set();
  for (const chapter of CATALOG) {
    const original = sourceTexts.get(chapter.path);
    if (typeof original !== 'string' || !original.trim()) throw new Error(`Missing source: ${chapter.path}`);
    const sourceSha256 = sha256(original);
    const chunks = chunkSections(parseCoqSections(original, chapter.title));
    const headingCounts = new Map();
    const ordinals = new Map();
    for (const chunk of chunks) {
      if (!ordinals.has(chunk.ordinal)) {
        const count = headingCounts.get(chunk.heading) || 0;
        ordinals.set(chunk.ordinal, count);
        headingCounts.set(chunk.heading, count + 1);
      }
      const id = stableId(chapter.path, chunk.heading, ordinals.get(chunk.ordinal), chunk.part);
      // Imports/module scaffolding alone cannot support an answer; keep them in raw snapshots.
      const substance = chunk.text.replace(/(?:From\s+[\w.]+\s+)?Require\s+(?:(?:Import|Export)\s+)?[^.]+\./g, '')
        .replace(/(?:Set|Unset) Warnings\s+"[^"]*"\./g, '').replace(/(?:Module|End)\s+[\w.]+\./g, '').trim();
      if (!substance || substance === '[]') continue;
      if (ids.has(id)) throw new Error(`Stable ID collision: ${id}`);
      ids.add(id);
      const chapterUrl = `https://github.com/${REPOSITORY}/blob/${REVISION}/${chapter.path}`;
      const title = `${chapter.title} · ${chunk.heading}${chunk.part > 1 ? `（续 ${chunk.part}）` : ''}`;
      records.push({
        id, corpus: 'formal', recordType: 'textbook-section', title, abstract: chunk.text, keywords: sectionKeywords(chapter, chunk),
        discipline: '计算机科学与形式逻辑', category: chapter.category,
        sourceTitle: chapter.sourceTitle, chapter: chapter.chapter, section: chunk.heading,
        authors: chapter.volume === 'lf' ? AUTHORS : [...AUTHORS.slice(0, -1), 'Andrew Tolmach', AUTHORS.at(-1)],
        translators: 'Coq-zh / Rocq-zh 项目组及贡献者',
        publisher: 'Software Foundations / Rocq-zh', language: sectionLanguage(chunk.prose),
        sourceEdition: chapter.volume === 'lf' ? 'Logical Foundations 5.7' : 'Programming Language Foundations 5.8',
        volumeVersion: chapter.volume === 'lf' ? '5.7' : '5.8',
        sourceEditionDate: '2022-03-14',
        sourceUrl: `${chapterUrl}#L${chunk.sourceStartLine}-L${chunk.sourceEndLine}`,
        canonicalUrl: `https://rocq-zh.github.io/SF-zh/${chapter.volume}-current/${chapter.chapter}.html`,
        sourcePath: chapter.path, sourceRevision: REVISION,
        sourceStartLine: chunk.sourceStartLine, sourceEndLine: chunk.sourceEndLine,
        license: 'MIT', licenseUrl: `https://github.com/${REPOSITORY}/blob/${REVISION}/${chapter.volume}-current/LICENSE`,
        contentSha256: sha256(chunk.text), sourceSha256, translationStatus: 'alpha',
        containsCode: chunk.containsCode,
        containsExercises: /练习|FILL IN HERE|Admitted\./i.test(chunk.heading + '\n' + chunk.text),
        contentRole: /练习|exercise/i.test(chunk.heading) ? 'exercise' : 'exposition',
        proofStatus: 'source-text-not-rechecked',
      });
    }
    sourceEntries.push({ path: chapter.path, revision: REVISION, sha256: sourceSha256, bytes: Buffer.byteLength(original),
      title: chapter.title, sourceTitle: chapter.sourceTitle, sectionCount: records.filter((r) => r.sourcePath === chapter.path).length,
      url: `https://github.com/${REPOSITORY}/blob/${REVISION}/${chapter.path}` });
  }
  const jsonl = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  const manifest = {
    schemaVersion: 1, name: '软件基础 · 中文形式逻辑与程序验证全文库', profile: 'formal',
    description: '精选 Software Foundations 中文译本的逻辑基础与程序语言基础原文、定义和证明代码；不包含生成的习题答案。',
    version: 'sf-zh-2026-06-19-v1', revision: REVISION, language: 'zh-CN/en',
    languages: Object.fromEntries(['zh-CN', 'en', 'mixed', 'code'].map((language) => [language, records.filter((record) => record.language === language).length])),
    licenses: ['MIT'], sourceCount: 2, chapterCount: CATALOG.length, sectionCount: records.length,
    contentSha256: sha256(jsonl), totalCharacters: records.reduce((sum, r) => sum + r.abstract.length, 0),
    repository: `https://github.com/${REPOSITORY}`, pinnedRepository: `https://github.com/${REPOSITORY}/tree/${REVISION}`,
    officialReference: 'https://softwarefoundations.cis.upenn.edu/lf-current/Preface.html',
    translationStatus: 'alpha', proofStatus: 'source-text-not-rechecked',
    limitations: ['上游中文版标注为 alpha，可能有翻译错误；部分章节尚为英文，已按每节实际解释文字标记语言，没有生成翻译。',
      '采用固定仓库快照；原卷标题页标注 LF 5.7 / PLF 5.8，发布日期为 2022-03-14，不将快照日期冒充教材出版日期。',
      '这是经过章节筛选的开放教材全文库，不是同行评审论文库。',
      '保留上游已有证明和含 Admitted 的练习占位；本次未运行 Rocq/Coq 对它们重新编译验证。',
      '中文章节关键词是人工检索元数据，未插入来源正文，不应当作原文引用。'],
    transformations: ['按 Coq 文档标题分节；保留解释文字、证明代码与打印结果；剥离分隔线、TODO 编辑注释和少量 Coqdoc 强调标记；不索引仅有导入或模块声明的空节。',
      '在原始块边界分片；sourceStartLine/sourceEndLine 指向保留的原始 .v 文件范围。'],
    keywordPolicy: '只添加本节实际出现的术语及人工定义同义词，不把整章所有术语赋给每个片段；关键词不属于原文。',
    sources: sourceEntries,
  };
  return { records, jsonl, manifest };
}

async function download(sourcePath, viaGh) {
  if (viaGh) {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        result = JSON.parse(execFileSync('gh', ['api', `repos/${REPOSITORY}/contents/${sourcePath}?ref=${REVISION}`], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    if (result.encoding !== 'base64' || typeof result.content !== 'string') throw new Error(`Invalid GitHub response: ${sourcePath}`);
    const data = Buffer.from(result.content.replace(/\s/g, ''), 'base64');
    const blobHash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    if (blobHash !== result.sha) throw new Error(`Git blob digest mismatch: ${sourcePath}`);
    return data.toString('utf8');
  }
  const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${REVISION}/${sourcePath}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Download ${sourcePath}: HTTP ${response.status}`);
  return response.text();
}

async function atomicWrite(filename, content) {
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, filename);
}

export async function main(args = process.argv.slice(2)) {
  const outputIndex = args.indexOf('--output');
  if (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1].startsWith('--'))) throw new Error('--output needs a directory');
  const output = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : path.join(ROOT, 'data/formal'));
  const check = args.includes('--check');
  if (check && args.includes('--fetch')) throw new Error('--check cannot be combined with --fetch');
  const sources = new Map();
  const oldManifest = await fs.readFile(path.join(output, 'manifest.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!args.includes('--fetch') && oldManifest && oldManifest.revision !== REVISION) throw new Error('Pinned revision changed; fetch the new source revision first');
  const paths = [...CATALOG.map((item) => item.path), ...NOTICES];
  for (const sourcePath of paths) {
    const filename = path.join(output, 'sources', sourcePath);
    let text;
    if (args.includes('--fetch')) {
      text = await download(sourcePath, args.includes('--via-gh'));
      const previous = [...(oldManifest?.sources || []), ...(oldManifest?.notices || [])].find((entry) => entry.path === sourcePath);
      if (previous && oldManifest.revision === REVISION && previous.sha256 !== sha256(text)) throw new Error(`Pinned source changed: ${sourcePath}`);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await atomicWrite(filename, text);
      process.stdout.write(`Fetched ${sourcePath}\n`);
    } else {
      text = await fs.readFile(filename, 'utf8');
      const previous = [...(oldManifest?.sources || []), ...(oldManifest?.notices || [])].find((entry) => entry.path === sourcePath);
      if (previous && previous.sha256 !== sha256(text)) throw new Error(`Source checksum mismatch: ${sourcePath}`);
    }
    sources.set(sourcePath, text);
  }
  const { jsonl, manifest } = buildCorpus(sources);
  manifest.notices = NOTICES.map((name) => ({ path: name, sha256: sha256(sources.get(name)) }));
  const serializedManifest = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    const [actual, actualManifest] = await Promise.all([fs.readFile(path.join(output, 'papers.jsonl'), 'utf8'), fs.readFile(path.join(output, 'manifest.json'), 'utf8')]);
    if (actual !== jsonl || actualManifest !== serializedManifest) throw new Error('Corpus differs from the reproducible source build');
  } else {
    await fs.mkdir(output, { recursive: true });
    await atomicWrite(path.join(output, 'papers.jsonl'), jsonl);
    await atomicWrite(path.join(output, 'manifest.json'), serializedManifest);
  }
  console.log(JSON.stringify({ checked: check, chapters: manifest.chapterCount, sections: manifest.sectionCount, characters: manifest.totalCharacters, sha256: manifest.contentSha256, output }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
