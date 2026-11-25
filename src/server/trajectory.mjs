/**
 * Training-data capture. Every finished task (completed or failed) leaves one
 * local record of exactly what the model saw and produced: the rendered system
 * prompt, the tool schemas offered, every message including tool calls and tool
 * results, the raw final answer and the outcome checks. Records stay on this
 * machine (DATA_DIR/trajectories, mode 0600); scripts/export-trajectories.mjs
 * applies a second scrub and selects reviewed SFT / DPO rows for the model lab.
 *
 * Users who switch the learning preference off are not recorded.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { writeJsonAtomic, withFileLock } from './fsutil.mjs';

export const TRAJECTORY_SCHEMA = 'zhiheng-traj/1';
export const FEEDBACK_REASONS = ['wrong_citation', 'unsupported_claim', 'bad_logic', 'wrong_tool', 'incomplete', 'format', 'refused_wrongly', 'unsafe', 'other'];
const MAX_MESSAGE_CHARS = 60_000;
const MAX_CORRECTION_CHARS = 8000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
export const stableJson = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
export const trajectorySha = (value) => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
const sha = trajectorySha;
const HASH = /^[a-f0-9]{64}$/;

export const trajectoryRoot = () => path.join(config.dataDir, 'trajectories');
function userDir(userId) {
  if (!SAFE_ID.test(String(userId || ''))) throw Object.assign(new Error('invalid_user'), { code: 'invalid_user', status: 403 });
  return path.join(trajectoryRoot(), String(userId));
}

const toolSchemaOf = (tool) => (tool?.function ? { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } : tool);

/** Stable identifiers so training rows group by the exact prompt and tool set that produced them. */
export function promptFingerprint(messages = [], tools = []) {
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const schemas = tools.map(toolSchemaOf);
  return { systemSha: sha(String(system)), toolsSha: sha(schemas), toolNames: schemas.map((t) => t?.name).filter(Boolean) };
}

function cleanMessage(m) {
  const out = { role: m.role };
  if (m.content !== undefined && m.content !== null) {
    const multimodal = Array.isArray(m.content) && m.content.some(part => part.type !== 'text');
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(multimodal
      ? m.content.map(part => part.type === 'text' ? part : { type: part.type, omitted: true }) : m.content);
    if (multimodal) out.multimodalOmitted = true;
    out.content = text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
    if (text.length > MAX_MESSAGE_CHARS) out.truncatedChars = text.length;
  }
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    out.tool_calls = m.tool_calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } }));
  }
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m._toolError) out.toolError = true;
  if (m._contextKind) out.contextKind = m._contextKind;
  return out;
}

function outcomeOf({ status, result, error, messages }) {
  const contract = result?.answerContract || error?.partialResult?.answerContract;
  return {
    status,
    error: error ? String(error.message || error).slice(0, 300) : null,
    citations: (result?.citations || []).map((c) => String(c.ref ?? c.id)),
    unverified: Array.isArray(result?.unverified) ? result.unverified.map(String) : [],
    noEvidence: Boolean(result?.noEvidence),
    uncited: Boolean(result?.uncited),
    grounded: Boolean(result?.grounded),
    truncated: Boolean(result?.truncated || error?.partialResult?.truncated),
    toolErrors: messages.filter((m) => m.role === 'tool' && m._toolError).length,
    logic: (result?.logicResults || []).map((r) => (r.queries || []).map((q) => q.status)),
    inference: result?.inferenceStats || null,
    llmCalls: result?.llmCalls || error?.llmCalls || null,
    answerRepairs: contract?.repairs ?? 0,
    answerContractIssues: Array.isArray(contract?.issues) ? contract.issues.map(String).slice(0, 50)
      : contract?.issues == null ? [] : ['invalid_answer_contract_issues'],
  };
}

/**
 * @param {{ task: object, provider: object, status: 'completed'|'failed', messages: object[], tools?: object[],
 *   answer?: string, result?: object, error?: Error, profile: string, taskMode: string, prefs?: object }} input
 *   `answer` is the raw final model text (aliases intact), appended as the last assistant turn.
 */
