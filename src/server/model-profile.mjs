import { LOCAL_QWEN_SYSTEM_PROMPT, LOCAL_QWEN_PROMPT_SHA256, LOCAL_QWEN_MAX_TOKENS, LOCAL_QWEN_CONTEXT, localQwenTools, localQwenSystem } from './local-qwen.mjs';
import { trajectorySha, promptFingerprint } from './trajectory.mjs';
import { backendCapabilities } from './backend-capabilities.mjs';

export function buildLocalModelProfile(schemas) {
  if (trajectorySha(LOCAL_QWEN_SYSTEM_PROMPT) !== LOCAL_QWEN_PROMPT_SHA256) throw new Error('local_profile_base_prompt_drift');
  const tools = localQwenTools(schemas).map(tool => tool.function);
  const variants = Object.fromEntries(['agent', 'literature'].map(name => {
    const system = localQwenSystem({}, { literature: name === 'literature' });
    return [name, { system, ...promptFingerprint([{ role: 'system', content: system }], tools) }];
  }));
  // These are finite rendered preference variants, not guessed replacements of runtime context.
  for (const mode of ['agent', 'literature']) for (const style of ['concise', 'balanced', 'detailed'])
    for (const citeQuotes of [false, true]) for (const scope of ['all', 'private', 'joint']) {
      const system = localQwenSystem({ style, citeQuotes, discipline: scope === 'all' ? '' : 'kb:profile', jointResearch: scope === 'joint' }, { literature: mode === 'literature' });
      variants[`${mode}-${style}-${citeQuotes ? 'quotes' : 'paraphrase'}-${scope}`] = { system, ...promptFingerprint([{ role: 'system', content: system }], tools) };
    }
  const profile = { schema: 'zhiheng-model-profile/2', id: 'local-qwen',
    basePrompt: { text: LOCAL_QWEN_SYSTEM_PROMPT, sha256: LOCAL_QWEN_PROMPT_SHA256 }, variants, tools,
    budgets: { maxOutputTokens: LOCAL_QWEN_MAX_TOKENS, contextTokens: LOCAL_QWEN_CONTEXT },
    generation: { temperature: 0, thinking: false },
    citationFormat: 'Per-turn aliases [[S1]]; grounded requires separate semantic checking.' };
  return { ...profile, profileSha: trajectorySha(profile) };
}

export async function currentLocalModelProfile() {
  const { getToolSchemas } = await import('./tools.mjs');
  return buildLocalModelProfile(getToolSchemas({}));
}

/** Explicit profile selection must be attested by the serving process, not guessed from its model name. */
export async function verifyLocalModelProfile(provider, { fetchImpl = fetch, profile = null, registry = backendCapabilities } = {}) {
  const { baseUrl, model, apiKey } = provider;
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error('local_profile_requires_loopback');
  const expected = profile || await currentLocalModelProfile();
  // Pin localhost to loopback instead of performing another DNS lookup.
  const target = new URL(baseUrl.replace(/\/$/, '') + '/models');
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1';
  try {
    const response = await fetchImpl(target.href, { redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
    if (!response.ok) throw new Error('local_profile_service_unavailable');
    const text = await response.text();
    if (text.length > 65536) throw new Error('local_profile_response_too_large');
    const row = JSON.parse(text)?.data?.find(item => item.id === model);
    if (row?.profileId !== expected.id || row?.profileSha !== expected.profileSha) throw new Error('local_profile_mismatch');
    const binding = { profileId: expected.id, profileSha: expected.profileSha, adapterSha: row.adapterSha || null, verifiedAt: new Date().toISOString() };
    const capabilities = registry.attestLocal({ ...provider, ...binding }, row);
    return { ...binding, backendRuntime: capabilities.runtime, backendCapabilities: capabilities };
  } catch (error) {
    registry.invalidate(provider);
    throw error;
  }
}
