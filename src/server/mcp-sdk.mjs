/**
 * Opt-in MCP SDK transport. Business tools remain shared with the legacy path.
 * HTTP is stateless: every authenticated request gets its own server/identity.
 * SDK imports stay lazy so MCP_SDK_ENABLED=0 keeps the original startup path.
 */
import { config } from './config.mjs';
import { ID_RE } from './auth.mjs';
import { TOOLS, callMcpTool } from './mcp.mjs';

let sdkPromise;
function loadSdk() {
  sdkPromise ||= Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/streamableHttp.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('@modelcontextprotocol/sdk/validation/ajv'),
  ]).then(([server, http, stdio, types, validation]) => {
    const validator = new validation.AjvJsonSchemaValidator();
    return {
      ...server, ...http, ...stdio, ...types,
      validators: new Map(TOOLS.map((tool) => [tool.name, validator.getValidator(tool.inputSchema)])),
    };
  });
  return sdkPromise;
}

/** ctx must come from resolveMcpCaller (HTTP) or the trusted stdio entrypoint. */
export async function createMcpSdkServer(ctx) {
  if (!ctx || !ID_RE.test(String(ctx.callerId || ''))) throw new Error('mcp_identity_required');
  const caller = Object.freeze({ callerId: String(ctx.callerId), allowAll: ctx.allowAll === true, getPreferences: ctx.getPreferences });
  const { Server, ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode, validators } = await loadSdk();
  const server = new Server(
    { name: 'csl-knowledge-mcp', version: config.version },
    { capabilities: { tools: { listChanged: false } } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    const validate = validators.get(name);
    if (!validate) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    const checked = validate(args);
    if (!checked.valid) throw new McpError(ErrorCode.InvalidParams, `Invalid tool arguments: ${checked.errorMessage}`);
    if (args.user_id !== undefined) {
      const requested = args.user_id;
      if ((!caller.allowAll && requested !== caller.callerId) ||
          (requested !== '*' && !ID_RE.test(requested)) || (requested === '*' && !caller.allowAll)) {
        throw new McpError(ErrorCode.InvalidParams, 'user_id is not authorized for this caller');
      }
    }
    try {
      return await callMcpTool(name, args, caller);
    } catch (error) {
      // Tool errors use the MCP tool-result contract, not leaked stack traces.
      console.error(`[mcp-sdk] ${name}: ${error?.message || error}`);
      return { content: [{ type: 'text', text: '工具执行失败，请稍后重试。' }], isError: true };
    }
  });
  return server;
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(status === 405 ? { allow: 'POST' } : {}) });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

/** Reject browser cross-origin requests and rebinding against trusted local mode. */
function validHttpOrigin(req, ctx) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch { return false; }
  if (host.username || host.password || host.pathname !== '/' || host.search || host.hash) return false;
  if (ctx.allowAll && !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) return false;
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== host.host) return false;
    } catch { return false; }
  }
  return true;
}

export async function handleMcpSdkHttp(req, res, ctx, parsedBody) {
  if (!validHttpOrigin(req, ctx)) return jsonError(res, 403, 'MCP Host or Origin is not allowed');
  if (req.method !== 'POST') return jsonError(res, 405, 'Stateless MCP supports POST only');
  const server = await createMcpSdkServer(ctx);
  const { StreamableHTTPServerTransport } = await loadSdk();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: 1024 * 1024,
  });
  const close = () => { void server.close().catch(() => {}); };
  res.once('close', close);
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    await server.close().catch(() => {});
    if (!res.headersSent) return jsonError(res, 500, 'MCP transport error');
    if (!res.writableEnded) res.end();
  }
}

export async function runSdkStdio(getPreferences) {
  const server = await createMcpSdkServer({ callerId: config.mcp.userId, allowAll: true, getPreferences });
  const { StdioServerTransport } = await loadSdk();
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 });
  server.onerror = (error) => console.error(`[mcp-sdk] ${error.message}`);
  process.stdin.once('end', () => { void server.close().catch(() => {}); });
  await server.connect(transport);
  return server;
}
