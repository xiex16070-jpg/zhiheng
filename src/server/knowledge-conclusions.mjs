/** Derived knowledge is an index to evidence, never an independent source of facts.
 * Hermes: bounded incremental learning, read-before-write, owner isolation, reversible
 * state transitions, source hygiene, and an independent record of model opinions.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { getStore } from './store.mjs';
import { getChunkSnapshot, listDocuments, listSections } from './kb.mjs';
import { onKnowledgeSourceChange } from './kb-events.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';
import { threatScan } from './memory.mjs';
import { tokenize } from '../agent/text.js';

const USER = /^[a-zA-Z0-9_-]{1,64}$/;
const STATES = new Set(['candidate', 'verified', 'invalidated', 'withdrawn', 'quarantined']);
const MAX_ENTRIES = 256, DAY = 86400000, MAX_SOURCE_CHARS = 1600;
const sha = value => createHash('sha256').update(String(value)).digest('hex');
const iso = () => new Date().toISOString();
const cleanClaim = value => String(value || '').replace(/\[\[[^\]]+\]\]/g, '').replace(/^\s*(?:[-*>]|#{1,6}|\d+[.)、])\s*/g, '').trim();
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const location = userId => {
  if (!USER.test(String(userId || ''))) throw fail('invalid_user', '用户身份无效。', 403);
  return path.join(config.dataDir, 'knowledge', userId + '.json');
};
const empty = () => ({ version: 1, entries: [], audit: [], processedTasks: [], maintenance: {} });
const bounded = (n, fallback, max) => Math.max(1, Math.min(max, Number.isFinite(Number(n)) ? Math.floor(Number(n)) : fallback));

async function readState(userId) {
  const file = location(userId);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw fail('knowledge_unreadable', '结论库无法安全读取，原始文件已保留。', 409);
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES ||
        !Array.isArray(value.audit) || !Array.isArray(value.processedTasks) ||
        value.entries.some(e => !e || typeof e.claim !== 'string' || e.claim.length > 700 || !STATES.has(e.status) || !Array.isArray(e.sources) || e.sources.length > 4)) {
      throw fail('knowledge_unreadable', '结论库结构异常，未覆盖原始文件。', 409);
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    if (error.code === 'knowledge_unreadable') throw error;
    throw fail('knowledge_unreadable', '结论库读取失败，原始文件已保留。', 409);
  }
}
async function writeState(userId, state) {
  state.audit = state.audit.slice(-300);
  state.processedTasks = state.processedTasks.slice(-512);
  await writeJsonAtomic(location(userId), state, { mode: 0o600 });
}
function record(state, entry, action, reason, actor = 'maintenance') {
  entry.revision = (entry.revision || 0) + 1; entry.updatedAt = iso();
  state.audit.push({ at: entry.updatedAt, id: entry.id, revision: entry.revision, action, reason, actor, status: entry.status });
}

/** Conservative screening: suspicious academic quotations are withheld too, not silently trusted.
 * Legal texts (§) and code documentation (eval(, process.env) are ordinary source material here. */
export function conclusionThreat(text) {
  return threatScan(text, { separator: false, codeShapes: false }) || (/\b(?:sk-[a-zA-Z0-9_-]{16,}|tvly-[a-zA-Z0-9_-]{16,})\b/.test(text) ? 'credential' : null) ||
    (/[\u2066-\u2069\u{E0000}-\u{E007F}]/u.test(text) ? 'invisible_unicode' : null) ||
    (/\b(?:system|developer|assistant)\s*:\s*(?:ignore|execute|reveal|send)|(?:绕过|跳过|禁用).{0,8}(?:审批|鉴权|安全检查)|(?:泄露|发送|上传).{0,12}(?:密钥|密码|令牌)/iu.test(text) ? 'instruction_or_exfiltration' : null);
}

/** The quote that best matches the claim, not the chunk's first 240 characters:
 * a later source check then proves the supporting sentence itself is unchanged. */
