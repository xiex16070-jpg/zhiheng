/** Deterministic, archived projections for small local contexts. No summarizer or new authority. */
import { createHash } from 'node:crypto';
import { assertCompleteToolPairs, localQwenBudget } from './local-qwen.mjs';

const fits = status => status.tokens + status.completionTokens <= status.budget;
const READ_ONLY_SOURCES = new Set(['search_knowledge', 'read_source']);

export async function compactLocalContext({ messages, provider, tools = [], signal, measure = localQwenBudget }) {
  // Validate the unmodified transcript before projection so hostile control tokens
  // cannot disappear into an archive and bypass the tokenizer's input guard.
  if (/<\|(?:im_start|im_end|endoftext)\|>/.test(JSON.stringify(messages))) throw new Error('local_qwen_input_control_token');
  assertCompleteToolPairs(messages);
  let next = messages, status = await measure({ provider, messages: next, tools, signal, allowOverflow: true });
  const originalTokens = status.tokens, archives = [];
  if (fits(status)) return { messages, status, fits: true, compacted: false, archives };
  const calls = new Map(messages.flatMap(m => m.tool_calls || []).map(call => [call.id, call.function?.name]));
  const latest = messages.findLastIndex(m => m.role === 'tool');
  // Keep the latest tool observation verbatim. Never touch user/system text,
  // tool arguments, approval outcomes, errors, code or arbitrary plugin results.
  for (let index = 0; index < latest && !fits(status); index++) {
    signal?.throwIfAborted();
    const original = next[index];
    if (original.role !== 'tool' || original._toolError || original._compacted || !READ_ONLY_SOURCES.has(calls.get(original.tool_call_id))) continue;
    let body;
    try { body = JSON.parse(original.content); } catch { continue; }
    if (!Array.isArray(body?.sources) || !body.sources.length || body.sources.some(s =>
      !s || typeof s !== 'object' || !/^S\d+$/.test(s.ref) || typeof s.excerpt !== 'string' ||
      !Number.isInteger(s.excerptStart) || !Number.isInteger(s.excerptEnd) || s.excerptStart < 0 || s.excerptEnd < s.excerptStart)) continue;
    // Offsets describe text no longer in this projection; retain them in the
    // archive, not as dangling evidence. Identity/authority still travel together.
    const projection = { ...(typeof body.weak === 'boolean' ? { weak: body.weak } : {}),
      sources: body.sources.map(source => Object.fromEntries(['ref', 'title', 'type', 'level', 'date', 'reviewVerified']
        .filter(key => source[key] !== undefined).map(key => [key, source[key]]))), excerptsOmitted: true,
      ...(body.omittedRefs ? { omittedRefs: body.omittedRefs } : {}),
      notice: '旧摘录已归档；需原句用 read_source(ref)。省略不代表无证据。' };
    const content = JSON.stringify(projection);
    if (content.length >= original.content.length) continue;
    const proposed = next.map((m, i) => i === index ? { ...m, content, _compacted: true } : m);
    const measured = await measure({ provider, messages: proposed, tools, signal, allowOverflow: true });
    if (measured.tokens >= status.tokens) continue;
    archives.push({ messageIndex: index, toolCallId: original.tool_call_id,
      sha256: createHash('sha256').update(original.content).digest('hex'), original: structuredClone(original),
      policy: 'archived-source-excerpts/1', beforeTokens: status.tokens, afterTokens: measured.tokens });
    next = proposed; status = measured;
  }
  assertCompleteToolPairs(next);
  return { messages: next, status: { ...status, ...(archives.length ? { compacted: true, originalTokens, archivedMessages: archives.length } : {}) },
    fits: fits(status), compacted: archives.length > 0, archives };
}
