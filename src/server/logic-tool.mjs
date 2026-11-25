/** Evidence boundary for the deterministic HanLogic interpreter. No I/O or model call. */
import { runAgentProgram } from './logic-runtime.mjs';
import { resolveLogicRef } from './logic-verification.mjs';
import { locateNormalizedQuote } from './quote.mjs';

const MAX_PROGRAM = 20000;
const MAX_BINDINGS = 256;
const MAX_OUTPUT = 120000;

export const LOGIC_TOOL_SCHEMA = {
  type: 'function',
  function: {
    name: 'logic_evaluate',
    description: '执行知衡中文逻辑程序，检查规则链、必要/充分条件和矛盾，返回四值查询与证明图。只读、有界、无模型调用。默认每条事实/规则必须附依据ref，并在bindings中逐条提供原文引文；引用存在和引文命中不代表符号化语义正确。只有用户明确给定假设、要求演示或程序测试时才设allow_assumptions=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        program: { type: 'string', maxLength: MAX_PROGRAM, description: '知衡源码；每条声明独占一行。例如：事实 已证明(程序甲) 依据 "ref1"。\n规则 安全：若 已证明(?程序) 则 安全(?程序) 依据 "ref2"。\n查询 安全(程序甲)。' },
        bindings: { type: 'array', maxItems: MAX_BINDINGS, description: '每个声明行及ref对应的逐字原文。line为事实/规则首词所在行，从1开始。', items: {
          type: 'object', additionalProperties: false, properties: {
            line: { type: 'integer', minimum: 1 },
            ref: { type: 'string', description: '本轮检索已返回且源码依据声明使用的ref' },
            quote: { type: 'string', minLength: 4, maxLength: 2000 },
          }, required: ['line', 'ref', 'quote'],
        } },
        allow_assumptions: { type: 'boolean', default: false, description: '仅运行用户给定假设/程序练习时允许未绑定来源的事实或规则；结果仍是条件推演。' },
      }, required: ['program'],
    },
  },
};

const { program, bindings } = LOGIC_TOOL_SCHEMA.function.parameters.properties;
export const LOGIC_ASSUMPTIONS_SCHEMA = { type: 'function', function: {
  name: 'logic_run_assumptions', description: '按用户给定的练习前提运行知衡程序，返回条件推演及查询状态。',
  parameters: { type: 'object', additionalProperties: false, properties: { program }, required: ['program'] },
} };
export const LOGIC_GROUNDED_SCHEMA = { type: 'function', function: {
  name: 'logic_evaluate_grounded', description: '运行有文献依据的知衡程序，每条事实与规则必须绑定本轮来源和逐字引文。',
  parameters: { type: 'object', additionalProperties: false, properties: { program, bindings }, required: ['program', 'bindings'] },
} };

function invalid(code, message, line = null, column = null) {
  return { ok: false, error: { code, message, line, column } };
}

/** Source checks never promote arbitrary predicates or user-supplied rules to verified facts. */
export async function evaluateLogicProgram(args = {}, { evidence = new Map(), signal, mode = 'logic_evaluate', refAliases, algorithm } = {}) {
  if (signal?.aborted) return invalid('aborted', '推演已取消。');
  if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid('arguments_invalid', '工具参数必须是对象。');
  if (typeof args.program !== 'string' || !args.program.trim()) return invalid('program_required', '请提供知衡程序。');
  if (args.program.length > MAX_PROGRAM) return invalid('program_too_large', `Agent 程序最多 ${MAX_PROGRAM} 个字符。`);
  const bindings = args.bindings ?? [];
  if (!Array.isArray(bindings) || bindings.length > MAX_BINDINGS) return invalid('bindings_invalid', '引文绑定必须是至多256项的数组。');
  if (args.allow_assumptions != null && typeof args.allow_assumptions !== 'boolean') return invalid('assumption_flag_invalid', 'allow_assumptions 必须是布尔值。');
  if (mode !== 'logic_evaluate' && args.allow_assumptions != null) {
    return invalid('assumption_flag_invalid', '请按任务选择假设工具或文献工具。');
  }
  const allowAssumptions = mode === 'logic_run_assumptions' || (mode === 'logic_evaluate' && args.allow_assumptions === true);
  try {
    // Transfer offsets and short quotes to the worker, never full source documents.
    const bindingChecks = [];
    for (const binding of bindings) {
      if (!binding || !Number.isInteger(binding.line) || binding.line < 1 || typeof binding.ref !== 'string') {
        return invalid('binding_invalid', '引文绑定须含有效行号和ref。');
      }
      const { line, quote } = binding;
      const ref = resolveLogicRef(binding.ref, refAliases);
      if (!ref) {
        bindingChecks.push({ line, ref: binding.ref, unknownAlias: true });
        continue;
      }
      if (typeof quote !== 'string' || quote.trim().length < 4 || quote.length > 2000) {
        bindingChecks.push({ line, ref, error: { code: 'binding_invalid', message: '已使用的引文须含4–2000字的原文。' } });
        continue;
      }
      const item = evidence.get(ref);
      if (!item) {
        bindingChecks.push({ line, ref, error: { code: 'reference_not_retrieved', message: `依据 ${ref} 不在本轮可访问的检索结果中。` } });
        continue;
      }
      // Same matching as verify_quote: PDF line wraps and spacing inside the source
      // must not reject a quote, and the recorded quote is the exact source substring.
      const located = locateNormalizedQuote(String(item.content || item.snippet || ''), quote);
      if (!located.found) {
        bindingChecks.push({ line, ref, error: { code: 'source_quote_mismatch', message: `依据 ${ref} 未逐字包含给定引文。` } });
        continue;
      }
      bindingChecks.push({ line, ref, quote: located.quote, start: located.start, end: located.end, title: String(item.title || item.docName || ''),
        sourceUrl: item.sourceUrl || item.url || null, status: 'source_quote_checked', semanticMappingVerified: false });
    }
    const run = await runAgentProgram(args.program, { mode, algorithm, bindingChecks, allowAssumptions, availableRefs: new Set(evidence.keys()), refAliases });
    if (signal?.aborted) return invalid('aborted', '推演已取消。');
    const result = { ok: true, ...run };
    if (JSON.stringify(result).length > MAX_OUTPUT) return invalid('logic_output_limit', '证明输出过大；请减少事实或查询后重试，不将截断结果冒充完整证明。');
    return result;
  } catch (error) {
    if (typeof error.code === 'string') return invalid(error.code, String(error.message).slice(0, 400), error.line, error.column);
    return invalid('logic_evaluation_failed', '推演执行失败，请检查程序或缩小输入。');
  }
}
