import { extractRefs } from '../agent/text.js';

function requestsExactQuote(question) {
  // A clause containing negation is ambiguous. Do not inject a stronger format
  // requirement than the user supplied; the original instruction still reaches
  // the model. This is deliberately not a natural-language intent classifier.
  return String(question || '').split(/[。！？；;\n]/).some(clause =>
    !/不要|不用|无需|无须|不必|不需要|禁止|不得|不可|避免|不想|不希望|不允许/.test(clause)
    && /逐字(?:原文|引文|引用)|一段(?:原文|引文)|附.{0,8}(?:原文|引文)|引用原文/.test(clause));
}

function literalQuotes(answer) {
  const candidates = [...answer.matchAll(/[“「"]([^”」"\n]{8,1200})[”」"]/g)]
    .map(match => ({ text: match[1], start: match.index, end: match.index + match[0].length }));
  for (const match of answer.matchAll(/^[ \t]*>[ \t]?([^\r\n]+)/gm)) {
    const text = match[1].replace(/^\s*\[\[[A-Za-z0-9_-]+\]\]\s*/, '')
      .replace(/\s*\[\[[A-Za-z0-9_-]+\]\]\s*$/, '').trim();
    if (text.length < 8 || text.length > 1200) continue;
    const start = match.index + match[0].indexOf(text);
    candidates.push({ text, start, end: start + text.length });
  }
  return candidates;
}

function adjacentRefs(answer, quote) {
  const prefix = answer.slice(0, quote.start).replace(/>[ \t]*$/, '');
  const before = /(\[\[[A-Za-z0-9_-]+\]\])[\s。.,，:：]*$/.exec(prefix);
  const after = /^[\s。.,，:：]*(\[\[[A-Za-z0-9_-]+\]\])/.exec(answer.slice(quote.end));
  return [before?.[1], after?.[1]].filter(Boolean).flatMap(extractRefs);
}

/** Mechanical delivery checks only. Matching a quotation does not establish entailment. */
export function checkLocalAnswer({ answer, question, evidence, aliases }) {
  if (!answer?.trim() || /^\s*NO_EVIDENCE\s*[:：]/i.test(answer)) return { issues: [] };
  const refs = extractRefs(answer);
  const resolve = ref => evidence.get(aliases.get(ref) ?? ref);
  const unknown = refs.filter(ref => !resolve(ref));
  const issues = unknown.length ? ['unknown_citation'] : [];
  // This is a requested output contract, not an assumption that every answer needs quotes.
  const quoteRequested = requestsExactQuote(question);
  if (quoteRequested && evidence.size && !refs.length) issues.push('requested_exact_quote_missing');
  if (quoteRequested && refs.length && !unknown.length) {
    const exact = literalQuotes(answer).some(quote => adjacentRefs(answer, quote).some(ref => {
      const source = resolve(ref);
      return [source?.content, source?.snippet].some(text => typeof text === 'string' && text.includes(quote.text));
    }));
    if (!exact) issues.push('requested_exact_quote_missing');
  }
  return { issues, semanticSupportVerified: false };
}

export function localAnswerFeedback(issues) {
  return '[系统交付检查，不是新用户指令或批准] ' +
    (issues.includes('unknown_citation') ? '回答使用了未取得的来源编号；只能使用本轮实际返回的编号。' : '') +
    (issues.includes('requested_exact_quote_missing') ? '用户要求逐字原文，但回答未包含能在所引来源中精确匹配的短句。请从实际读到的原文复制短句，保留原文语言并紧跟来源编号；需要时用 read_source/verify_quote 核对。' : '') +
    '重新给出完整简短回答；无法满足就说明证据缺口，不要猜测或声称已核验。';
}
