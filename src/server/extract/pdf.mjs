/**
 * PDF 文本提取（纯 JS，零依赖）。
 *
 * 支持范围：
 *   - 交叉引用表 / 对象流（ObjStm）两种对象组织方式
 *   - FlateDecode 内容流
 *   - 简单字体（Type1/TrueType）与 CID 字体（Identity-H）
 *   - ToUnicode CMap 的 bfchar / bfrange 映射（中文 PDF 的关键）
 *
 * 不做版面还原（表格、分栏会按阅读流拼接），目标是「拿到可检索的正文」，
 * 而不是「还原排版」。
 */

import zlib from 'node:zlib';

// 量词必须带上界：PDF 里出现超长数字串时，\d+ 会逐位回溯，把解析拖成 O(n²)
const OBJ_RE = /(\d{1,9})[ \t\r\n]{1,4}(\d{1,3})[ \t\r\n]{1,4}obj\b/g;

/* ---------------------------------------------------------------- 基础工具 */

// 解压上限：恶意 PDF 可以构造极小的压缩包展开成几十 GB，必须设上限
const MAX_INFLATED = 64 * 1024 * 1024;

function inflate(buf) {
  if (!buf || !buf.length) return null;
  const opts = { maxOutputLength: MAX_INFLATED };
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.unzipSync]) {
    try {
      return fn(buf, opts);
    } catch {
      /* 换下一种 */
    }
  }
  return null;
}

/** 从字典文本里取整数键值，支持间接引用 `12 0 R` */
function dictInt(dict, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)(\\s+\\d+\\s+R)?`).exec(dict);
  if (!m) return null;
  return m[2] ? { ref: Number(m[1]) } : { value: Number(m[1]) };
}

function dictRef(dict, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
}

function dictRefs(dict, key) {
  const m = new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`).exec(dict);
  if (!m) return [];
  return [...m[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));
}

/* ---------------------------------------------------------------- 对象表 */

function parseObjects(raw) {
  const objs = new Map();
  OBJ_RE.lastIndex = 0;
  let m;
  while ((m = OBJ_RE.exec(raw))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    let endIdx = raw.indexOf('endobj', bodyStart);
    if (endIdx < 0) endIdx = raw.length;
    const body = raw.slice(bodyStart, endIdx);

    const sIdx = body.indexOf('stream');
    if (sIdx < 0) {
      objs.set(num, { dict: body, stream: null, raw: body });
      continue;
    }

    const dict = body.slice(0, sIdx);
    let dataStart = sIdx + 6;
    if (body[dataStart] === '\r') dataStart += 1;
    if (body[dataStart] === '\n') dataStart += 1;

    // 优先用 /Length 精确切分，避免二进制里出现 endstream 字样时截断错误
    let len = null;
    const lm = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict);
    if (lm && !lm[2]) len = Number(lm[1]);
    let dataEnd;
    if (len && dataStart + len <= body.length) dataEnd = dataStart + len;
    else {
      dataEnd = body.lastIndexOf('endstream');
      if (dataEnd < dataStart) dataEnd = body.length;
    }

    objs.set(num, { dict, stream: Buffer.from(body.slice(dataStart, dataEnd), 'latin1'), raw: body });
  }
  return objs;
}

function streamOf(objs, num) {
  const o = objs.get(num);
  if (!o || !o.stream) return null;
  if (/\/Filter\s*\/FlateDecode/.test(o.dict) || /\/Filter\s*\[\s*\/FlateDecode/.test(o.dict)) {
    const out = inflate(o.stream);
    return out || o.stream;
  }
  return o.stream;
}

/** 展开对象流：/Type /ObjStm 里压缩着若干普通对象 */
function expandObjectStreams(objs) {
  for (const [, o] of [...objs]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict)) continue;
    const data = streamOf(objs, [...objs.entries()].find(([, v]) => v === o)?.[0]);
    if (!data) continue;
    const n = Number((/\/N\s+(\d+)/.exec(o.dict) || [])[1] || 0);
    const first = Number((/\/First\s+(\d+)/.exec(o.dict) || [])[1] || 0);
    if (!n || !first) continue;
    const head = data.subarray(0, first).toString('latin1').trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const objNum = head[i * 2];
      const off = head[i * 2 + 1];
      if (!Number.isFinite(objNum) || !Number.isFinite(off)) continue;
      const nextOff = i + 1 < n ? head[(i + 1) * 2 + 1] : data.length - first;
      const text = data.subarray(first + off, first + nextOff).toString('latin1');
      if (!objs.has(objNum)) objs.set(objNum, { dict: text, stream: null, raw: text });
    }
  }
}