export async function captureTrajectory({ task, provider, status, messages, tools = [], answer = '', result = null, error = null, profile, taskMode, prefs = {}, callSnapshots = [] }) {
  if (!config.learning.trajectories || prefs?.learning === 'off') return null;
  if (!task || !SAFE_ID.test(String(task.id || '')) || !Array.isArray(messages) || !messages.length) return null;
  const turns = answer ? [...messages, { role: 'assistant', content: answer }] : messages;
  let host = '';
  try { host = new URL(provider?.baseUrl).host; } catch { /* unknown provider address */ }
  const fingerprint = promptFingerprint(messages, tools);
  const knownSecrets = [provider?.apiKey, provider?.zoteroLocalApiKey, provider?.imageProvider?.apiKey,
    ...Object.entries(process.env).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key)).map(([, value]) => value)].filter(value => typeof value === 'string' && value.length >= 6);
  const clean = value => scrubDeep(value, knownSecrets);
  const snapshots = callSnapshots.map(call => {
    const schemas = clean((call.tools || []).map(toolSchemaOf));
    const turns = clean((call.messages || []).map(cleanMessage));
    return { messages: turns, tools: schemas, prompt: promptFingerprint(turns, schemas),
      ...(call.response ? { response: clean(cleanMessage(call.response)) } : {}),
      ...(call.backendCapabilities && typeof call.backendCapabilities === 'object' ? { backendCapabilities: clean(call.backendCapabilities) } : {}),
      ...(['native', 'compatibility-auto', 'none'].includes(call.toolMode) ? { toolMode: call.toolMode } : {}),
      finishReason: call.finishReason || null, error: Boolean(call.error) };
  });
  const sanitizedMessages = clean(turns.map(cleanMessage));
  const schemas = clean(tools.map(toolSchemaOf));
  const record = clean({
    schema: TRAJECTORY_SCHEMA, taskId: task.id, createdAt: new Date().toISOString(),
    model: { host, model: String(provider?.model || '').slice(0, 120), profile }, taskMode, prompt: fingerprint,
    messages: sanitizedMessages, outcome: outcomeOf({ status, result, error, messages: turns }),
    conversationId: task.conversationId || task.id,
    profileSha: provider?.profileSha || null, hashAlgorithm: 'sha256-canonical-json-v1',
    storedPrompt: promptFingerprint(sanitizedMessages, schemas), callSnapshots: snapshots,
    capture: { redacted: stableJson(turns.map(cleanMessage)) !== stableJson(sanitizedMessages),
      truncated: turns.some(m => String(m.content || '').length > MAX_MESSAGE_CHARS), exactCalls: snapshots.length > 0 },
  });
  if (Buffer.byteLength(JSON.stringify(record)) > 8 * 1024 * 1024) {
    record.callSnapshots = []; record.messages = []; record.capture.truncated = true; record.capture.exactCalls = false;
    record.capture.reason = 'capture_exceeds_8mib';
  }
  // Address the stored schemas by their stored bytes; never read a file named by an unchecked supplied hash.
  record.prompt.toolsSha = sha(schemas);
  await writeJsonAtomic(path.join(userDir(task.userId), task.id + '.json'), record, { mode: 0o600 });
  // Tool schemas are shared, not personal: store each distinct set once.
  const toolsFile = path.join(trajectoryRoot(), '_tools', record.prompt.toolsSha + '.json');
  if (!await fs.access(toolsFile).then(() => true, () => false)) await writeJsonAtomic(toolsFile, schemas, { mode: 0o600 });
  return record;
}

/** Explicit user rating of one answer; the latest rating wins, history is kept. */
export async function recordFeedback(userId, taskId, { rating, reasons = [], correction = '' } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code, status: 400 });
  if (!SAFE_ID.test(String(taskId || ''))) throw fail('invalid_task', '任务编号无效。');
  if (!['up', 'down'].includes(rating)) throw fail('invalid_rating', '评价只能是 up 或 down。');
  if (!Array.isArray(reasons) || reasons.length > FEEDBACK_REASONS.length || reasons.some((r) => !FEEDBACK_REASONS.includes(r))) throw fail('invalid_reasons', '问题类型无效。');
  if (typeof correction !== 'string' || correction.length > MAX_CORRECTION_CHARS) throw fail('invalid_correction', `修正答案最多 ${MAX_CORRECTION_CHARS} 字。`);
  const file = path.join(userDir(userId), taskId + '.labels.json');
  return withFileLock(file, async () => {
    const previous = await fs.readFile(file, 'utf8').then(JSON.parse, () => null);
    const entry = { at: new Date().toISOString(), rating, reasons: [...new Set(reasons)], ...(correction.trim() ? { correction: scrubText(correction.trim()) } : {}) };
    const labels = { schema: 'zhiheng-labels/1', taskId, current: entry, history: [...(previous?.history || []), entry].slice(-20) };
    await writeJsonAtomic(file, labels, { mode: 0o600 });
    return entry;
  });
}

/* ------------------------------------------------------------------ export */

