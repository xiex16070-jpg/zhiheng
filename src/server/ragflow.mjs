/**
 * RAGFlow 外部知识源接入。
 *
 * 两种传输，自动选择：
 *   1. MCP（JSON-RPC over HTTP）——调用 ragflow_retrieval 工具，语义与官方 MCP server 一致
 *   2. REST —— POST {base}/api/v1/retrieval，Bearer API Key
 *
 * 归一化后的结果统一标记 kind='external'。RAGFlow 只返回片段文本与相似度，
 * 不提供原文字符偏移，因此 start/end 置 0、locatable=false，UI 不假装能高亮。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { config } from './config.mjs';

const state = {
  mode: 'off', // mcp | rest | off
  ready: false,
  error: '',
  sessionId: '',
  tools: [],
  lastProbe: null,
};

function request(url, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* 可能是 SSE */
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const authHeaders = () => (config.ragflow.apiKey ? { authorization: `Bearer ${config.ragflow.apiKey}` } : {});

/* ---------------------------------------------------------------- MCP */

let rpcId = 0;

async function mcpCall(method, params, { notify = false } = {}) {
  const url = `${config.ragflow.baseUrl}${config.ragflow.mcpPath}`;
  const body = { jsonrpc: '2.0', method, params };
  if (!notify) body.id = ++rpcId;

  const res = await request(url, {
    method: 'POST',
    headers: {
      ...authHeaders(),
      accept: 'application/json, text/event-stream',
      ...(state.sessionId ? { 'mcp-session-id': state.sessionId } : {}),
    },
    body,
    timeout: 6000,
  });

  const sid = res.headers?.['mcp-session-id'];
  if (sid) state.sessionId = sid;

  if (res.status >= 400) throw new Error(`mcp_http_${res.status}`);

  // 兼容 SSE 响应：取最后一条 data
  let payload = res.json;
  if (!payload && res.text.includes('data:')) {
    const lines = res.text.split('\n').filter((l) => l.startsWith('data:'));
    for (const line of lines.reverse()) {
      try {
        payload = JSON.parse(line.slice(5).trim());
        break;
      } catch {
        /* 继续 */
      }
    }
  }
  if (!payload) throw new Error('mcp_bad_response');
  if (payload.error) throw new Error(payload.error.message || 'mcp_error');
  return payload.result;
}

async function probeMcp() {
  const init = await mcpCall('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'csl-literature-agent', version: config.version },
  });
  await mcpCall('notifications/initialized', {}, { notify: true }).catch(() => null);
  const list = await mcpCall('tools/list', {});
  state.tools = (list?.tools || []).map((t) => t.name);
  if (!state.tools.length) throw new Error('mcp_no_tools');
  return init?.serverInfo?.name || 'ragflow-mcp';
}

/* ---------------------------------------------------------------- REST */

async function probeRest() {
  const res = await request(`${config.ragflow.baseUrl}/api/v1/datasets?page=1&page_size=1`, {
    headers: authHeaders(),
    timeout: 6000,
  });
  if (res.status === 401 || res.status === 403) throw new Error('rest_unauthorized');
  if (res.status >= 400) throw new Error(`rest_http_${res.status}`);
  if (res.json && res.json.code !== 0) throw new Error(res.json.message || 'rest_error');
  return 'ragflow-rest';
}

/* ---------------------------------------------------------------- 生命周期 */

export function ragflowStatus() {
  return {
    enabled: config.ragflow.enabled,
    mode: state.mode,
    ready: state.ready,
    baseUrl: config.ragflow.baseUrl || null,
    tools: state.tools,
    datasets: config.ragflow.datasetIds.length,
    error: state.error || undefined,
  };
}

export async function initRagflow() {
  if (!config.ragflow.enabled) {
    state.mode = 'off';
    return ragflowStatus();
  }
  try {
    const name = await probeMcp();
    state.mode = 'mcp';
    state.ready = true;
    state.error = '';
    state.lastProbe = { transport: 'mcp', server: name };
    return ragflowStatus();
  } catch (err) {
    state.error = `mcp: ${err.message}`;
  }
  try {
    const name = await probeRest();
    state.mode = 'rest';
    state.ready = true;
    state.error = '';
    state.lastProbe = { transport: 'rest', server: name };
  } catch (err) {
    state.error = `${state.error}; rest: ${err.message}`;
    state.mode = 'off';
    state.ready = false;
  }
  return ragflowStatus();
}

/* ---------------------------------------------------------------- 检索 */

export function normalizeChunk(c) {
  const content = String(c.content || c.text || c.chunk || '').trim();
  if (!content) return null;
  const docName = c.document_keyword || c.document_name || c.doc_name || c.document_id || 'RAGFlow 文档';
  const id = String(c.id ?? c.chunk_id ?? '');
  // External IDs must be representable by the citation grammar. In particular, a
  // missing ID cannot be the result's rank, which repeats on the next query.
  const ref = /^[A-Za-z0-9_-]{1,61}$/.test(id) ? `rf_${id}` :
    'rfh_' + createHash('sha256').update(JSON.stringify([id, c.dataset_id, c.document_id, docName, content])).digest('hex').slice(0, 56);
  return {
    ref,
    kind: 'external',
    title: docName,
    docName,
    heading: c.important_keywords?.join('、') || '',
    snippet: content.length > 260 ? `${content.slice(0, 260)}…` : content,
    content,
    start: 0,
    end: 0,
    locatable: false,
    source: 'ragflow',
    score: Number(c.similarity ?? c.score ?? 0) || 0,
  };
}

/**
 * @param {string} question
 * @param {{k?:number, datasetIds?:string[]}} opts
 */
export async function searchExternal(question, opts = {}) {
  if (!state.ready) return { results: [], engine: state.mode };
  const k = Math.max(1, Math.min(30, opts.k || config.retrieval.externalTopK));
  const datasetIds = opts.datasetIds?.length ? opts.datasetIds : config.ragflow.datasetIds;

  if (state.mode === 'mcp') {
    const tool = state.tools.find((t) => /retriev/i.test(t)) || state.tools[0];
    const result = await mcpCall('tools/call', {
      name: tool,
      arguments: {
        question,
        dataset_ids: datasetIds,
        page: 1,
        page_size: k,
        similarity_threshold: 0.2,
        vector_similarity_weight: 0.3,
        top_k: 1024,
        keyword: false,
      },
    });
    const text = result?.content?.find((c) => c.type === 'text')?.text || '';
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const chunks = data?.chunks || data?.data?.chunks || (Array.isArray(data) ? data : []);
    return {
      engine: 'ragflow-mcp',
      results: chunks.map(normalizeChunk).filter(Boolean).slice(0, k),
    };
  }

  const res = await request(`${config.ragflow.baseUrl}/api/v1/retrieval`, {
    method: 'POST',
    headers: authHeaders(),
    body: {
      question,
      dataset_ids: datasetIds,
      page: 1,
      page_size: k,
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.3,
      top_k: 1024,
      keyword: false,
      highlight: false,
    },
    timeout: 30000,
  });
  if (res.status >= 400) throw new Error(`ragflow_http_${res.status}`);
  const chunks = res.json?.data?.chunks || [];
  return {
    engine: 'ragflow-rest',
    results: chunks.map(normalizeChunk).filter(Boolean).slice(0, k),
  };
}