/* ---------------------------------------------------------------- 页面树 */

function buildPageList(objs) {
  // 建立 parent 关系，用于继承 /Resources
  const parentOf = new Map();
  for (const [num, o] of objs) {
    if (!/\/Type\s*\/Pages/.test(o.dict)) continue;
    for (const kid of dictRefs(o.dict, 'Kids')) parentOf.set(kid, num);
  }

  const rootCandidates = [...objs.entries()].filter(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  const pages = [];

  const walk = (num, depth = 0) => {
    if (depth > 24 || pages.length > 5000) return;
    const o = objs.get(num);
    if (!o) return;
    if (/\/Type\s*\/Pages/.test(o.dict)) {
      for (const kid of dictRefs(o.dict, 'Kids')) walk(kid, depth + 1);
      return;
    }
    if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(num);
  };

  for (const [, cat] of rootCandidates) {
    const pagesRef = dictRef(cat.dict, 'Pages');
    if (pagesRef) walk(pagesRef);
    if (pages.length) break;
  }

  // 兜底：没有 Catalog 时按对象号排序
  if (!pages.length) {
    for (const [num, o] of [...objs].sort((a, b) => a[0] - b[0])) {
      if (/\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) pages.push(num);
    }
  }

  return { pages, parentOf };
}

function inheritedResources(objs, parentOf, pageNum) {
  let cur = pageNum;
  for (let i = 0; i < 12 && cur != null; i++) {
    const o = objs.get(cur);
    if (!o) break;
    const r = dictRef(o.dict, 'Resources');
    if (r) return r;
    if (/\/Resources\s*<</.test(o.dict)) return { inline: cur };
    cur = parentOf.get(cur);
  }
  return null;
}

/* ---------------------------------------------------------------- ToUnicode */

function hexToStr(hex) {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  }
  if (clean.length % 4 === 2) out += String.fromCharCode(parseInt(clean.slice(-2), 16));
  return out;
}

function parseCMap(text) {
  const map = new Map();
  let codeBytes = 0;

  const space = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (space) {
    const m = /<([0-9a-fA-F]+)>/.exec(space[1]);
    if (m) codeBytes = Math.ceil(m[1].length / 2);
  }

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      map.set(m[1].toUpperCase(), hexToStr(m[2]));
      if (!codeBytes) codeBytes = Math.ceil(m[1].length / 2);
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([\s\S]*?)\])/g;
    for (const m of block[1].matchAll(re)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi < lo || hi - lo > 65535) continue;
      if (!codeBytes) codeBytes = Math.ceil(m[1].length / 2);
      if (m[3] != null) {
        const base = parseInt(m[3], 16);
        for (let c = lo; c <= hi; c++) {
          const code = c.toString(16).toUpperCase().padStart(m[1].length, '0');
          map.set(code, String.fromCharCode(base + (c - lo)));
        }
      } else if (m[4]) {
        const items = [...m[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        items.forEach((hex, i) => {
          const code = (lo + i).toString(16).toUpperCase().padStart(m[1].length, '0');
          map.set(code, hexToStr(hex));
        });
      }
    }
  }

  return { map, codeBytes: codeBytes || 1 };
}