// Applied at export time to every string, including tool arguments and results.
const SCRUB_PATTERNS = [
  [/data:(?:image|audio|video)\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, '[BINARY_OMITTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\btvly-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]'],
  [/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, '[REDACTED_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi, 'Basic [REDACTED]'],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@'],
  [/\b(api[_-]?key|access[_-]?token|secret|password|passwd)(\s*["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi, '$1$2[REDACTED]'],
  [/\b[A-Za-z]:\\Users\\[^\\\s"'<>]+/g, 'C:\\Users\\<user>'],
  [/\/(home|Users)\/[^/\s"'<>]+/g, '/$1/<user>'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>'],
];
export function scrubText(text, knownSecrets = []) {
  let out = String(text);
  for (const secret of knownSecrets) if (secret.length >= 6) out = out.split(secret).join('[REDACTED_KEY]');
  for (const [pattern, replacement] of SCRUB_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
export function scrubDeep(value, knownSecrets = []) {
  if (typeof value === 'string') {
    // Tool arguments/results often contain JSON serialized inside a string. Preserve valid JSON while redacting values.
    if (/^\s*[\[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value), cleaned = scrubDeep(parsed, knownSecrets);
        return stableJson(parsed) === stableJson(cleaned) ? value : JSON.stringify(cleaned);
      } catch { /* prose */ }
    }
    return scrubText(value, knownSecrets);
  }
  if (Array.isArray(value)) return value.map(item => scrubDeep(item, knownSecrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
    /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|set-cookie|secret|password|passwd|sealedKey)$/i.test(k) && typeof v === 'string' && v
      ? '[REDACTED_KEY]' : scrubDeep(v, knownSecrets)]));
  return value;
}

/** A positive human rating and structural checks are required; this is not an entailment certificate. */
export function trajectoryIssues(record, tools = null) {
  const issues = [];
  if (!Array.isArray(record?.messages) || !record.messages.length) return ['messages_missing'];
  const pending = new Set(), used = new Set();
  const names = tools ? new Set(tools.map(t => toolSchemaOf(t)?.name)) : null;
  for (const m of record.messages) {
    if (m.truncatedChars) issues.push('message_truncated');
    if (m.multimodalOmitted) issues.push('multimodal_context_omitted');
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) issues.push('invalid_role');
    if (m.role === 'tool') { if (!pending.delete(m.tool_call_id)) issues.push('orphan_tool_result'); }
    else {
      if (pending.size) issues.push('tool_result_missing');
      for (const c of m.tool_calls || []) {
        if (m.role !== 'assistant' || !c.id || used.has(c.id)) issues.push('tool_call_invalid');
        used.add(c.id); pending.add(c.id);
        if (names && !names.has(c.function?.name)) issues.push('tool_schema_missing');
        try { const args = JSON.parse(c.function?.arguments); if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error(); }
        catch { issues.push('tool_arguments_invalid'); }
      }
    }
  }
  if (pending.size) issues.push('tool_result_missing');
  const final = record.messages.at(-1);
  if (final?.role !== 'assistant' || final?.tool_calls?.length || typeof final?.content !== 'string' || !final.content.trim()) issues.push('final_answer_missing');
  if (record.capture?.exactCalls) {
    const last = record.callSnapshots?.at(-1), response = last?.response;
    if (!last || last.error || last.finishReason !== 'stop' || response?.role !== 'assistant' || response?.tool_calls?.length
        || typeof response?.content !== 'string' || !response.content.trim() || response.content !== final?.content) issues.push('final_snapshot_incomplete');
  }
  if (record.capture?.truncated) issues.push('capture_truncated');
  if (record.integrityIssues?.length) issues.push(...record.integrityIssues);
  return [...new Set(issues)];
}

export function sftEligible(record, labels) {
  const rating = labels?.current?.rating;
  if (rating === 'down') return false;
  if (record.outcome?.status !== 'completed') return false;
  const o = record.outcome;
  if (trajectoryIssues(record).length || !record.capture?.exactCalls || !record.callSnapshots?.length) return false;
  if (record.capture.redacted) return false;
  if (o.truncated || o.toolErrors > 0 || o.unverified?.length || o.uncited || o.inference?.fail > 0) return false;
  // A final thumbs-up does not approve the failed drafts in earlier snapshots.
  // Keep such records for manual curation, never export every call as positive SFT.
  // Absent fields in older records preserve their existing eligibility rules.
  if (Object.hasOwn(o, 'answerRepairs') && (!Number.isSafeInteger(o.answerRepairs) || o.answerRepairs !== 0)) return false;
  if (Object.hasOwn(o, 'answerContractIssues') && (!Array.isArray(o.answerContractIssues) || o.answerContractIssues.length)) return false;
  // Mechanical citation checks do not establish semantic entailment. Unrated traces are curation candidates, never automatic gold.
  return rating === 'up';
}

const chatMessage = ({ role, content, tool_calls, tool_call_id }) => ({ role, ...(content !== undefined ? { content } : {}),
  ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) });
const meta = (record, labels) => ({ taskId: record.taskId, conversationId: record.conversationId, createdAt: record.createdAt, profileSha: record.profileSha, model: record.model, taskMode: record.taskMode, prompt: { systemSha: record.prompt.systemSha, toolsSha: record.prompt.toolsSha },
  outcome: record.outcome, rating: labels?.current?.rating || null, reasons: labels?.current?.reasons || [] });

export function toSftRow(record, labels, tools = []) {
  return scrubDeep({ messages: record.messages.map(chatMessage), tools: tools.map((t) => ({ type: 'function', function: t })), meta: meta(record, labels) });
}

/** Preserve lazy tool exposure and compacted context: one exact request/response per training target. */
export function toSftRows(record, labels) {
  if (!sftEligible(record, labels)) return [];
  return record.callSnapshots.flatMap((call, index) => {
    if (!call.response || call.error || !['stop', 'tool_calls'].includes(call.finishReason)) return [];
    if (JSON.stringify([...call.messages, call.response]).includes('[REDACTED') || [...call.messages, call.response].some(message => message.multimodalOmitted)) return [];
    if (call.prompt?.toolsSha !== sha(call.tools) || call.prompt?.systemSha !== promptFingerprint(call.messages, call.tools).systemSha) return [];
    return [scrubDeep({ messages: [...call.messages, call.response].map(chatMessage),
      tools: call.tools.map(tool => ({ type: 'function', function: tool })),
      meta: { ...meta(record, labels), callIndex: index, prompt: call.prompt, humanApproved: true, semanticSupportVerified: false } })];
  });
}

/** A thumbs-down with a written correction becomes a preference pair on the final turn. */
export function toDpoRow(record, labels, tools = []) {
  const correction = labels?.current?.rating === 'down' && labels.current.correction;
  const last = record.messages.at(-1);
  if (!correction || last?.role !== 'assistant' || !last.content || trajectoryIssues(record, tools).length || record.outcome?.truncated) return null;
  return scrubDeep({ prompt: record.messages.slice(0, -1).map(chatMessage), chosen: correction, rejected: last.content,
    tools: tools.map((t) => ({ type: 'function', function: t })), meta: meta(record, labels) });
}

/** Reads every record under DATA_DIR/trajectories (or one user) with its labels and tool schemas. */
export async function* readTrajectories({ userId = null } = {}) {
  const root = trajectoryRoot();
  const users = userId ? [String(userId)] : (await fs.readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && SAFE_ID.test(d.name) && d.name !== '_tools').map((d) => d.name);
  const toolCache = new Map();
  const readRecord = async (file, maximum = 8 * 1024 * 1024) => fs.lstat(file).then(stat =>
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum ? fs.readFile(file, 'utf8').then(JSON.parse) : null).catch(() => null);
  for (const user of users) {
    const dir = userDir(user);
    if (!await fs.lstat(dir).then(stat => stat.isDirectory() && !stat.isSymbolicLink(), () => false)) continue;
    for (const name of (await fs.readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json') && !n.endsWith('.labels.json')).sort()) {
      const record = await readRecord(path.join(dir, name));
      if (record?.schema !== TRAJECTORY_SCHEMA || !SAFE_ID.test(record.taskId || '') || name !== record.taskId + '.json') continue;
      const labels = await readRecord(path.join(dir, name.replace(/\.json$/, '.labels.json')), 256 * 1024);
      const hash = record.prompt?.toolsSha;
      const integrityIssues = [];
      if (!HASH.test(hash || '')) integrityIssues.push('invalid_tools_hash');
      else if (!toolCache.has(hash)) {
        const toolFile = path.join(root, '_tools', hash + '.json');
        const schemas = await fs.lstat(toolFile).then(stat => stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024 ? fs.readFile(toolFile, 'utf8').then(JSON.parse) : null).catch(() => null);
        // Legacy v1 captured JSON insertion order, new captures declare canonical hashing explicitly.
        const digest = record.hashAlgorithm ? sha(schemas) : createHash('sha256').update(JSON.stringify(schemas)).digest('hex');
        toolCache.set(hash, Array.isArray(schemas) && digest === hash ? schemas : null);
      }
      const tools = toolCache.get(hash);
      if (!tools) integrityIssues.push('tool_schema_integrity_failed');
      if (record.storedPrompt && record.storedPrompt.systemSha !== promptFingerprint(record.messages, tools || []).systemSha) integrityIssues.push('system_integrity_failed');
      yield { userId: user, record: { ...record, integrityIssues }, labels, tools: tools || [] };
    }
  }
}
