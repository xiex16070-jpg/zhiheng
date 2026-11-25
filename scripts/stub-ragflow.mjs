/**
 * RAGFlow 协议桩：用于验证客户端在 MCP 与 REST 两种传输下的行为。
 *
 * 本机没有部署 RAGFlow（需要 Docker + Elasticsearch/Infinity + MinIO + MySQL），
 * 这里按官方接口形态返回固定数据，验证的是「我们的客户端实现是否正确」，
 * 不代表 RAGFlow 的真实检索质量。
 *
 *   node scripts/stub-ragflow.mjs [port]        # 默认 9380
 *   MCP=0 node scripts/stub-ragflow.mjs         # 只提供 REST，用于验证降级
 */

import http from 'node:http';

const PORT = Number(process.argv[2] || 9380);
const ENABLE_MCP = process.env.MCP !== '0';

const CHUNKS = [
  {
    id: 'rf-chunk-1',
    content:
      '牡丹籽油富含不饱和脂肪酸，其中 α-亚麻酸占比可达 40% 以上，具有抗氧化与降血脂作用。提取工艺以冷榨与超临界 CO2 为主。',
    document_id: 'doc-1001',
    document_keyword: '牡丹籽油加工工艺研究报告.pdf',
    similarity: 0.87,
    important_keywords: ['牡丹籽油', 'α-亚麻酸'],
  },
  {
    id: 'rf-chunk-2',
    content:
      '鲜切花采后冷链断链是损耗主因，建议在 2 小时内完成预冷，全程维持 2-4℃，可将瓶插寿命延长 3-5 天。',
    document_id: 'doc-1002',
    document_keyword: '鲜切花冷链技术规范.docx',
    similarity: 0.74,
    important_keywords: ['冷链', '预冷'],
  },
];

const TOOLS = [
  {
    name: 'ragflow_retrieval',
    description: 'Retrieve chunks from RAGFlow datasets.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        dataset_ids: { type: 'array', items: { type: 'string' } },
        document_ids: { type: 'array', items: { type: 'string' } },
        page: { type: 'integer' },
        page_size: { type: 'integer' },
        similarity_threshold: { type: 'number' },
        vector_similarity_weight: { type: 'number' },
        top_k: { type: 'integer' },
        keyword: { type: 'boolean' },
      },
      required: ['question'],
    },
  },
];

const readJson = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (status, body) => {
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  };

  if (url.pathname === '/api/v1/datasets') {
    return json(200, { code: 0, data: [{ id: 'ds-1', name: '牡丹产业知识库' }] });
  }

  if (url.pathname === '/api/v1/retrieval' && req.method === 'POST') {
    const body = await readJson(req);
    const k = Number(body.page_size) || 6;
    console.log(`[stub] REST retrieval q="${body.question}" datasets=${(body.dataset_ids || []).join(',')}`);
    return json(200, {
      code: 0,
      data: { chunks: CHUNKS.slice(0, k), total: CHUNKS.length, doc_aggs: [] },
    });
  }

  if (url.pathname === '/mcp' && ENABLE_MCP) {
    const body = await readJson(req);
    const { id, method, params } = body;
    if (method === 'initialize') {
      return json(200, {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'ragflow-stub', version: '0.1.0' },
        },
      });
    }
    if (method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (method === 'tools/list') return json(200, { jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const args = params?.arguments || {};
      console.log(`[stub] MCP call ${params?.name} q="${args.question}" datasets=${(args.dataset_ids || []).join(',')}`);
      if (params?.name !== 'ragflow_retrieval') {
        return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool' } });
      }
      const k = Number(args.page_size) || 6;
      return json(200, {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ chunks: CHUNKS.slice(0, k), total: CHUNKS.length }) }],
        },
      });
    }
    return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } });
  }

  json(404, { code: 404, message: 'not found' });
});

server.listen(PORT, '127.0.0.1', () =>
  console.log(`[stub-ragflow] http://127.0.0.1:${PORT}  MCP=${ENABLE_MCP ? 'on' : 'off'}`)
);