export function supportingQuote(chunkText, claim) {
  const text = String(chunkText || '');
  const wanted = termsOf(claim);
  let best = null;
  for (const match of text.matchAll(/[^。！？；!?;\r\n]+[。！？；!?;]?/g)) {
    const sentence = match[0].trim();
    if (sentence.length < 8) continue;
    const terms = termsOf(sentence);
    const shared = [...terms].filter(t => wanted.has(t)).length;
    // Most shared terms wins; the shorter sentence breaks ties.
    if (!best || shared > best.shared || (shared === best.shared && sentence.length < best.sentence.length)) best = { shared, sentence };
  }
  const quote = (best?.shared > 0 ? best.sentence : text.trim()).slice(0, 240).trim();
  return text.includes(quote) ? quote : text.slice(0, 240).trim();
}
const termsOf = text => new Set(tokenize(text).map(t => t.term));
function similarity(a, b) {
  const x = termsOf(a), y = termsOf(b);
  const shared = [...x].filter(t => y.has(t)).length;
  return shared / Math.max(1, x.size + y.size - shared);
}
const ACTIVE = new Set(['candidate', 'verified']);
const INACTIVE = new Set(['invalidated', 'withdrawn', 'quarantined']);
const humanConfirmed = entry => entry.status === 'verified' && entry.confirmation?.actor === 'user';
const sourceSignature = sources => JSON.stringify(sources.map(s => [s.ref,s.sourceVersion]).sort((a,b)=>a[0].localeCompare(b[0])));
const overridden = entry => entry.threatOverride?.claimHash === sha(entry.claim) && entry.threatOverride.sourceSignature === sourceSignature(entry.sources);
// Negation, quantities and direction operators must never disappear through
// token stopwords while deciding whether two claims can share one record.
const critical = text => JSON.stringify(String(text).normalize('NFKC').toLowerCase().match(/不|无|非|未|仅|只|所有|有些|全部|至少|至多|超过|低于|高于|若|则|如果|只有|\d+(?:\.\d+)?%?|\b[a-z][\w]*\b|[¬∧∨→↔∀∃]|->|<-/g) || []);

async function taskSnapshot(userId, taskId) {
  const store = getStore(), task = await store.getTask(taskId);
  if (!task || task.userId !== userId || task.status !== 'completed' || task.checkpoint?.rewoundAt || !task.result?.body || task.result.truncated) return null;
  const conversation = await store.getConversation(task.conversationId);
  if (!conversation || conversation.userId !== userId) return null;
  return { task, conversation, bodyHash: sha(task.result.body) };
}
/** reviewer:true is the learning-model snapshot path: a user's release of a
 * quarantined entry lets the user verify it, but suspicious source text is
 * still withheld from the model prompt (withheld:true leaves status unchanged). */
async function checkEntry(userId, entry, { reviewer = false } = {}) {
  const released = overridden(entry);
  const problem = conclusionThreat(entry.claim);
  if (problem && (!released || reviewer)) return { ok: false, toxic: !released, withheld: released, reason: problem, chunks: [] };
  const origin = await taskSnapshot(userId, entry.origin.taskId);
  if (!origin || origin.bodyHash !== entry.origin.answerHash) return { ok: false, reason: 'dialogue_unavailable_or_changed', chunks: [] };
  const chunks = [];
  for (const source of entry.sources) {
    const chunk = await getChunkSnapshot(source.ref, userId);
    if (!chunk || chunk.docId !== source.docId) return { ok: false, reason: 'source_removed', chunks: [] };
    const toxic = conclusionThreat(chunk.text) || conclusionThreat(source.quote);
    if (toxic && (!released || reviewer)) return { ok: false, toxic: !released, withheld: released, reason: toxic, chunks: [] };
    if (source.sourceVersion !== chunk.sourceVersion || !chunk.text.includes(source.quote)) return { ok: false, reason: 'source_changed', chunks: [] };
    chunks.push(chunk);
  }
  return { ok: chunks.length > 0, reason: chunks.length ? 'sources_current' : 'sources_missing', chunks };
}
function updateCheck(state, entry, check, actor = 'maintenance') {
  if (check.withheld) return;
  const previous = entry.status;
  if (!check.ok) entry.status = check.toxic ? 'quarantined' : 'invalidated';
  entry.sourceCheck = { status: check.ok ? 'current' : check.toxic ? 'quarantined' : 'invalid', reason: check.reason, at: iso() };
  entry.nextReviewAt = new Date(Date.now() + DAY).toISOString();
  if (entry.status !== previous) record(state, entry, 'downgrade', check.reason, actor);
}
const publicEntry = entry => ({ ...entry, origin: { ...entry.origin },
  ...(entry.status === 'quarantined' ? { claim: '此条目包含可疑指令或敏感内容，已隔离。', sources: entry.sources.map(s => ({ ...s, quote: '[隔离内容不展示]' })) } : {}),
  trust: '对话确认与模型支持意见均不等于事实证明；引用使用当前原文。' });

