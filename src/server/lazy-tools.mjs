const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
export const LAZY_TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'tool_search', description: '按关键词查询当前任务有权使用的工具，返回完整参数定义。检索不执行工具。', parameters: object({ keyword: { type: 'string', minLength: 1, maxLength: 120 } }) } },
  { type: 'function', function: { name: 'tool_describe', description: '读取当前任务中某个工具的完整参数定义。', parameters: object({ name: { type: 'string', minLength: 1, maxLength: 80 } }) } },
  { type: 'function', function: { name: 'tool_call', description: '调用已查询的工具；仍执行原工具的权限、参数校验、预算及审批，不授予额外权限。', parameters: object({ name: { type: 'string', minLength: 1, maxLength: 80 }, arguments: { type: 'object' } }) } },
];
const reserved = new Set(LAZY_TOOL_SCHEMAS.map(s => s.function.name));
export function searchToolSchemas(schemas, keyword, { limit = 5 } = {}) {
  const q = String(keyword || '').normalize('NFKC').toLowerCase().trim().slice(0, 120);
  if (!q) return [];
  const terms = q.split(/[\s,，、/]+/).filter(Boolean);
  // Discovery aliases only rank already-authorized schemas; they never grant capability.
  if(/浏览器|打开网页|打开网站|电脑|桌面|computer|desktop|browser/.test(q))terms.push('browser','desktop_open_url');
  if(/插件|扩展|plugin|extension|mcp/.test(q))terms.push('extension');
  return schemas.filter(s => !reserved.has(s.function.name)).map(s => ({ schema: s, score: (s.function.name.toLowerCase()===q?20:0)+[...new Set(terms)].reduce((n,t) => n + (s.function.name.toLowerCase().includes(t) ? 3 : (s.function.description || '').toLowerCase().includes(t) ? 1 : 0), 0) }))
    .filter(r => r.score > 0).sort((a,b) => b.score - a.score).slice(0, Math.min(8, Math.max(1, limit))).map(r => r.schema);
}
export function describeToolSchema(schemas, name) { return schemas.find(s => s.function.name === name && !reserved.has(name)) || null; }
export function lazyToolCatalog(schemas, expanded = new Set(), { threshold = 30, always = [] } = {}) {
  if (schemas.length <= threshold) return { tools: schemas, index: '', lazy: false };
  const selected = schemas.filter(s => expanded.has(s.function.name) || always.includes(s.function.name));
  return { tools: [...selected, ...LAZY_TOOL_SCHEMAS], lazy: true,
    index: schemas.map(s => `${s.function.name}: ${String(s.function.description || '').split(/[。\n]/)[0].slice(0, 100)}`).join('\n') };
}
/** Return the effective call only. Caller MUST pass it through its original validator/approval/executor. */
export function resolveLazyToolCall(call, schemas, expanded = new Set()) {
  const name = call.name || call.function?.name;
  let args = call.arguments ?? call.function?.arguments ?? {};
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw new Error('invalid_tool_arguments'); } }
  if (name !== 'tool_call') return { name, arguments: args };
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['name','arguments'].includes(k)) ||
      !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments) || JSON.stringify(args.arguments).length > 32000 ||
      !expanded.has(args.name) || !describeToolSchema(schemas, args.name)) throw new Error('tool_not_described_or_not_available');
  return { name: args.name, arguments: args.arguments };
}