function fontDecoder(objs, fontNum) {
  const o = objs.get(fontNum);
  if (!o) return (bytes) => bytes.toString('latin1');

  const cmapRef = dictRef(o.dict, 'ToUnicode');
  let cmap = null;
  if (cmapRef != null) {
    const data = streamOf(objs, cmapRef);
    if (data) cmap = parseCMap(data.toString('latin1'));
  }

  const isCid = /\/Subtype\s*\/Type0/.test(o.dict) || /Identity-[HV]/.test(o.dict);
  const bytesPerCode = cmap?.codeBytes || (isCid ? 2 : 1);

  // 预定义 CMap（UniGB-UTF16-H / UniCNS-UTF16-H / UniJIS-UTF16-H …）本身就是
  // UTF-16BE 编码，字符码即 Unicode，没有 ToUnicode 也能还原。
  // 中文 PDF 用这套编码的很多（含 PyMuPDF 等工具生成的文字层）。
  const encName = (/\/Encoding\s*\/([A-Za-z0-9_-]+)/.exec(o.dict) || [])[1] || '';
  const utf16Cmap = /^Uni[A-Z]{2,4}\d*-(UTF16|UCS2)-[HV]$/.test(encName);

  return (bytes) => {
    let out = '';
    for (let i = 0; i + bytesPerCode <= bytes.length; i += bytesPerCode) {
      const hex = bytes
        .subarray(i, i + bytesPerCode)
        .toString('hex')
        .toUpperCase();
      const mapped = cmap?.map.get(hex);
      if (mapped != null) {
        out += mapped;
        continue;
      }
      if (utf16Cmap && bytesPerCode === 2) {
        const cu = (bytes[i] << 8) | bytes[i + 1];
        // 代理对：UTF-16 里 U+D800..U+DBFF 需要和下一个码元拼成一个字符
        if (cu >= 0xd800 && cu <= 0xdbff && i + 3 < bytes.length) {
          const lo = (bytes[i + 2] << 8) | bytes[i + 3];
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            out += String.fromCodePoint(0x10000 + ((cu - 0xd800) << 10) + (lo - 0xdc00));
            i += 2;
            continue;
          }
        }
        if (cu !== 0) out += String.fromCharCode(cu);
        continue;
      }
      // 没有 ToUnicode 时，简单字体按单字节直出；CID 无法还原，跳过
      if (bytesPerCode === 1) {
        const code = bytes[i];
        if (code >= 32 || code === 10 || code === 9) out += String.fromCharCode(code);
      }
    }
    return out;
  };
}

/* ---------------------------------------------------------------- 词法分析 */

