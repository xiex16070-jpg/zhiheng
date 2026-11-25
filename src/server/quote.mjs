/**
 * Locate a quote after harmless typography/whitespace normalization while
 * preserving offsets into the original source text.
 */

const SKIP = /[\s`*_>#|]/u;
const QUOTE_MARK = /[「」『』“”"'‘’]/u;

function canonicalWithMap(value) {
  const source = String(value || '');
  let text = '';
  const starts = [];
  const ends = [];

  for (let i = 0; i < source.length; ) {
    const point = source.codePointAt(i);
    const original = String.fromCodePoint(point);
    const end = i + original.length;
    let normalized = original.replace(/[\u00a0\u3000]/gu, ' ').toLowerCase();
    if (QUOTE_MARK.test(normalized)) normalized = '"';

    for (const ch of normalized) {
      if (SKIP.test(ch)) continue;
      text += ch;
      // indexOf reports UTF-16 offsets, including both code units of astral characters.
      for (let unit = 0; unit < ch.length; unit++) { starts.push(i); ends.push(end); }
    }
    i = end;
  }

  return { source, text, starts, ends };
}

/**
 * Returns offsets in `source`, never offsets in the normalized copy.
 * The returned quote is the exact source substring so callers cannot present a
 * normalized or model-supplied string as a verbatim quotation.
 */
export function locateNormalizedQuote(source, quote, { minLength = 4 } = {}) {
  const haystack = String(source || '');
  const requested = String(quote || '').trim();
  if (!requested) return { found: false, reason: 'quote_too_short' };
  const target = canonicalWithMap(requested).text;
  if (target.length < minLength) return { found: false, reason: 'quote_too_short' };

  const exact = haystack.indexOf(requested);
  if (exact >= 0) {
    return {
      found: true,
      start: exact,
      end: exact + requested.length,
      quote: haystack.slice(exact, exact + requested.length),
    };
  }

  const mapped = canonicalWithMap(haystack);
  const at = mapped.text.indexOf(target);
  if (at < 0) return { found: false, reason: 'not_verbatim' };

  const start = mapped.starts[at];
  const end = mapped.ends[at + target.length - 1];
  return { found: true, start, end, quote: haystack.slice(start, end) };
}

// Mask code without moving offsets. An ambiguous/unclosed code span is skipped
// conservatively through the paragraph rather than attributed to a source.
function proseOnly(body) {
  let fence = '', inline = 0;
  const mask = str => '\0'.repeat(str.length);
  return body.split('\n').map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return mask(line);
    }
    if (marker) { fence = marker[1]; inline = 0; return mask(line); }
    if (!line.trim()) { inline = 0; return line; }
    if (/^(?: {4}|\t|\s*>)/u.test(line)) return mask(line);
    let start = 0, output = '';
    for (const match of line.matchAll(/`+/g)) {
      const part = line.slice(start, match.index);
      output += (inline ? mask(part) : part) + mask(match[0]);
      if (!inline) inline = match[0].length;
      else if (inline === match[0].length) inline = 0;
      start = match.index + match[0].length;
    }
    const tail = line.slice(start);
    return output + (inline ? mask(tail) : tail);
  }).join('\n');
}

const reference = String.raw`\[\[[ \t]*([A-Za-z0-9][A-Za-z0-9_-]{0,63})[ \t]*\]\]`;
const cluster = `(?:${reference})(?:[ \\t、,，]*(?:${reference}))*`;
const prefixRefs = new RegExp(`(${cluster})[ \\t]*(?:的)?(中|中(?:的原文)?(?:写道|指出|明确写道|称)|原文(?:写道|指出|称)|写道|指出)[ \\t]*[：:]?[ \\t]*$`, 'u');
const suffixRefs = new RegExp(`^[ \\t]*(${cluster})`, 'u');
const attribution = /(?:原文|文中|作者|论文|教材|文献|材料)(?:明确|直接)?(?:写道|指出|记载|表述为|称|说)[ \t]*[：:]?[ \t]*$/u;
const quotedText = /“([^“”\n\0]{6,400})”|‘([^‘’\n\0]{6,400})’|「([^「」\n\0]{6,400})」|『([^『』\n\0]{6,400})』|"([^"\n\0]{6,400})"|'([^'\n\0]{6,400})'/gu;
const refsOf = text => [...new Set(Array.from(text.matchAll(new RegExp(reference, 'gu')), m => m[1]))];

/** Check explicit, single-line source-attributed quotations in a finished research answer. */
export function auditAttributedQuotes(body, evidence) {
  const scanned = proseOnly(body.slice(0, 65536));
  const checks = [];
  let limited = body.length > scanned.length, calls = 0, remaining = 128 * 1024;
  for (const m of scanned.matchAll(quotedText)) {
    const quote = m[0].slice(1, -1);
    const before = scanned.slice(Math.max(0, m.index - 600), m.index);
    const after = scanned.slice(m.index + m[0].length, m.index + m[0].length + 600);
    const prefix = prefixRefs.exec(before), suffix = suffixRefs.exec(after);
    if (!prefix && !(suffix && attribution.test(before))) continue;
    // Bare “source 中” often names a term rather than quoting a statement.
    if (prefix?.at(-1) === '中' && !/[，。！？；]|是|可以|能够|必须|需要|并非|等于|意味着|不存在/u.test(quote)) continue;
    const refs = refsOf(prefix ? prefix[1] : suffix[1]);
    if (prefix && suffix && refsOf(suffix[1]).some(ref => !refs.includes(ref))) continue;
    if (checks.length >= 12 || calls >= 36 || remaining < 1) { limited = true; break; }
    if (refs.length > 4) { limited = true; continue; }
    const check = { quote, start: m.index + 1, end: m.index + m[0].length - 1, refs, status: 'unmatched' };
    let incomplete = false;
    for (const ref of refs) {
      const item = evidence.get(ref);
      const fields = ['content', 'snippet'].filter(field => typeof item?.[field] === 'string' && item[field].length);
      if (!fields.length) incomplete = true;
      for (const field of fields) {
        if (field === 'snippet' && item.content?.slice(0, 16384).includes(item.snippet)) continue;
        const source = item[field].slice(0, Math.min(16384, remaining));
        if (!source || calls >= 36) { incomplete = true; limited = true; break; }
        if (source.length < item[field].length) { incomplete = true; limited = true; }
        calls++; remaining -= source.length;
        const match = locateNormalizedQuote(source, quote, { minLength: 6 });
        if (!match.found) continue;
        check.status = match.quote === quote ? 'exact' : 'normalized';
        check.match = { ref, field, start: match.start, end: match.end };
        break;
      }
      if (check.match) break;
    }
    if (!check.match && incomplete) check.status = 'unchecked';
    checks.push(check);
  }
  return { version: 1, scope: 'attributed_quotes_in_retrieved_text', checks, limited };
}
