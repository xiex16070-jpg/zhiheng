/**
 * 文本处理：归一化、分词（中文二元组 + ASCII 词）、引用标记解析。
 * 无任何 DOM 依赖，可在 Node 中直接单元测试。
 */

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005-\u3007]/;
const CJK_CHAR = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3005-\u3007]/;

/** 中文高频虚词二元组，参与打分会引入噪声 */
const ZH_STOP = new Set([
  '的是', '了', '我们', '什么', '怎么', '如何', '为什', '什么', '这个', '那个',
  '可以', '一个', '以及', '但是', '因为', '所以', '如果', '就是', '还是', '不是',
  '有什', '么区', '区别', '一下', '请问', '怎样', '哪些', '是否', '需要', '应该',
  '哪个', '能否', '么样', '这样', '那样', '什么', '时候', '为什么',
]);

/** 单字虚词：作为单字 token 出现时几乎不携带信息 */
const ZH_SINGLE_STOP = new Set([
  '的', '了', '是', '在', '有', '和', '与', '就', '也', '都', '而', '及', '其',
  '这', '那', '我', '你', '他', '它', '个', '上', '下', '中', '为', '以', '被',
  '把', '从', '到', '对', '会', '能', '要', '吗', '呢', '吧', '啊', '着', '过',
]);

const EN_STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on',
  'for', 'and', 'or', 'not', 'with', 'as', 'at', 'by', 'it', 'this', 'that',
  'what', 'how', 'why', 'when', 'which', 'do', 'does', 'did', 'can', 'could',
  'should', 'would', 'i', 'my', 'me', 'you', 'your', 'we', 'they', 'there',
]);

export function normalize(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .toLowerCase();
}

function pushToken(out, term, weight) {
  if (!term) return;
  if (EN_STOP.has(term)) return;
  if (ZH_STOP.has(term)) return;
  if (term.length === 1 && CJK_CHAR.test(term) && ZH_SINGLE_STOP.has(term)) return;
  if (term.length === 1 && !CJK_CHAR.test(term) && !/[0-9]/.test(term)) return;
  out.push({ term, weight });
}

/**
 * 分词：ASCII 词按非字母数字切分；CJK 连续段切为二元组（单字段落保留单字）。
 * 返回 [{term, weight}]，权重用于 BM25 加权求和。
 */
// Unicode logic notation is indexed as the ASCII forms the corpus uses (Coq/Rocq).
const LOGIC_SYMBOLS = { '¬': '~', '∧': '/\\', '∨': '\\/', '→': '->', '⇒': '->', '↔': '<->', '⇔': '<->', '⊢': '|-', '∀': ' forall ', '∃': ' exists ' };
const LOGIC_SYMBOL_RE = /[¬∧∨→⇒↔⇔⊢∀∃]/g;
// PDF text wraps lines inside words: a single line break between two CJK
// characters is not a word boundary, a blank line is.
const LINE_WRAP = /[ \t]*\n[ \t]*/y;

