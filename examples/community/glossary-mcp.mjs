/** Local stdio example using only a fixed glossary and the project's MCP SDK. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const glossary = new Map([
  ['引文', '引文是可在资料中找到的文字。记录出处和位置，方便回到上下文核对。'],
  ['证据不足', '手头材料不足以支持或反驳该主张。列出还需要核查的出处或条件。'],
]);

const server = new Server({ name: 'zhiheng-glossary-example', version: '0.1.0' }, {
  capabilities: { tools: {} },
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'lookup_term',
    description: '查询示例词条「引文」或「证据不足」。',
    inputSchema: {
      type: 'object',
      properties: { term: { type: 'string', enum: [...glossary.keys()] } },
      required: ['term'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const args = params.arguments ?? {};
  const value = params.name === 'lookup_term' && Object.keys(args).length === 1 && glossary.get(args.term);
  return {
    content: [{ type: 'text', text: value || '请选择已列出的词条。' }],
    ...(value ? {} : { isError: true }),
  };
});

await server.connect(new StdioServerTransport());
