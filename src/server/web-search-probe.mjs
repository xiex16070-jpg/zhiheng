import { webSearch } from './webtools.mjs';
import { searchOpenAlex } from './joint-research.mjs';
import { searchEuropePmc } from './scholar.mjs';

export async function probeWebSearch(connection, { signal, search = webSearch } = {}) {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  try {
    const result = connection.provider === 'openalex'
      ? await searchOpenAlex('retrieval augmented generation', { limit: 1, apiKey: connection.apiKey, signal })
      : connection.provider === 'europepmc' ? await searchEuropePmc('machine learning', { limit: 1, signal })
      : await search('NIST AI Risk Management Framework', { count: 1, domains: ['nist.gov'], connection, signal });
    const elapsedMs = Date.now() - started;
    if (result.ok) return { ok: true, code: 'connected', resultCount: result.results.length, elapsedMs, checkedAt,
      message: result.results.length ? '连接成功，已取得测试检索结果。' : '连接成功，测试查询未返回匹配资料。' };
    const status = result.status;
    const code = status === 401 || status === 403 ? 'authentication_failed' : status === 429 ? 'rate_limited' : result.error || 'unavailable';
    const message = code === 'authentication_failed' ? '服务未接受此 API Key，请核对后重试。'
      : code === 'rate_limited' ? `HTTP 429：频率或账户额度受限。${connection.provider === 'openalex' && !connection.apiKey ? '可填写 OpenAlex 免费 API Key。' : ''}请等待 ${result.retryAfter || 60} 秒后重试，日额度耗尽需等待重置。` : code === 'timeout' ? '连接超时，请检查网络后重试。'
      : status === 503 && connection.provider === 'europepmc' ? 'HTTP 503：Europe PMC 服务暂不可用，无需 API Key。稍后再试，其他来源仍可使用。'
      : status ? `搜索服务返回 HTTP ${status}，请检查服务状态与账户额度。` : '未能连接搜索服务，请检查网络或稍后重试。';
    return { ok: false, code, ...(status ? { upstreamStatus: status } : {}), resultCount: 0, elapsedMs, checkedAt, message };
  } catch {
    return { ok: false, code: signal?.aborted ? 'cancelled' : 'network_error', resultCount: 0,
      elapsedMs: Date.now() - started, checkedAt, message: signal?.aborted ? '连接测试已取消。' : '连接测试未完成，请稍后重试。' };
  }
}