export function tokenize(text, { formalSyntax = true } = {}) {
  let s = normalize(text);
  if (formalSyntax) s = s.replace(LOGIC_SYMBOL_RE, (symbol) => LOGIC_SYMBOLS[symbol]);
  const out = [];
  let i = 0, codeTicks = 0, lastOperatorEnd = -1;
  const operator = /<->|->|\/\\|\\\/|:=|\|-|~/y;
  const followedByOperator = /^\s*(?:<->|->|\/\\|\\\/|:=|\|-|~)/;

  while (i < s.length) {
    const ch = s[i];

    if (formalSyntax && ch === '`') {
      let end = i + 1;
      while (s[end] === '`') end++;
      if (!codeTicks) codeTicks = end - i;
      else if (codeTicks === end - i) codeTicks = 0;
      i = end;
      continue;
    }
    if (formalSyntax && '<-/\\:|~'.includes(ch)) {
      operator.lastIndex = i;
      const match = operator.exec(s);
      if (match) {
        out.push({ term: match[0], weight: 1 });
        i = lastOperatorEnd = operator.lastIndex;
        continue;
      }
    }

    if (CJK_CHAR.test(ch)) {
      let j = i, run = '';
      while (j < s.length) {
        if (CJK_CHAR.test(s[j])) { run += s[j++]; continue; }
        LINE_WRAP.lastIndex = j;
        const wrap = LINE_WRAP.exec(s);
        if (wrap && CJK_CHAR.test(s[LINE_WRAP.lastIndex] || '')) { j = LINE_WRAP.lastIndex; continue; }
        break;
      }
      if (run.length === 1) {
        pushToken(out, run, 0.35);
      } else {
        for (let k = 0; k + 1 < run.length; k++) {
          pushToken(out, run.slice(k, k + 2), 1);
        }
        // 长术语整体保留一次，利于精确命中（如「否定即失败」）
        if (run.length >= 4 && run.length <= 8) pushToken(out, run, 1.2);
      }
      i = j;
      continue;
    }

    if (/[a-z0-9_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[a-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      // 下划线 / 数字边界再切一次，让 `clpfd` 与 `clp_fd`、`is/2` 与 `is` 互相命中
      const parts = word.split(/[_\d]+/).filter(Boolean);
      const formalVariable = formalSyntax && /^[a-z]$/.test(word) &&
        (codeTicks || (lastOperatorEnd >= 0 && i - lastOperatorEnd <= 32 && !s.slice(lastOperatorEnd, i).trim()) ||
         followedByOperator.test(s.slice(j, j + 34)));
      if (formalVariable) out.push({ term: word, weight: 0.65 });
      else pushToken(out, word, 1);
      for (const p of parts) if (p !== word && p.length > 1) pushToken(out, p, 0.6);
      i = j;
      continue;
    }

    i++;
  }

  return out;
}

/** 把 token 数组聚合成 term -> weight 的 Map（同一 term 取最大权重） */
export function termWeights(tokens) {
  const map = new Map();
  for (const { term, weight } of tokens) {
    const prev = map.get(term) || 0;
    if (weight > prev) map.set(term, weight);
  }
  return map;
}

export function isCjk(ch) {
  return CJK_CHAR.test(ch);
}

export function hasCjk(text) {
  return CJK_RE.test(text);
}

/** 引用标记：[[doc-id_3]] */
const CITE_RE = /\[\[\s*([a-z0-9][a-z0-9-]*)_(\d+)\s*\]\]/gi;

export function extractCitations(text) {
  const seen = new Set();
  const out = [];
  let m;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(text))) {
    const id = `${m[1].toLowerCase()}_${Number(m[2])}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 文献引用标记：[[12858]] */
const PAPER_CITE_RE = /\[\[\s*(\d+)\s*\]\]/g;

export function extractPaperCitations(text) {
  const seen = new Set();
  const out = [];
  let m;
  PAPER_CITE_RE.lastIndex = 0;
  while ((m = PAPER_CITE_RE.exec(String(text || '')))) {
    const id = String(Number(m[1]));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 统一引用标记：[[ref]]
 * ref 既可能是论文数字 ID（12858），也可能是文档片段 ID（k1a2b3c_4）。
 */
const REF_RE = /\[\[\s*([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*\]\]/g;

export function hasOnlyReferences(text) {
  const rest = text.replace(REF_RE, '');
  return rest !== text && /^[\s\p{P}]*$/u.test(rest);
}

export function extractRefs(text) {
  const seen = new Set();
  const out = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(String(text || '')))) {
    const ref = m[1];
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

export function citedSources(body, citations) {
  const byRef = new Map((citations || []).map(c => [String(c.ref ?? c.id), c]));
  return extractRefs(body).filter(ref => byRef.has(ref)).map(ref => byRef.get(ref));
}

/**
 * 参考清单格式化（zotero 插件 cite --marker 模式的最小移植）：
 * CSL 语料只有标题/学科元数据——不臆造作者与年份，按可用字段诚实输出。
 */
export function formatBibliography(citations) {
  const lines = [];
  (citations || []).forEach((c, i) => {
    const n = i + 1;
    if (c.kind === 'doc') {
      const loc = c.locatable === false ? '' : c.start || c.end ? `，字符 ${c.start}-${c.end}` : '';
      lines.push(`[${n}] ${c.docName || c.title}${c.heading ? '·' + c.heading : ''}${loc}（自建知识库文档）`);
    } else if (c.kind === 'external') {
      const a = c.authority;
      lines.push(a ? `[${n}] ${a.authors ? a.authors + '. ' : ''}${c.title}. ${a.venue || a.origin || a.catalog || ''}, ${a.publishedAt || '日期未提供'}. ${c.sourceUrl || ''}（${a.type === 'preprint' ? '预印本；' : ''}${a.evidenceLevel === 'abstract' ? '摘要' : '网页摘录'}，取得于 ${String(a.retrievedAt || '').slice(0, 10)}）` : `[${n}] ${c.title}（外部知识源，无字符偏移）`);
    } else {
      const disc = [c.discipline, c.category].filter(Boolean).join('/');
      if (c.sourceUrl) {
        const authors = Array.isArray(c.authors) ? c.authors.join(', ') : c.authors || '';
        lines.push(`[${n}] ${authors ? `${authors}. ` : ''}${c.title}. ${c.sourceTitle || '专业全文资料'}${c.section ? `，${c.section}` : ''}. ${c.sourceUrl}${c.sourceRevision ? `，版本 ${c.sourceRevision}` : ''}${c.license ? `，${c.license}` : ''}${c.translationStatus === 'alpha' ? '（中文译本 alpha）' : ''}.`);
      } else lines.push(`[${n}] ${c.title}${disc ? `［${disc}］` : ''}. ${c.sourceTitle || '内置文献库'}, id=${c.ref}.`);
    }
  });
  return lines.join('\n');
}

export function stripCitations(text) {
  return String(text || '').replace(CITE_RE, '');
}

/**
 * 推断块解析：[推断]（依据[[ref1]][[ref2]]；方法:归纳；置信度:中）结论……
 *
 * 推断是「原文没有但由证据推出」的结论，必须显式锚定依据 ref。
 * 标记后的元数据括号支持全/半角；结论取到空行或下一个标记为止。
 * 返回 [{ text, refs, method, confidence, start, end }]，供服务端校验与前端渲染。
 */
const INFER_RE = /\[推断\]\s*[（(]([^)）]*)[)）]\s*/g;

export function parseInferences(text) {
  const s = String(text || '');
  const out = [];
  let m;
  INFER_RE.lastIndex = 0;
  while ((m = INFER_RE.exec(s))) {
    const meta = m[1] || '';
    // 结论主体：标记之后到空行 / 下一个 [推断] / 文本结尾
    let end = s.length;
    const blank = s.indexOf('\n\n', INFER_RE.lastIndex);
    if (blank >= 0) end = Math.min(end, blank);
    const next = s.indexOf('[推断]', INFER_RE.lastIndex);
    if (next >= 0) end = Math.min(end, next);
    const body = s.slice(INFER_RE.lastIndex, end).trim();
    const methodM = /方法[:：]\s*([^;；,，)）]*)/.exec(meta);
    const confM = /置信度[:：]\s*([^;；,，)）]*)/.exec(meta);
    out.push({
      text: body,
      refs: extractRefs(meta).concat(extractRefs(body.split('\n')[0] || '').filter((r) => !extractRefs(meta).includes(r))),
      method: methodM ? methodM[1].trim() : null,
      confidence: confM ? confM[1].trim() : null,
      start: m.index,
      end,
    });
  }
  return out;
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 取片段：围绕命中词截取，避免长片段淹没模型 */
export function clip(text, max = 320) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + '…';
}

/** 高亮查询词在片段中的命中位置（用于 UI，返回纯文本标记） */
export function firstHitIndex(text, terms) {
  const s = String(text || '').toLowerCase();
  let best = -1;
  for (const t of terms) {
    if (!t || t.length < 2) continue;
    const idx = s.indexOf(t.toLowerCase());
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  return best;
}