/** Extract at most three cited paragraphs from a durable, owned completed turn. */
export async function captureTaskConclusions({ userId, taskId, answerProvider }) {
  const file = location(userId);
  const prefs = await getStore().getPreferences(userId);
  if (!config.learning.enabled || prefs?.learning === 'off' || prefs?.knowledgeEnabled === false) return { added: 0, skipped: 'learning_disabled' };
  const origin = await taskSnapshot(userId, taskId);
  if (!origin) return { added: 0, skipped: 'completed_owned_dialogue_required' };
  const result = origin.task.result;
  if (result.noEvidence || result.uncited || result.unverified?.length || result.inferenceStats?.fail > 0) return { added: 0, skipped: 'unverified_answer' };
  const allowed = new Map((result.citations || []).filter(c => c.kind === 'doc').map(c => [String(c.ref || c.id), c]));
  if (!allowed.size) return { added: 0, skipped: 'no_local_citations' };
  const proposals = [];
  // Keep a cited paragraph intact: sentence splitting before trailing [[ref]] loses the claim.
  for (const paragraph of String(result.body).slice(0, 24000).split(/\n+/)) {
    const refs = [...new Set([...paragraph.matchAll(/\[\[([^\]\r\n]{1,100})\]\]/g)].map(m => m[1]))];
    if (!refs.length || refs.length > 4 || refs.some(ref => !allowed.has(ref))) continue;
    const claim = cleanClaim(paragraph);
    if (claim.length < 16 || claim.length > 700 || /^```|^\|/.test(claim)) continue;
    const sources = [];
    for (const ref of refs) {
      const chunk = await getChunkSnapshot(ref, userId);
      if (!chunk || chunk.docId !== allowed.get(ref).docId) continue;
      const quote = supportingQuote(chunk.text, claim);
      if (quote.length < 8) continue;
      sources.push({ ref, docId: chunk.docId, docName: chunk.docName, heading: chunk.heading || '',
        quote, sourceVersion: chunk.sourceVersion, start: chunk.start, end: chunk.end, threat: conclusionThreat(chunk.text) });
    }
    if (sources.length !== refs.length) continue;
    // Scan whole passages now, not only the stored quote: a poisoned source is
    // quarantined at capture instead of waiting for the next background check.
    const toxic = conclusionThreat(claim) || sources.map(s => s.threat || conclusionThreat(s.quote)).find(Boolean);
    sources.forEach(s => delete s.threat);
    proposals.push({ claim, sources, toxic });
    if (proposals.length >= 3) break;
  }
  return withFileLock(file, async () => {
    const state = await readState(userId);
    if (state.processedTasks.includes(taskId)) return { added: 0, skipped: 'already_captured' };
    const still = await taskSnapshot(userId, taskId);
    if (!still || still.bodyHash !== origin.bodyHash) return { added: 0, skipped: 'dialogue_changed' };
    let added = 0, merged = 0, evicted = 0;
    for (const p of proposals) {
      const fingerprint = sha(p.claim + JSON.stringify(p.sources.map(s => [s.ref, s.sourceVersion])));
      if (state.entries.some(e => e.fingerprint === fingerprint)) continue;
      const refs = new Set(p.sources.map(s => s.ref));
      // Same passages, nearly the same wording: one entry, not a pile of paraphrases.
      const twin = !p.toxic && state.entries.find(e => ACTIVE.has(e.status) && !conclusionThreat(e.claim) && e.sources.length === refs.size &&
        sourceSignature(e.sources) === sourceSignature(p.sources) && critical(e.claim) === critical(p.claim) && similarity(e.claim, p.claim) >= 0.8);
      if (twin) { twin.seenIn = [...new Set([...(twin.seenIn || []), taskId])].slice(-8); record(state, twin, 'merge', 'near_duplicate', 'dialogue'); merged++; continue; }
      // A full library evicts the oldest inactive record instead of silently refusing to learn.
      if (state.entries.length >= MAX_ENTRIES) {
        const victim = state.entries.filter(e => INACTIVE.has(e.status)).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)))[0];
        if (!victim) break;
        state.entries = state.entries.filter(e => e !== victim);
        state.audit.push({ at: iso(), id: victim.id, revision: victim.revision, action: 'evict', reason: 'capacity_inactive_oldest', actor: 'maintenance', status: victim.status });
        evicted++;
      }
      // Entries citing the same passage are shown together so contradictions surface for review.
      const related = state.entries.filter(e => ACTIVE.has(e.status) && e.sources.some(s => refs.has(s.ref))).map(e => e.id).slice(0, 8);
      const at = iso();
      const entry = { id: randomUUID(), fingerprint, claim: p.claim, sources: p.sources,
        origin: { taskId, conversationId: origin.task.conversationId, workspaceId: origin.conversation.workspaceId || 'default', answerHash: origin.bodyHash, capturedAt: at,
          answerModel: answerProvider?.model || result.supportSummary?.answerModel || '' },
        status: p.toxic ? 'quarantined' : 'candidate', revision: 0, createdAt: at, updatedAt: at,
        sourceCheck: { status: p.toxic ? 'quarantined' : 'pending', reason: p.toxic || 'awaiting_check', at },
        semanticCheck: { status: 'pending', note: '等待学习审查；模型意见不等于事实证明。' },
        confirmation: null, nextReviewAt: at, ...(related.length ? { related } : {}) };
      state.entries.push(entry); record(state, entry, 'capture', p.toxic || 'dialogue_candidate', 'dialogue'); added++;
    }
    state.processedTasks.push(taskId); await writeState(userId, state);
    queueKnowledgeReview(userId, { reason: 'turn_completed' });
    queueConclusionSupport(userId);
    return { added, merged, evicted, candidates: added, full: state.entries.length >= MAX_ENTRIES && !state.entries.some(e => INACTIVE.has(e.status)) };
  });
}

export async function reviewConclusions(userId, { limit = 12, force = false } = {}) {
  return withFileLock(location(userId), async () => {
    const state = await readState(userId), checks = [];
    const selected = state.entries.filter(e => !['withdrawn', 'quarantined'].includes(e.status) && (force || Date.parse(e.nextReviewAt || 0) <= Date.now()))
      .sort((a, b) => String(a.nextReviewAt || '').localeCompare(String(b.nextReviewAt || ''))).slice(0, bounded(limit, 12, 24));
    for (const entry of selected) { const check = await checkEntry(userId, entry); updateCheck(state, entry, check); checks.push({ id: entry.id, ok: check.ok, reason: check.reason }); }
    state.maintenance = { lastRunAt: iso(), checked: checks.length, mode: 'linked_passages_only', pendingSemantic: state.entries.filter(e => e.semanticCheck?.status === 'pending' && e.status !== 'quarantined').length };
    if (selected.length || state.entries.length) await writeState(userId, state);
    return { checked: checks.length, checks, maintenance: state.maintenance };
  });
}
/** Server calls after an owned conversation deletion/rewind; no source text scan. */
export async function invalidateConversationConclusions(userId, conversationId) {
  return withFileLock(location(userId), async () => {
    const state = await readState(userId); let count = 0;
    for (const entry of state.entries) if (entry.origin?.conversationId === conversationId && !['withdrawn', 'quarantined', 'invalidated'].includes(entry.status)) {
      entry.status = 'invalidated'; entry.sourceCheck = { status: 'invalid', reason: 'dialogue_unavailable_or_changed', at: iso() };
      record(state, entry, 'dialogue_invalidated', 'dialogue_unavailable_or_changed'); count++;
    }
    if (count) await writeState(userId, state);
    return { invalidated: count };
  });
}
export async function listConclusions(userId, { status = '', limit = MAX_ENTRIES } = {}) {
  const state = await readState(userId);
  return { section: { id: 'derived-conclusions', name: '验证结论', description: '从对话沉淀，经原文与人工核对的二级结论索引。' },
    entries: state.entries.filter(e => !status || e.status === status).slice().reverse().slice(0, bounded(limit, MAX_ENTRIES, MAX_ENTRIES)).map(publicEntry),
    counts: Object.fromEntries([...STATES].map(s => [s, state.entries.filter(e => e.status === s).length])),
    capacity: MAX_ENTRIES, maintenance: state.maintenance, audit: state.audit.slice(-20).reverse() };
}
export async function transitionConclusion(userId, id, { action, revision } = {}) {
  return withFileLock(location(userId), async () => {
    const state = await readState(userId), entry = state.entries.find(e => e.id === id);
    if (!entry) throw fail('not_found', '结论不存在。', 404);
    if (revision !== entry.revision) throw fail('stale_revision', '结论已变化，请刷新后再核对。', 409);
    if (!['verify', 'withdraw', 'recheck', 'release'].includes(action)) throw fail('invalid_action', '不支持的结论操作。');
    if (action === 'withdraw') { entry.status = 'withdrawn'; record(state, entry, action, 'user_withdrawn', 'user'); }
    else if (action === 'release') {
      // Scanner false positives (legal §, security papers) must not be lost forever.
      // Release only returns the entry to candidate; using it still needs a verify
      // against current sources, and the reviewer model still never sees its text.
      if (entry.status !== 'quarantined') throw fail('not_quarantined', '只有风险隔离的结论可以解除隔离。', 409);
      entry.threatOverride = { actor: 'user', at: iso(), claimHash: sha(entry.claim), sourceSignature:sourceSignature(entry.sources), reason: entry.sourceCheck?.reason || 'unknown' };
      entry.status = 'candidate'; entry.sourceCheck = { status: 'pending', reason: 'user_released_quarantine', at: iso() };
      record(state, entry, action, 'user_released_quarantine', 'user');
    }
    else {
      if (entry.status === 'quarantined' || entry.status === 'withdrawn') throw fail('inactive_conclusion', '已隔离或撤回的结论不恢复使用；请基于正确来源重新讨论。', 409);
      const check = await checkEntry(userId, entry); updateCheck(state, entry, check, 'user');
      if (action === 'verify' && check.ok) {
        // A model's support dispute is not a factual veto. An explicit human
        // confirmation may disagree; retain both opinions and still cite sources.
        entry.status = 'verified'; delete entry.attention;
        entry.confirmation = { actor: 'user', at: iso(), claimHash: sha(entry.claim), sourceVersions: entry.sources.map(s => s.sourceVersion), modelDisagreement: ['unsupported', 'conflict', 'uncertain'].includes(entry.semanticCheck?.status) };
        record(state, entry, action, 'user_confirmed_sources_and_claim', 'user');
      } else if (action === 'verify') { await writeState(userId, state); throw fail('verification_failed', '原文或原对话已失效，或包含需要隔离的内容，无法确认。请重新讨论并保存修正结论。', 409); }
      else record(state, entry, 'recheck', check.reason, 'user');
    }
    await writeState(userId, state); return publicEntry(entry);
  });
}

/** Rank small summaries, then return ONLY owned current passages, never the summary. */
export async function searchConclusionSources(query, { userId, docIds = null, k = 4 } = {}) {
  if (!USER.test(String(userId || '')) || docIds?.length === 0) return [];
  const terms = new Set(tokenize(String(query || '').slice(0, 1000)).map(t => t.term));
  if (!terms.size) return [];
  return withFileLock(location(userId), async () => {
    const state = await readState(userId), matches = state.entries.filter(e => e.status === 'verified' && e.confirmation &&
      (!docIds || e.sources.every(s => docIds.includes(s.docId)))).map(entry => {
        const words = new Set(tokenize(entry.claim).map(t => t.term));
        return { entry, score: [...terms].reduce((n, t) => n + Number(words.has(t)), 0) };
      }).filter(m => m.score >= Math.min(2, terms.size)).sort((a, b) => b.score - a.score).slice(0, bounded(k, 4, 8));
    const found = new Map(); let changed = false;
    for (const { entry, score } of matches) {
      // A release permits human inspection, not injecting still-toxic text into
      // the answer model. Apply the same withholding gate as reviewer prompts.
      const check = await checkEntry(userId, entry, { reviewer:true }); const previous = entry.status; updateCheck(state, entry, check); changed = true;
      if (!check.ok || previous !== 'verified') continue;
      for (const chunk of check.chunks) if (!found.has(chunk.id)) found.set(chunk.id, { ...chunk, score, derivedFrom: entry.id });
    }
    if (changed) await writeState(userId, state);
    return [...found.values()].slice(0, bounded(k, 4, 8));
  });
}

/** Called by the existing learning reviewer, sharing its single model-call budget. */
export async function conclusionReviewSnapshot(userId, { limit = 3, requireAnswerModel = false } = {}) {
  return withFileLock(location(userId), async () => {
    const state = await readState(userId), out = [];
    for (const entry of state.entries.filter(e => ['candidate', 'verified'].includes(e.status) &&
      (!requireAnswerModel || e.origin?.answerModel) &&
      (e.semanticCheck?.status === 'pending' || Date.parse(e.semanticCheck?.at || 0) < Date.now() - 7 * DAY)).slice(0, bounded(limit, 3, 3))) {
      const check = await checkEntry(userId, entry, { reviewer: true }); updateCheck(state, entry, check);
      if (!check.ok) continue;
      const related = (entry.related || []).map(id => state.entries.find(e => e.id === id)).filter(e => e && ACTIVE.has(e.status) && !conclusionThreat(e.claim))
        .slice(0, 2).map(e => ({ id: e.id, claim: e.claim }));
      out.push({ id: entry.id, revision: entry.revision, claim: entry.claim, sources: check.chunks.map(c => ({ ref: c.id, version: c.sourceVersion, text: c.text.slice(0, MAX_SOURCE_CHARS), truncated: c.text.length > MAX_SOURCE_CHARS })),
        ...(related.length ? { related } : {}), humanConfirmed: humanConfirmed(entry),
        origin: { taskId: entry.origin.taskId, conversationId: entry.origin.conversationId, answerModel: entry.origin.answerModel || '' } });
    }
    if (state.entries.length) await writeState(userId, state);
    return out;
  });
}
export async function applyConclusionReview(userId, assessments, { snapshot = [], independent = false } = {}) {
  if (!Array.isArray(assessments) || !snapshot.length) return [];
  return withFileLock(location(userId), async () => {
    const state = await readState(userId), decisions = [], seen = new Set();
    for (const assessment of assessments.slice(0, 3)) {
      const captured = snapshot.find(s => s.id === assessment?.id), entry = state.entries.find(e => e.id === assessment?.id);
      if (!captured || !entry || seen.has(entry.id) || entry.revision !== captured.revision || !['candidate', 'verified'].includes(entry.status)) continue;
      seen.add(entry.id);
      const verdict = assessment.verdict;
      if (!['supported', 'unsupported', 'uncertain', 'injection', 'conflict'].includes(verdict)) continue;
      const check = await checkEntry(userId, entry, { reviewer: true }); updateCheck(state, entry, check, 'review');
      if (!check.ok || check.chunks.some(c => !captured.sources.some(s => s.ref === c.id && s.version === c.sourceVersion))) { decisions.push({ id: entry.id, applied: false, reason: 'source_changed' }); continue; }
      // A human confirmation outranks a later model opinion: disagreement is
      // flagged for the user instead of silently invalidating their decision.
      const human = humanConfirmed(entry);
      if (verdict === 'injection') entry.status = 'quarantined';
      else if (human && verdict !== 'supported') { entry.attention = { reason: verdict === 'conflict' ? 'model_conflict' : 'model_disagrees', at: iso() }; entry.confirmation = { ...entry.confirmation, modelDisagreement: true }; }
      else if (verdict === 'unsupported') entry.status = 'invalidated';
      else if (verdict === 'uncertain' || verdict === 'conflict') entry.status = 'candidate';
      if (verdict === 'supported') delete entry.attention;
      // Do not persist arbitrary model explanations: they may themselves contain poisoned instructions.
      entry.semanticCheck = { status: verdict, at: iso(), method: independent ? 'independent_model_opinion' : 'model_opinion', independent, note: human && !['supported', 'injection'].includes(verdict)
        ? '模型与人工确认不一致：保留人工结论并标记待复核，请展开原文重新判断。'
        : ({ supported: '模型认为原文支持，仍需人工核对。', unsupported: '模型认为原文不足以支持，已暂停使用。', uncertain: '模型无法确认支持，等待人工复查。', injection: '模型发现潜在注入风险，已隔离。', conflict: '模型认为与同一原文的其他结论冲突，退回待核对。' })[verdict] };
      record(state, entry, 'semantic_review', verdict, 'review'); decisions.push({ id: entry.id, applied: true, verdict, status: entry.status });
    }
    if (decisions.length) await writeState(userId, state);
    return decisions;
  });
}

/** Keep the user's slot through the entire async review, coalescing new events
 * into one follow-up. Slow fsync or source reads must not create a growing queue. */
export function createKnowledgeReviewQueue({ review = reviewConclusions, delayMs = 250, maxUsers = 64 } = {}) {
  const queued = new Map(); let stopped = false;
  const waiters = [];
  const settle = () => { if (!queued.size) waiters.splice(0).forEach(resolve => resolve()); };
  const schedule = (userId, slot) => {
    slot.timer = setTimeout(async () => {
      slot.timer = null; slot.running = true; slot.again = false;
      try { await review(userId); } catch { /* A future trigger retries; retrieval always revalidates. */ }
      finally {
        slot.running = false;
        if (slot.again && !stopped) schedule(userId, slot);
        else { queued.delete(userId); settle(); }
      }
    }, delayMs);
    if (!waiters.length) slot.timer.unref?.();
  };
  return {
    enqueue(userId, { reason = 'periodic' } = {}) {
      if (stopped || !USER.test(String(userId || ''))) return false;
      const existing = queued.get(userId);
      if (existing) { existing.reason = reason; if (existing.running) existing.again = true; return true; }
      if (queued.size >= maxUsers) return false;
      const slot = { timer: null, running: false, again: false, reason };
      queued.set(userId, slot); schedule(userId, slot); return true;
    },
    /** Resolves once every queued and running review has finished (shutdown, tests). */
    idle() { if (!queued.size) return Promise.resolve(); for (const slot of queued.values()) slot.timer?.ref?.(); return new Promise(resolve => waiters.push(resolve)); },
    stop() { stopped = true; for (const [userId,slot] of queued) { clearTimeout(slot.timer); if(!slot.running)queued.delete(userId); } settle(); },
  };
}
const reviewQueue = createKnowledgeReviewQueue(); let maintenanceTimer = null;
export function queueKnowledgeReview(userId, options) { return reviewQueue.enqueue(userId, options); }
/** Separately scheduled from the learning-every-N-tasks policy. One bounded
 * judge batch per trigger; no configured independent judge means no network. */
export async function reviewConclusionSupport(userId) {
  const [{resolveJudge}, {checkSupportStatements}] = await Promise.all([import('./judge-settings.mjs'), import('./support-check.mjs')]);
  const prefs = await getStore().getPreferences(userId);
  if (!config.learning.enabled || prefs?.learning === 'off') return {reviewed:0,reason:'learning_disabled'};
  const judge = await resolveJudge(userId); if(!judge)return {reviewed:0,reason:'judge_not_configured'};
  const snapshot=await conclusionReviewSnapshot(userId,{requireAnswerModel:true});
  if(!snapshot.length)return {reviewed:0,reason:'no_pending_known_model'};
  const answerModel=snapshot[0].origin.answerModel;
  const selected=snapshot.filter(s=>s.origin.answerModel===answerModel);
  const evidence=new Map(selected.flatMap(s=>s.sources.map(source=>[source.ref,{content:source.text,truncated:source.truncated}])));
  const result=await checkSupportStatements(selected.map(s=>({sentence:s.claim,refs:s.sources.map(x=>x.ref)})),
    {userId,answerProvider:{model:answerModel},judgeProvider:judge,evidence});
  const assessments=result.support.map((row,i)=>({id:selected[i].id,verdict:({supported:'supported',unsupported:'unsupported',contradicted:'conflict',uncertain:'uncertain'})[row.verdict]})).filter(row=>row.verdict);
  const decisions=await applyConclusionReview(userId,assessments,{snapshot:selected,independent:true});
  await withFileLock(location(userId),async()=>{const state=await readState(userId);state.audit.push({at:iso(),action:'independent_support_batch',actor:'review',
    ids:selected.map(s=>s.id),llmCalls:result.summary.llmCalls || 0,usage:result.summary.usage || null,judgeModel:judge.model,reason:result.summary.reason});await writeState(userId,state);});
  return {reviewed:decisions.filter(d=>d.applied).length,summary:result.summary};
}
const semanticQueue = createKnowledgeReviewQueue({review:reviewConclusionSupport,delayMs:750,maxUsers:16});
export function queueConclusionSupport(userId) {return semanticQueue.enqueue(userId);}
export async function knowledgeReviewsIdle() {await Promise.all([reviewQueue.idle(),semanticQueue.idle()]);}
export function startKnowledgeMaintenance({ intervalMs = 15 * 60000 } = {}) {
  if (maintenanceTimer) return () => {};
  let cursor = 0, running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const names = (await fs.readdir(path.join(config.dataDir, 'knowledge')).catch(() => [])).filter(n => /^[a-zA-Z0-9_-]{1,64}\.json$/.test(n)).sort();
      if (!names.length) return;
      for (const name of [...names.slice(cursor), ...names.slice(0, cursor)].slice(0, 8)) {
        const userId=name.slice(0,-5);await reviewConclusions(userId).catch(() => {});queueConclusionSupport(userId);
      }
      cursor = (cursor + 8) % names.length;
    } finally { running = false; }
  };
  maintenanceTimer = setInterval(() => tick().catch(() => {}), Math.max(1000, intervalMs)); maintenanceTimer.unref?.();
  const initial = setTimeout(() => tick().catch(() => {}), 1000); initial.unref?.();
  return () => { clearInterval(maintenanceTimer); clearTimeout(initial); maintenanceTimer = null; };
}
onKnowledgeSourceChange(async ({ userId, docId, action }) => {
  if (!USER.test(String(userId || ''))) return;
  if (action === 'delete') await withFileLock(location(userId), async () => {
    const state = await readState(userId); let count = 0;
    for (const entry of state.entries) if (entry.sources.some(s => s.docId === docId) && !['withdrawn', 'quarantined', 'invalidated'].includes(entry.status)) {
      entry.status = 'invalidated'; entry.sourceCheck = { status: 'invalid', reason: 'source_removed', at: iso() };
      record(state, entry, 'source_removed', 'source_removed'); count++;
    }
    if (count) await writeState(userId, state);
  });
  queueKnowledgeReview(userId, { reason: 'knowledge_changed' });
});

/** Parent server must authenticate before dispatch. Writes additionally require its local UI gate. */
export async function handleKnowledgeConclusions({ req, res, url, userId, readBody, sendJson, localManage = false }) {
  const match = /^\/api\/knowledge\/conclusions(?:\/(review|[a-f0-9-]{36})(?:\/(action))?)?$/.exec(url.pathname);
  if (!match) return false;
  const reply = (status, value) => { sendJson(res, status, value); return true; };
  try {
    location(userId);
    if (req.method === 'GET' && !match[1]) {
      queueKnowledgeReview(userId);
      const [conclusions, documents, sections] = await Promise.all([listConclusions(userId), listDocuments(userId), listSections(userId)]);
      return reply(200, { ...conclusions, documents: documents.map(({ extraction, ...doc }) => ({ ...doc, firstRef: doc.chunkCount > 0 ? `${doc.id}_0` : null })), sections });
    }
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    const origin = req.headers.origin;
    // The parent router parses pathnames against a synthetic localhost base, so
    // compare Origin with the actual request authority, not url.origin.
    const expectedOrigin = `${req.socket.encrypted ? 'https' : 'http'}://${String(req.headers.host || '').toLowerCase()}`;
    if (!localManage || req.headers['sec-fetch-site'] === 'cross-site' || (origin && origin !== expectedOrigin)) return reply(403, { error: 'forbidden', message: '请从本机工作台操作。' });
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'invalid_request' });
    if (match[1] === 'review' && !match[2] && Object.keys(body).length === 0) return reply(200, await reviewConclusions(userId, { force: true }));
    if (match[2] && Object.keys(body).every(k => ['action', 'revision'].includes(k))) return reply(200, { entry: await transitionConclusion(userId, match[1], body) });
    return reply(400, { error: 'invalid_request' });
  } catch (error) { return reply(error.status || 500, { error: error.code || 'knowledge_error', message: error.code ? error.message : '结论操作暂未完成，请重试。' }); }
}
