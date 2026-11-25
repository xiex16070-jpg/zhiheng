import { runProgram, HanLogicError } from '../logic/hanlogic.mjs';

// A map (including an empty one) is supplied only for the local model.
// An unassigned alias must not fall back to a same-named real external ref.
export function resolveLogicRef(value, aliases) {
  return aliases && /^S[1-9]\d*$/.test(value) ? aliases.get(value) : value;
}

/** Executed inside the bounded interpreter worker. Only exact quote matches
 * from the task's evidence map can enter the returned verification record. */
export function runVerifiedProgram(source, { mode, algorithm, bindingChecks, allowAssumptions, availableRefs, refAliases }) {
  const checked = new Map(), assumedStatements = [], unusedBindings = [];
  const edits = [];
  const run = runProgram(source, { algorithm, allowedRefs: availableRefs, requireEvidence: !allowAssumptions }, {
    resolveRef(value, start, end) {
      const canonical = resolveLogicRef(value, refAliases);
      if (!canonical) throw new HanLogicError('reference_not_retrieved', `别名 ${value} 未在本轮材料中分配。`);
      if (canonical !== value) edits.push({ start, end, canonical });
      return canonical;
    },
    validate(parsed) {
      if (parsed.facts.length > 256 || parsed.rules.length > 64 || parsed.queries.length > 16) {
        throw new HanLogicError('agent_program_limit', 'Agent 单次最多256条事实、64条规则、16个查询。');
      }
      const statements = [...parsed.facts.map(s => ({ ...s, kind: 'fact' })), ...parsed.rules.map(s => ({ ...s, kind: 'rule' }))];
      const lines = new Map(), expected = new Set();
      for (const statement of statements) {
        if (mode === 'logic_run_assumptions' && statement.refs.length) {
          throw new HanLogicError('grounded_tool_required', '带依据的程序请用 logic_evaluate_grounded 核验原文绑定。', statement);
        }
        if (lines.has(statement.line) && (lines.get(statement.line) || statement.refs.length)) {
          throw new HanLogicError('declaration_line_ambiguous', '带来源的事实或规则须各占一行。', statement);
        }
        lines.set(statement.line, statement.refs.length > 0);
        for (const ref of statement.refs) expected.add(`${statement.line}\0${ref}`);
      }
      for (const binding of bindingChecks) {
        const key = `${binding.line}\0${binding.ref}`;
        if (binding.unknownAlias || !expected.has(key)) {
          unusedBindings.push({ line: binding.line, ref: binding.ref });
          continue;
        }
        if (checked.has(key)) throw new HanLogicError('binding_duplicate', '同一行与ref只能提供一个明确引文。', binding);
        if (binding.error) throw new HanLogicError(binding.error.code, binding.error.message, binding);
        checked.set(key, binding);
      }
      for (const statement of statements) {
        if (!statement.refs.length) {
          if (!allowAssumptions) throw new HanLogicError('evidence_required', '事实与规则必须附依据及原文绑定。', statement);
          assumedStatements.push({ line: statement.line, kind: statement.kind, status: 'assumed' });
        }
        for (const ref of statement.refs) {
          if (!availableRefs.has(ref)) throw new HanLogicError('reference_not_retrieved', `依据 ${ref} 不在本轮可访问的检索结果中。`, statement);
          if (!checked.has(`${statement.line}\0${ref}`)) {
            throw new HanLogicError('source_quote_required', `第${statement.line}行的依据 ${ref} 缺少原文绑定。`, statement);
          }
        }
      }
    },
  });
  if (unusedBindings.length) run.warnings.push(`已忽略 ${unusedBindings.length} 条没有对应声明的引文绑定。`);
  let cursor = 0, canonicalSource = '';
  for (const { start, end, canonical } of edits) {
    canonicalSource += source.slice(cursor, start) + JSON.stringify(canonical);
    cursor = end;
  }
  return { ...run, program: canonicalSource + source.slice(cursor),
    verification: {
      kind: 'bounded_symbolic_derivation', formalDerivationVerified: true, semanticSupportVerified: false,
      scope: '仅证明相对于给定事实、规则与明确默认例外的推导；不证明这些前提真实，也不证明原文到符号的转写正确。',
      sourceQuoteChecks: [...checked.values()], assumedStatements, unusedBindings,
      limitations: ['自然语言到谓词/规则的语义映射仍需人工核对。', '未知不等于否定；冲突同时保留正反两侧，不代表任意命题成立。'],
    },
  };
}