const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;

  const readLiteral = () => {
    // 已位于 '(' 之后
    let depth = 1;
    let s = '';
    while (i < n) {
      const ch = src[i];
      if (ch === '\\') {
        const nx = src[i + 1];
        i += 2;
        if (nx === 'n') s += '\n';
        else if (nx === 'r') s += '\r';
        else if (nx === 't') s += '\t';
        else if (nx === 'b') s += '\b';
        else if (nx === 'f') s += '\f';
        else if (nx === '\n') {
          /* 续行 */
        } else if (/[0-7]/.test(nx || '')) {
          let oct = nx;
          while (oct.length < 3 && /[0-7]/.test(src[i] || '')) oct += src[i++];
          s += String.fromCharCode(parseInt(oct, 8));
        } else s += nx ?? '';
        continue;
      }
      if (ch === '(') {
        depth += 1;
        s += ch;
        i += 1;
        continue;
      }
      if (ch === ')') {
        depth -= 1;
        i += 1;
        if (!depth) break;
        s += ch;
        continue;
      }
      s += ch;
      i += 1;
    }
    return s;
  };

  while (i < n) {
    const ch = src[i];

    if (ch === '%') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      i += 1;
      out.push({ t: 'str', v: readLiteral() });
      continue;
    }
    if (ch === '<' && src[i + 1] === '<') {
      i += 2;
      out.push({ t: 'dict' });
      continue;
    }
    if (ch === '>' && src[i + 1] === '>') {
      i += 2;
      out.push({ t: 'dictEnd' });
      continue;
    }
    if (ch === '<') {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end < 0 ? n : end).replace(/[^0-9a-fA-F]/g, '');
      i = end < 0 ? n : end + 1;
      const bytes = Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex');
      out.push({ t: 'str', v: bytes.toString('latin1'), bytes });
      continue;
    }
    if (ch === '[') {
      i += 1;
      out.push({ t: 'arrStart' });
      continue;
    }
    if (ch === ']') {
      i += 1;
      out.push({ t: 'arrEnd' });
      continue;
    }
    if (ch === '/') {
      let j = i + 1;
      while (j < n && !/\s/.test(src[j]) && !DELIM.has(src[j])) j += 1;
      out.push({ t: 'name', v: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (/[-+.\d]/.test(ch)) {
      let j = i;
      while (j < n && /[-+.\d]/.test(src[j])) j += 1;
      const v = Number(src.slice(i, j));
      out.push({ t: 'num', v: Number.isFinite(v) ? v : 0 });
      i = j;
      continue;
    }

    let j = i;
    while (j < n && !/\s/.test(src[j]) && !DELIM.has(src[j])) j += 1;
    if (j === i) {
      i += 1;
      continue;
    }
    out.push({ t: 'op', v: src.slice(i, j) });
    i = j;
  }
  return out;
}

/* ---------------------------------------------------------------- 内容流解释 */

const CJK = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;

function interpretContent(tokens, fontMap, sink) {
  let curFont = null;
  let lastY = null;
  let lastX = null;
  let pendingSpace = false;

  const emit = (text) => {
    if (!text) return;
    sink.push(pendingSpace ? ` ${text}` : text);
    pendingSpace = false;
  };

  const newlineIfMoved = (x, y) => {
    if (lastY != null && Math.abs(y - lastY) > 2) {
      sink.push('\n');
      pendingSpace = false;
    } else if (lastX != null && x - lastX > 6) {
      // 同一行内的较大水平跳距，补一个空格
      pendingSpace = true;
    }
    lastX = x;
    lastY = y;
  };

  const decode = (tok) => {
    const bytes = tok.bytes || Buffer.from(tok.v || '', 'latin1');
    const fn = curFont ? fontMap.get(curFont) : null;
    return fn ? fn(bytes) : bytes.toString('latin1');
  };

  const stack = [];
  let arr = null;
  let tx = 0;
  let ty = 0;
  let leading = 0;

  for (const tok of tokens) {
    if (tok.t === 'arrStart') {
      arr = [];
      continue;
    }
    if (tok.t === 'arrEnd') {
      stack.push({ t: 'arr', v: arr || [] });
      arr = null;
      continue;
    }
    if (arr) {
      arr.push(tok);
      continue;
    }
    if (tok.t !== 'op') {
      stack.push(tok);
      if (stack.length > 32) stack.shift();
      continue;
    }

    const op = tok.v;
    switch (op) {
      case 'Tf': {
        const nameTok = stack[stack.length - 2];
        if (nameTok?.t === 'name') curFont = nameTok.v;
        break;
      }
      case 'Td':
      case 'TD': {
        const dx = stack[stack.length - 2]?.v ?? 0;
        const dy = stack[stack.length - 1]?.v ?? 0;
        tx += dx;
        ty += dy;
        if (op === 'TD') leading = -dy;
        newlineIfMoved(tx, ty);
        break;
      }
      case 'Tm': {
        const a = stack.slice(-6);
        if (a.length === 6) {
          tx = a[4].v ?? 0;
          ty = a[5].v ?? 0;
          newlineIfMoved(tx, ty);
        }
        break;
      }
      case 'TL': {
        leading = stack[stack.length - 1]?.v ?? 0;
        break;
      }
      case 'T*': {
        ty -= leading || 12;
        newlineIfMoved(tx, ty);
        break;
      }
      case 'Tj': {
        const s = stack[stack.length - 1];
        if (s?.t === 'str') emit(decode(s));
        break;
      }
      case "'": {
        ty -= leading || 12;
        newlineIfMoved(tx, ty);
        const s = stack[stack.length - 1];
        if (s?.t === 'str') emit(decode(s));
        break;
      }
      case '"': {
        ty -= leading || 12;
        newlineIfMoved(tx, ty);
        const s = stack[stack.length - 1];
        if (s?.t === 'str') emit(decode(s));
        break;
      }
      case 'TJ': {
        const a = stack[stack.length - 1];
        if (a?.t === 'arr') {
          let buf = '';
          for (const item of a.v) {
            if (item.t === 'str') buf += decode(item);
            // 负字距达到 0.18 em 以上视为词间空格（LaTeX 常见 -250）
            else if (item.t === 'num' && item.v <= -180) buf += ' ';
          }
          emit(buf);
        }
        break;
      }
      case 'ET':
        break;
      default:
        break;
    }
    if (op !== 'Tf') stack.length = 0;
    else stack.length = 0;
  }
}

/* ---------------------------------------------------------------- 主流程 */

// 中文 PDF 常逐字定位，字与字之间会被判成空格；这里按「两侧都是全角字符 / 数字」归并
const TIGHT = '\\u3000-\\u303f\\u3400-\\u9fff\\uff00-\\uffef0-9\\u2000-\\u206f';
const TIGHT_RE = new RegExp(`(?<=[${TIGHT}])[ \\t]+(?=[${TIGHT}])`, 'g');

function normalizeText(s) {
  let out = s
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');

  // 反复归并，处理「国 色 新 韵」这类连续单字间距
  for (let i = 0; i < 4; i++) {
    const next = out.replace(TIGHT_RE, '');
    if (next === out) break;
    out = next;
  }
  // 小数点、千分位两侧不应有空格（「3 . 1」→「3.1」）
  out = out.replace(/(\d)\s*\.\s*(?=\d)/g, '$1.');
  return out.trim();
}

export function extractPdf(buffer) {
  const raw = buffer.toString('latin1');
  const objs = parseObjects(raw);
  expandObjectStreams(objs);

  const { pages, parentOf } = buildPageList(objs);
  const out = [];
  const sourceMap=[];let outputLength=0;

  for (const [pageIndex,pageNum] of pages.entries()) {
    const page = objs.get(pageNum);
    if (!page) continue;

    // 字体表
    const fontMap = new Map();
    const resRef = inheritedResources(objs, parentOf, pageNum);
    let fontDictText = '';
    if (typeof resRef === 'number') {
      const res = objs.get(resRef);
      if (res) {
        const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(res.dict);
        if (inline) fontDictText = inline[1];
        else {
          const fd = dictRef(res.dict, 'Font');
          if (fd != null) fontDictText = objs.get(fd)?.dict || '';
        }
      }
    } else if (resRef?.inline != null) {
      const inline = /\/Font\s*<<([\s\S]*?)>>/.exec(objs.get(resRef.inline)?.dict || '');
      if (inline) fontDictText = inline[1];
    }
    for (const m of fontDictText.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      fontMap.set(m[1], fontDecoder(objs, Number(m[2])));
    }

    // 内容流
    let contents = dictRefs(page.dict, 'Contents');
    if (!contents.length) {
      const single = dictRef(page.dict, 'Contents');
      if (single != null) contents = [single];
    }

    const sink = [];
    for (const cRef of contents) {
      const data = streamOf(objs, cRef);
      if (!data) continue;
      interpretContent(tokenize(data.toString('latin1')), fontMap, sink);
    }

    const text = normalizeText(sink.join(''));
    if (text) {
      if(out.length)outputLength+=2;
      sourceMap.push({page:pageIndex+1,pageIndex,start:outputLength,end:outputLength+text.length,type:'page'});
      out.push(text);outputLength+=text.length;
    }
  }

  return {
    text: out.join('\n\n'),
    pages: pages.length, // 总页数
    textPages: out.length, // 有文字层的页数（扫描件为 0）
    kind: 'pdf',
    sourceMap,
  };
}

export const __test = { tokenize, parseCMap };
