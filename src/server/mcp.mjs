/**
 * MCP（Model Context Protocol）服务端。
 *
 * 传输：HTTP POST /mcp（JSON-RPC 2.0）+ stdio（供 Claude Desktop / Cursor 等本地客户端）。
 *
 * 工具面参考两个生态项目：
 *   - mcp-server-qdrant：qdrant-store / qdrant-find 的语义与命名保持一致，
 *     已适配该工具名的客户端可以直接换过来用。
 *   - RAGFlow MCP：ragflow_retrieve 透传外部知识源检索。
 * 在此之上补齐本应用自己的知识库工具。
 */

import { ragStatus, listDisciplines, getPaper, verifyQuote, buildContent, charCoverage } from './rag.mjs';
import { retrieveAll, retrievalStatus } from './retrieve.mjs';
import { listDocuments, getChunkById, verifyChunkQuote, isSectionId, sectionDocIds } from './kb.mjs';
import { upsertVectors, searchVectors, vectorStatus, embeddingEnabled } from './vector.mjs';
import { searchExternal, ragflowStatus } from './ragflow.mjs';
import { config } from './config.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_USER = process.env.MCP_USER_ID || 'mcp';

const TOOLS = [
  {
    name: 'search_knowledge',
    description:
      '检索知识库：CSL 中文核心期刊论文库 + 用户上传文档，多通道（全文/向量/外部源）融合。返回 ref、来源、命中原句与字符区间。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '中文检索词' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
        discipline: { type: 'string', description: '可选学科过滤' },
        source: { type: 'string', enum: ['all', 'paper', 'doc'], default: 'all' },
        user_id: { type: 'string', description: '上传文档归属用户，默认取 MCP_USER_ID' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_source',
    description: '读取某条依据的完整内容（论文摘要或文档片段）。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, user_id: { type: 'string' } },
      required: ['ref'],
    },
  },
  {
    name: 'verify_quote',
    description: '校验引文是否逐字出现在指定依据中，返回字符区间。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, quote: { type: 'string' }, user_id: { type: 'string' } },
      required: ['ref', 'quote'],
    },
  },
  {
    name: 'list_documents',
    description: '列出已上传的知识库文档。',
    inputSchema: {
      type: 'object',
      properties: { user_id: { type: 'string' } },
    },
  },
  {
    name: 'corpus_stats',
    description: '返回文献库规模、学科分布与各检索通道状态。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'qdrant-store',
    description: '把一段信息写入向量库，便于之后按语义检索（对齐 mcp-server-qdrant 的 qdrant-store）。',
    inputSchema: {
      type: 'object',
      properties: {
        information: { type: 'string', description: '要长期保存的信息' },
        metadata: { type: 'object', description: '可选元数据，会一并存储' },
        user_id: { type: 'string' },
      },
      required: ['information'],
    },
  },
  {
    name: 'qdrant-find',
    description: '按语义在向量库中检索已保存的信息（对齐 mcp-server-qdrant 的 qdrant-find）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
        user_id: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'kb_retrieve',
    description:
      '内置知识库检索（无需外部服务，沙箱可用）。参数与 RAGFlow retrieval 对齐：question / dataset_ids / page_size / similarity_threshold。' +
      'dataset_ids 取值 papers（论文库）、kb（上传文档），缺省为两者。返回 JSON，含 chunks[].content / document_keyword / similarity。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        dataset_ids: {
          type: 'array',
          items: { type: 'string', enum: ['papers', 'kb', 'all'] },
          description: '缺省检索全部数据集',
        },
        page: { type: 'integer', default: 1 },
        page_size: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
        similarity_threshold: { type: 'number', default: 0.2 },
        user_id: { type: 'string', description: '检索 kb 数据集时的归属用户' },
      },
      required: ['question'],
    },
  },
  {
    name: 'ragflow_retrieve',
    description: '调用 RAGFlow 外部知识源检索（MCP 优先，REST 兜底）。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        top_k: { type: 'integer', minimum: 1, maximum: 20, default: 6 },
        dataset_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['question'],
    },
  },
];

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function err(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const textResult = (text, isError = false) => ({ content: [{ type: 'text', text }], isError });

export async function callMcpTool(name, args = {}, ctx = {}) {
  // '*' 只在受信通道（本机 HTTP / stdio）可用，避免公网 MCP 端点跨用户读取
  // 非受信通道（公网 HTTP）只能用调用者本人的身份，不允许指定任意 user_id
  const requested = String(args.user_id || ctx.callerId || DEFAULT_USER);
  const userId = ctx.allowAll ? (requested === '*' ? '*' : requested) : ctx.callerId || requested;
  const stored = userId !== '*' && await ctx.getPreferences?.(userId);
  const discipline = isSectionId(stored?.discipline) ? stored.discipline : args.discipline || '';
  const docIds = await sectionDocIds(userId, discipline);
  if (docIds && (name === 'read_source' || name === 'verify_quote')) {
    const ref = String(args.ref || '');
    const chunk = !/^\d+$/.test(ref) && await getChunkById(ref, userId);
    if (!chunk || !docIds.includes(chunk.docId)) return textResult('该来源不在当前知识库分区内。', true);
  }
  if (docIds && name === 'ragflow_retrieve') return textResult('当前分区仅包含私人文档。', true);

  if (name === 'search_knowledge') {
    const source = ['all', 'paper', 'doc'].includes(args.source) ? args.source : 'all';
    const channels =
      source === 'paper' ? ['paper', 'vector'] : source === 'doc' ? ['kb', 'vector'] : ['paper', 'kb', 'vector', 'external'];
    const r = await retrieveAll(String(args.query || ''), {
      userId,
      k: Math.min(20, Number(args.top_k) || 6),
      discipline,
      rewrite: false,
      channels,
      sourceKind: source === 'all' ? null : source === 'paper' ? 'paper' : 'doc',
    });
    if (!r.results.length) return textResult(`未检索到与「${args.query}」相关的依据。`);
    const body = r.results
      .map((x, i) => {
        const tag = x.kind === 'paper' ? '论文' : x.kind === 'doc' ? '文档' : '外部';
        return `[${i + 1}] ref=${x.ref}｜[${tag}] ${x.title}${x.heading ? ' · ' + x.heading : ''}\n区间：${x.locatable ? `${x.start}-${x.end}` : '无字符偏移'}\n${x.snippet}`;
      })
      .join('\n\n');
    return textResult(
      `共 ${r.results.length} 条（覆盖度 ${r.coverage}，通道 ${r.channels.map((c) => `${c.name}:${c.hits}`).join(' ')}）\n\n${body}`
    );
  }

  if (name === 'read_source') {
    const ref = String(args.ref || '');
    if (/^\d+$/.test(ref)) {
      const p = await getPaper(Number(ref));
      if (!p) return textResult('未找到该论文。', true);
      return textResult(`ref=${ref}\n标题：${p.title}\n学科：${p.discipline}／${p.category}\n关键词：${p.keywords}\n\n${buildContent(p)}`);
    }
    const c = await getChunkById(ref, userId);
    if (!c) return textResult('未找到该文档片段。', true);
    return textResult(`ref=${ref}\n文档：${c.docName}${c.heading ? ' · ' + c.heading : ''}\n字符 ${c.start}-${c.end}\n\n${c.text}`);
  }

  if (name === 'verify_quote') {
    const ref = String(args.ref || '');
    const quote = String(args.quote || '');
    let r;
    if (/^\d+$/.test(ref)) r = await verifyQuote(Number(ref), quote);
    else r = await verifyChunkQuote(ref, userId, quote);
    return textResult(JSON.stringify(r));
  }

  if (name === 'list_documents') {
    const docs = (await listDocuments(userId)).filter(d => !docIds || docIds.includes(d.id));
    if (!docs.length) return textResult('还没有上传任何文档。');
    return textResult(
      docs
        .map((d) => `- ${d.name}（${d.kind}, ${d.charCount} 字, ${d.chunkCount} 段）id=${d.id}`)
        .join('\n')
    );
  }

  if (name === 'corpus_stats') {
    const s = ragStatus();
    const top = listDisciplines().slice(0, 8).map((d) => `${d.name}(${d.count})`).join('、');
    const v = vectorStatus();
    const ext = ragflowStatus();
    return textResult(
      `论文 ${s.papers} 篇，学科 ${s.disciplines} 个，引擎 ${s.engine}\n` +
        `向量通道：${v.engine}${v.ready ? `（${v.embedding}）` : '（未启用）'}\n` +
        `外部源：${ext.mode}${ext.ready ? '' : '（未启用）'}\n` +
        `主要学科：${top}`
    );
  }

  if (name === 'qdrant-store') {
    if (!embeddingEnabled()) return textResult('向量通道未启用，无法存储。', true);
    const info = String(args.information || '').trim();
    if (!info) return textResult('information 不能为空。', true);
    const ref = `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const r = await upsertVectors([
      {
        ref,
        text: info,
        payload: {
          kind: 'memory',
          userId,
          docName: 'MCP 记忆',
          text: info,
          metadata: args.metadata || null,
          createdAt: new Date().toISOString(),
        },
      },
    ]);
    return textResult(`已保存到向量库（ref=${ref}，${r.dim} 维）。`);
  }

  if (name === 'qdrant-find') {
    if (!embeddingEnabled()) return textResult('向量通道未启用，无法检索。', true);
    // 默认只在本用户范围内检索；跨用户需要受信通道显式传 user_id='*'
    const r = await searchVectors(String(args.query || ''), {
      docIds,
      kind: docIds ? 'doc' : null,
      k: Math.min(20, Number(args.limit) || 5),
      minScore: 0.05,
      userId: userId === '*' ? null : userId,
    });
    if (!r.results.length) return textResult('没有找到相关记忆。');
    return textResult(
      r.results
        .map((x, i) => {
          const p = x.payload || {};
          const label = p.kind === 'memory' ? '记忆' : p.kind === 'doc' ? '文档' : '论文';
          return `[${i + 1}] [${label}] ${p.docName || p.title || p.ref}｜相似度 ${x.score.toFixed(3)}\n${String(p.text || '').slice(0, 400)}`;
        })
        .join('\n\n')
    );
  }

  if (name === 'kb_retrieve') {
    const question = String(args.question || '').trim();
    if (!question) return textResult('question 不能为空。', true);

    const requested = Array.isArray(args.dataset_ids) && args.dataset_ids.length ? args.dataset_ids : ['papers', 'kb'];
    const wantPapers = requested.includes('all') || requested.includes('papers');
    const wantKb = requested.includes('all') || requested.includes('kb');
    const channels = [];
    if (wantPapers) channels.push('paper');
    if (wantKb) channels.push('kb');
    if (wantKb) channels.push('vector');

    const pageSize = Math.max(1, Math.min(20, Number(args.page_size) || 6));
    const threshold = Number.isFinite(Number(args.similarity_threshold)) ? Number(args.similarity_threshold) : 0.2;

    const r = await retrieveAll(question, {
      discipline,
      userId: wantKb ? userId : null,
      k: pageSize * 3,
      rewrite: false,
      channels,
    });

    const chunks = r.results
      .map((x) => {
        const similarity = charCoverage(question, `${x.title}${x.content || ''}`);
        return {
          id: x.ref,
          content: String(x.content || x.snippet || '').slice(0, 1200),
          document_keyword: x.docName || x.title,
          dataset_id: x.kind === 'paper' ? 'papers' : 'kb',
          similarity: Number(similarity.toFixed(4)),
          char_start: x.start,
          char_end: x.end,
          locatable: x.locatable !== false,
          channels: x.channels,
        };
      })
      .filter((c) => c.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, pageSize);

    return textResult(
      JSON.stringify(
        {
          backend: 'embedded',
          datasets: [...(wantPapers ? ['papers'] : []), ...(wantKb ? ['kb'] : [])],
          total: chunks.length,
          channels: r.channels.map((c) => `${c.name}:${c.hits}`),
          chunks,
        },
        null,
        0
      )
    );
  }

  if (name === 'ragflow_retrieve') {
    if (!ragflowStatus().ready) return textResult('RAGFlow 未配置或不可用。', true);
    const r = await searchExternal(String(args.question || ''), {
      k: Math.min(20, Number(args.top_k) || 6),
      datasetIds: args.dataset_ids,
    });
    if (!r.results.length) return textResult('RAGFlow 未返回结果。');
    return textResult(
      r.results.map((x, i) => `[${i + 1}] ${x.title}｜相似度 ${x.score.toFixed(3)}\n${x.content.slice(0, 400)}`).join('\n\n')
    );
  }

  return textResult(`未知工具：${name}`, true);
}

/** 处理一条 JSON-RPC 消息；通知类消息返回 null */
export async function handleMcp(body, ctx = {}) {
  if (Array.isArray(body)) {
    const out = [];
    for (const item of body) {
      const r = await handleMcp(item, ctx);
      if (r) out.push(r);
    }
    return out.length ? out : null;
  }

  const { id, method, params } = body || {};
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;

  try {
    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'csl-knowledge-mcp', version: config.version },
      });
    }
    if (method === 'ping') return ok(id, {});
    if (method === 'tools/list') return ok(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const result = await callMcpTool(params?.name, params?.arguments || {}, ctx);
      return ok(id, result);
    }
    return err(id, -32601, `Method not found: ${method}`);
  } catch (e) {
    return err(id, -32603, String(e.message || e));
  }
}

export { TOOLS };

/** stdio 模式：逐行读写 JSON-RPC */
export async function runStdio(getPreferences) {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let body;
    try {
      body = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify(err(null, -32700, 'Parse error')) + '\n');
      continue;
    }
    const res = await handleMcp(body, { allowAll: true, getPreferences });
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  }
}

export { retrievalStatus };
