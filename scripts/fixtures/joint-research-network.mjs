// Explicit Node --import fixture for isolated HTTP/browser acceptance. Never
// imported by the application. All upstream content and LLM outputs here are synthetic.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

const realFetch = globalThis.fetch;
const log = data => { if (process.env.JOINT_FIXTURE_LOG) fs.appendFileSync(process.env.JOINT_FIXTURE_LOG, JSON.stringify(data) + '\n'); };
const text = 'Formal verification uses mathematical proofs to establish program properties relative to a specification. A proof does not validate assumptions about the environment. Independent evidence remains necessary for empirical claims.';
const title = n => `Formal verification evidence study ${n}`;
const inverted = value => {
  const result = {};
  value.split(' ').forEach((word, n) => (result[word] ||= []).push(n));
  return result;
};
const sse = (delta, finish_reason = 'stop') => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
globalThis.fetch = async (input, opts = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'api.tavily.com' || url.hostname === 'google.serper.dev') {
    opts.signal?.throwIfAborted();
    const body = JSON.parse(opts.body);
    const key = opts.headers.authorization?.replace(/^Bearer /, '') || opts.headers['X-API-KEY'] || '';
    log({ kind: 'web-search', provider: url.hostname, query: body.query || body.q, domains: body.include_domains || [],
      credentialHash: crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) });
    if (key.includes('invalid')) return new Response(JSON.stringify({ error: 'upstream echoes secret ' + key }), { status: 401 });
    if (key.includes('limited')) return new Response('{}', { status: 429 });
    const results = [{ title: 'NIST AI Risk Management Framework', url: 'https://www.nist.gov/itl/ai-risk-management-framework', content: 'Official NIST AI risk management framework.' }];
    return Response.json(url.hostname === 'api.tavily.com' ? { results } : { organic: results.map(r => ({ title: r.title, link: r.url, snippet: r.content })) });
  }
  if (['api.openalex.org', 'www.ebi.ac.uk', 'export.arxiv.org'].includes(url.hostname)) {
    opts.signal?.throwIfAborted();
    log({ kind: 'discovery', url: url.href });
    if (/OFFLINE/i.test(url.href)) return new Response('{}', { status: 503 });
    if (url.hostname === 'api.openalex.org') return Response.json({ results: [1, 2, 3, 4, 5].map(n => ({ title: title(n), doi: `https://doi.org/10.1234/verification-${n}`,
      publication_date: `2025-0${n}-02`, type: 'article', primary_location: { source: { display_name: 'Journal ' + n, type: 'journal', host_organization_name: 'Research publisher ' + n } },
      abstract_inverted_index: inverted(text), authorships: [{ author: { display_name: `Researcher ${n}` } }] })) });
    if (url.hostname === 'www.ebi.ac.uk') return Response.json({ resultList: { result: [{ title: title(1), doi: '10.1234/verification-1', abstractText: text, firstPublicationDate: '2025-01-02', journalInfo: { journal: { title: 'Journal 1' } } }] } });
    return new Response(`<feed><entry><id>http://arxiv.org/abs/2410.12345v2</id><title>Formal verification preprint experiment</title><summary>${text}</summary><published>2024-10-16</published><updated>2025-03-02</updated></entry></feed>`);
  }
  if (url.hostname === '127.0.0.1' && url.port === '18992' && url.pathname.endsWith('/chat/completions')) {
    const body = JSON.parse(opts.body);
    log({ kind: 'model', body });
    if (!body.tools) {
      const sys = body.messages[0].content;
      return sse({ content: sys.includes('[IRCoT:next]') ? '{"done":true}' : sys.includes('[ToT:propose]') ? '{"branches":["formal verification assumptions","program proof specification"]}' : sys.includes('[ToT:expand]') ? '{"done":true}' : '[]' });
    }
    const texts = body.messages.map(m => m.content || '').join('\n');
    const context = [...body.messages].reverse().find(m => m.role === 'user' && m.content.includes('ref='))?.content || '';
    const refs = [...context.matchAll(/ref=([A-Za-z0-9_-]+)/g)].map(m => m[1]);
    const external = refs.find(r => r.startsWith('auth_'));
    const local = refs.find(r => !r.startsWith('auth_'));
    const toolReply = body.messages.some(m => m.role === 'tool');
    let name, args;
    if (!toolReply && texts.includes('USE_WEB_SEARCH')) { name = 'web_search'; args = { query: 'NIST official AI Risk Management Framework', count: 1 }; }
    else if (!toolReply && texts.includes('USE_EXTENSION')) { name = 'call_extension'; args = { extension: 'fixture', revision: 2, tool: 'write_note', arguments: { text: 'approved via real orchestrator' } }; }
    else if (!toolReply && texts.includes('USE_DOCUMENT')) { name = 'create_document'; args = { path: '报告.' + (texts.includes('USE_DOCUMENT DOCX') ? 'docx' : 'pdf'), title: '形式验证报告', markdown: '## 适用范围\n\n**形式验证**依据规范检查程序。\n\n| 条件 | 结果 |\n|---|---|\n| 前提成立 | 可推导结论 |' }; }
    else if (!toolReply && texts.includes('ASK_APPROVAL')) { name = 'update_preferences'; args = { style: 'concise' }; }
    else if (!toolReply && texts.includes('TRY_BYPASS')) { name = 'web_fetch'; args = { url: 'https://evil.example/unchecked' }; }
    else if (!toolReply && external) { name = 'read_source'; args = { ref: external }; }
    if (name) return sse({ tool_calls: [{ index: 0, id: 'joint-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
    const content = [
      local ? `形式验证的结论依赖明确的规格与前提。[[${local}]]` : '',
      external ? `外部研究摘要同样强调：证明不能自动验证环境假设。[[${external}]]` : '本次未取得可用外部资料，仅依据本地材料，尚不能做独立交叉验证。',
      '这是对已取得材料的说明，尚未验证所有结论的语义支持关系。',
    ].filter(Boolean).join('\n\n');
    return sse({ content });
  }
  return realFetch(input, opts);
};

const model = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const response = await globalThis.fetch('http://127.0.0.1:18992/v1/chat/completions', { body: Buffer.concat(chunks).toString('utf8') });
  res.writeHead(response.status, { 'content-type': 'text/event-stream' });
  res.end(await response.text());
});
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(path.join(process.env.DATA_DIR, '.joint-model-port'), String(model.address().port));
model.unref();
