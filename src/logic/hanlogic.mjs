/**
 * 知衡 / HanLogic 0.1: finite, signed Datalog with Chinese rule syntax.
 * No host evaluation, functions, imports, I/O, existential heads or implicit contraposition.
 * A proof certifies consequences of the supplied program, not the truth of its premises.
 */

export const DEFAULT_LIMITS = Object.freeze({
  maxSourceChars: 50000, maxTokens: 12000, maxFacts: 2048, maxRules: 128,
  maxQueries: 64, maxArity: 8, maxSteps: 100000, maxProofNodes: 4096,
  maxDepth: 48, maxBranches: 128, maxRuleBodyAtoms: 24, maxConstantChars: 512,
  maxMilliseconds: 500,
});

export class HanLogicError extends Error {
  constructor(code, message, location = {}) {
    super(message);
    this.name = 'HanLogicError';
    this.code = code;
    this.line = location.line || 1;
    this.column = location.column || 1;
  }
}

function limitsFor(options = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(options.limits || {})) {
    if (!Object.hasOwn(limits, key)) throw new HanLogicError('invalid_option', `未知限额：${key}`);
    const value = options.limits[key];
    if (!Number.isSafeInteger(value) || value < 1) throw new HanLogicError('invalid_option', `限额 ${key} 必须为正整数`);
    limits[key] = Math.min(value, limits[key]);
  }
  return limits;
}

function budgetFor(limits) {
  const start = performance.now();
  let steps = 0;
  return {
    check(location) {
      if (performance.now() - start > limits.maxMilliseconds) throw new HanLogicError('limit_exceeded', '运行超时；未产生完整结论，请缩小程序', location);
    },
    step(location) {
      if (++steps > limits.maxSteps) throw new HanLogicError('limit_exceeded', '规则匹配步数超限；未产生完整结论', location);
      this.check(location);
    },
    get steps() { return steps; },
    get elapsedMs() { return Math.round((performance.now() - start) * 100) / 100; },
  };
}

const word = /[\p{L}_][\p{L}\p{N}_-]*/uy;
const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?/y;
const punctuation = new Map([['（', '('], ['）', ')'], ['，', ','], ['、', ','], ['：', ':'], ['；', ';'], ['。', ';'], ['.', ';']]);

function lex(source, limits, budget) {
  if (typeof source !== 'string') throw new HanLogicError('syntax_error', '程序必须是字符串');
  if (source.length > limits.maxSourceChars) throw new HanLogicError('limit_exceeded', `程序超过 ${limits.maxSourceChars} 字符`);
  const tokens = [];
  let offset = 0, line = 1, column = 1;
  const advance = (text) => {
    for (const ch of text) {
      if (ch === '\n') { line++; column = 1; } else column++;
    }
    offset += text.length;
  };
  const emit = (kind, value, location) => {
    tokens.push({ kind, value, ...location });
    if (tokens.length > limits.maxTokens) throw new HanLogicError('limit_exceeded', '词法单元数量超限', location);
  };
  while (offset < source.length) {
    budget.check({ line, column });
    const ch = source[offset];
    if (/\s/u.test(ch)) { advance(ch); continue; }
    if (ch === '#' || source.startsWith('//', offset)) {
      const end = source.indexOf('\n', offset);
      advance(source.slice(offset, end < 0 ? source.length : end));
      continue;
    }
    const location = { line, column, offset };
    if ('"“「'.includes(ch)) {
      const closing = { '"': '"', '“': '”', '「': '」' }[ch];
      advance(ch);
      let value = '', closed = false;
      while (offset < source.length) {
        budget.check(location);
        const next = source[offset];
        if (next === closing) { advance(next); closed = true; break; }
        if (next === '\\') {
          const escaped = source[offset + 1];
          const translations = { n: '\n', r: '\r', t: '\t', '\\': '\\', '"': '"' };
          if (escaped === 'u' && /^[\da-fA-F]{4}$/.test(source.slice(offset + 2, offset + 6))) {
            value += String.fromCharCode(parseInt(source.slice(offset + 2, offset + 6), 16));
            advance(source.slice(offset, offset + 6));
          } else if (Object.hasOwn(translations, escaped)) {
            value += translations[escaped]; advance(source.slice(offset, offset + 2));
          } else throw new HanLogicError('syntax_error', '字符串中的转义不受支持', { line, column });
        } else { value += next; advance(next); }
        if (value.length > limits.maxConstantChars) throw new HanLogicError('limit_exceeded', '字符串常量过长', location);
      }
      if (!closed) throw new HanLogicError('syntax_error', '字符串缺少结束引号', location);
      emit('string', value, { ...location, end: offset }); continue;
    }
    if ('(),:;'.includes(ch) || punctuation.has(ch)) {
      emit('punct', punctuation.get(ch) || ch, location); advance(ch); continue;
    }
    const variable = ch === '?' || ch === '？';
    if (variable) advance(ch);
    word.lastIndex = offset;
    const match = word.exec(source);
    if (match) {
      if (match[0].length > limits.maxConstantChars) throw new HanLogicError('limit_exceeded', '标识符过长', location);
      emit(variable ? 'variable' : 'word', match[0], location); advance(match[0]); continue;
    }
    if (variable) throw new HanLogicError('syntax_error', '变量必须写作 ?名称', location);
    number.lastIndex = offset;
    const numeric = number.exec(source);
    if (numeric) {
      const value = Number(numeric[0]);
      if (!Number.isSafeInteger(value) || numeric[0].includes('.')) throw new HanLogicError('syntax_error', '数值常量仅支持安全整数；小数或超大整数请写为带引号的字符串', location);
      emit('number', value, location); advance(numeric[0]); continue;
    }
    throw new HanLogicError('syntax_error', `无法识别字符 ${JSON.stringify(ch)}；关键字与名称之间需要空格`, location);
  }
  emit('eof', '', { line, column });
  return tokens;
}

const reserved = new Set(['事实', '规则', '查询', '若', '则', '且', '或', '非', '除非', '依据', '只有', '才']);
const atomVariables = (atom) => atom.args.filter((a) => a.kind === 'variable').map((a) => a.value);
const signature = (atom) => `${atom.negated ? '!' : '+'}${atom.predicate}/${atom.args.length}`;

function parse(source, limits, budget, resolveRef) {
  const tokens = lex(source, limits, budget);
  let index = 0;
  const current = () => tokens[index];
  const take = () => { budget.check(current()); return tokens[index++]; };
  const is = (value) => current().value === value && ['word', 'punct'].includes(current().kind);
  const accept = (value) => is(value) ? take() : null;
  const expect = (value) => {
    if (!is(value)) throw new HanLogicError('syntax_error', `需要“${value}”，实际为“${current().value || '文件结尾'}”`, current());
    return take();
  };
  const atom = () => {
    const location = current();
    const negated = Boolean(accept('非'));
    const predicate = take();
    if (predicate.kind !== 'word' || reserved.has(predicate.value)) throw new HanLogicError('syntax_error', '需要关系名称，例如 可终止(程序甲)', predicate);
    expect('(');
    const args = [];
    if (!is(')')) do {
      const term = take();
      if (!['word', 'string', 'number', 'variable'].includes(term.kind) || (term.kind === 'word' && reserved.has(term.value))) throw new HanLogicError('syntax_error', '参数必须为常量或 ?变量', term);
      args.push({ kind: term.kind === 'variable' ? 'variable' : 'constant', value: term.value });
      if (args.length > limits.maxArity) throw new HanLogicError('limit_exceeded', '关系参数过多', location);
    } while (accept(','));
    expect(')');
    return { type: 'atom', predicate: predicate.value, args, negated, line: location.line, column: location.column };
  };
  const factor = (depth) => {
    if (depth > limits.maxDepth) throw new HanLogicError('limit_exceeded', '条件嵌套过深', current());
    if (accept('(')) { const value = expression(depth + 1); expect(')'); return value; }
    return atom();
  };
  const conjunction = (depth) => {
    const items = [factor(depth)];
    while (accept('且')) items.push(factor(depth));
    return items.length === 1 ? items[0] : { type: 'and', items };
  };
  const expression = (depth = 0) => {
    const items = [conjunction(depth)];
    while (accept('或')) items.push(conjunction(depth));
    return items.length === 1 ? items[0] : { type: 'or', items };
  };
  const references = () => {
    const refs = [];
    if (accept('依据')) do {
      const ref = take();
      if (!['word', 'string', 'number'].includes(ref.kind) || !String(ref.value).trim()) throw new HanLogicError('syntax_error', '依据必须是非空来源编号，建议使用引号', ref);
      const value = String(ref.value);
      refs.push(resolveRef ? resolveRef(value, ref.offset, ref.end ?? ref.offset + value.length) : value);
    } while (accept(','));
    return [...new Set(refs)];
  };
  const program = { language: 'HanLogic', version: '0.1', facts: [], rules: [], queries: [] };
  const ruleNames = new Set();
  while (current().kind !== 'eof') {
    const start = take();
    if (start.kind !== 'word') throw new HanLogicError('syntax_error', '语句必须以关键字开头', start);
    if (start.value === '事实') {
      const value = atom();
      if (atomVariables(value).length) throw new HanLogicError('unsafe_rule', '事实不能含变量；全称关系请写成规则', start);
      program.facts.push({ atom: value, refs: references(), line: start.line, column: start.column });
      if (program.facts.length > limits.maxFacts) throw new HanLogicError('limit_exceeded', '事实数量超限', start);
    } else if (start.value === '查询') {
      const value = atom();
      if (atomVariables(value).length) throw new HanLogicError('unsafe_rule', '0.1 仅支持基查询，请给查询变量指定常量', start);
      program.queries.push({ atom: value, line: start.line, column: start.column });
      if (program.queries.length > limits.maxQueries) throw new HanLogicError('limit_exceeded', '查询数量超限', start);
    } else if (start.value === '规则') {
      const name = take();
      if (!['word', 'string'].includes(name.kind) || reserved.has(name.value)) throw new HanLogicError('syntax_error', '规则需要名称', name);
      if (ruleNames.has(name.value)) throw new HanLogicError('syntax_error', `规则名称重复：${name.value}`, name);
      ruleNames.add(name.value);
      expect(':');
      let body, head, form;
      if (accept('若')) { body = expression(); expect('则'); head = atom(); form = 'if'; }
      else if (accept('只有')) { head = atom(); expect('才'); body = atom(); form = 'only-if'; }
      else throw new HanLogicError('syntax_error', '规则需要“若…则…”或“只有…才…”', current());
      const unless = [];
      if (accept('除非')) do { unless.push(atom()); } while (accept('或'));
      if (unless.length > limits.maxRuleBodyAtoms) throw new HanLogicError('limit_exceeded', '例外条件过多', start);
      program.rules.push({ name: name.value, body, head, unless, refs: references(), form, line: start.line, column: start.column });
      if (program.rules.length > limits.maxRules) throw new HanLogicError('limit_exceeded', '规则数量超限', start);
    } else throw new HanLogicError('syntax_error', '语句必须以“事实”“规则”或“查询”开头', start);
    if (!accept(';') && current().kind !== 'eof') throw new HanLogicError('syntax_error', '语句需要以句号“。”或分号结束', current());
  }
  return program;
}

function branchesOf(node, limits, budget, location) {
  budget.check(location);
  if (node.type === 'atom') return [[node]];
  let output = node.type === 'and' ? [[]] : [];
  for (const child of node.items) {
    const branches = branchesOf(child, limits, budget, location);
    if (node.type === 'or') output.push(...branches);
    else {
      if (output.length * branches.length > limits.maxBranches) throw new HanLogicError('limit_exceeded', '“且/或”组合展开超过分支上限', location);
      const product = [];
      for (const left of output) for (const right of branches) {
        budget.check(location);
        if (left.length + right.length > limits.maxRuleBodyAtoms) throw new HanLogicError('limit_exceeded', '单条规则条件过多', location);
        product.push([...left, ...right]);
      }
      output = product;
    }
    if (output.length > limits.maxBranches) throw new HanLogicError('limit_exceeded', '“或”分支过多', location);
  }
  return output;
}

function compile(program, limits, budget, options) {
  const arities = new Map(), nodes = new Set(), edges = [], compiled = [];
  const allowedRefs = options.allowedRefs === undefined ? null : new Set(options.allowedRefs);
  const checkAtom = (atom) => {
    const arity = arities.get(atom.predicate);
    if (arity !== undefined && arity !== atom.args.length) throw new HanLogicError('syntax_error', `关系“${atom.predicate}”的参数数量不一致`, atom);
    arities.set(atom.predicate, atom.args.length); nodes.add(signature(atom));
  };
  for (const statement of [...program.facts, ...program.rules]) {
    budget.check(statement);
    if (options.requireEvidence && !statement.refs.length) throw new HanLogicError('unbound_reference', '语句缺少依据；程序事实不等于经验证的现实事实', statement);
    if (allowedRefs) for (const ref of statement.refs) if (!allowedRefs.has(ref)) throw new HanLogicError('unbound_reference', `依据不在允许集合中：${ref}`, statement);
  }
  for (const fact of program.facts) checkAtom(fact.atom);
  for (const query of program.queries) checkAtom(query.atom);
  for (const rule of program.rules) {
    checkAtom(rule.head);
    rule.unless.forEach(checkAtom);
    const branches = branchesOf(rule.body, limits, budget, rule);
    for (const body of branches) {
      if (body.length > limits.maxRuleBodyAtoms) throw new HanLogicError('limit_exceeded', '单条规则条件过多', rule);
      const variables = new Set(body.flatMap(atomVariables));
      for (const variable of [rule.head, ...rule.unless].flatMap(atomVariables)) {
        if (!variables.has(variable)) throw new HanLogicError('unsafe_rule', `变量 ?${variable} 必须在每个“或”分支的事实条件中绑定`, rule);
      }
      body.forEach(checkAtom);
      for (const atom of body) edges.push({ head: signature(rule.head), body: signature(atom), delta: 0, location: rule });
      for (const atom of rule.unless) edges.push({ head: signature(rule.head), body: signature(atom), delta: 1, location: rule });
      compiled.push({ ...rule, body });
      if (compiled.length > limits.maxBranches) throw new HanLogicError('limit_exceeded', '程序展开后的规则分支过多', rule);
    }
  }
  const strata = new Map([...nodes].map((name) => [name, 0]));
  for (let pass = 0; pass <= nodes.size; pass++) {
    let changed = false;
    for (const edge of edges) {
      budget.check(edge.location);
      const needed = strata.get(edge.body) + edge.delta;
      if (strata.get(edge.head) < needed) { strata.set(edge.head, needed); changed = true; }
    }
    if (!changed) break;
    if (pass === nodes.size) throw new HanLogicError('unstratified_negation', '“除非”存在循环依赖，无法分层；请明确事实或改写规则');
  }
  return { rules: compiled.map((rule) => ({ ...rule, stratum: strata.get(signature(rule.head)) })), strata };
}

export function parseProgram(source, options = {}) {
  const limits = limitsFor(options), budget = budgetFor(limits);
  const program = parse(source, limits, budget);
  compile(program, limits, budget, options);
  budget.check();
  return program;
}

const groundKey = (atom, args) => JSON.stringify([atom.negated, atom.predicate, args]);
const constantText = (value) => typeof value === 'number' ? String(value) : /^[\p{L}_][\p{L}\p{N}_-]*$/u.test(value) && !reserved.has(value) ? value : JSON.stringify(value);
const atomText = (atom, args = atom.args.map((arg) => arg.kind === 'variable' ? `?${arg.value}` : arg.value)) => `${atom.negated ? '非 ' : ''}${atom.predicate}(${args.map(constantText).join('，')})`;
const instantiate = (atom, bindings) => atom.args.map((arg) => arg.kind === 'variable' ? bindings.get(arg.value) : arg.value);

function unify(atom, values, prior) {
  const bindings = new Map(prior);
  for (const [i, arg] of atom.args.entries()) {
    const value = values[i];
    if (value === undefined) continue; // Free position in a Magic Sets demand.
    if (arg.kind === 'constant') { if (value !== arg.value) return null; }
    else if (bindings.has(arg.value)) { if (bindings.get(arg.value) !== value) return null; }
    else bindings.set(arg.value, value);
  }
  return bindings;
}

export function runProgram(source, options = {}, { resolveRef, validate } = {}) {
  const limits = limitsFor(options), budget = budgetFor(limits);
  const algorithm = options.algorithm === undefined ? 'naive' : options.algorithm;
  if (!['naive', 'semi-naive', 'magic-sets'].includes(algorithm)) throw new HanLogicError('invalid_option', '未知推演算法。');
  const program = parse(source, limits, budget, resolveRef);
  validate?.(program);
  const compiled = compile(program, limits, budget, options);
  const facts = new Map(), index = new Map(), proofs = [], warnings = [];
  let rounds = 0, comparisons = 0, demandPatterns = 0;
  const insert = (atom, args, proof) => {
    const key = groundKey(atom, args);
    if (facts.has(key)) return false;
    budget.check(proof);
    if (facts.size >= limits.maxFacts || proofs.length >= limits.maxProofNodes) throw new HanLogicError('limit_exceeded', '推导事实或证明节点数量超限；未产生完整结论', proof);
    const id = `f${facts.size + 1}`, proofId = `p${proofs.length + 1}`;
    const fact = { id, predicate: atom.predicate, arguments: args, negated: atom.negated, text: atomText(atom, args), proof: proofId };
    proofs.push({ id: proofId, conclusion: fact.text, ...proof });
    facts.set(key, fact);
    const name = signature(atom);
    if (!index.has(name)) index.set(name, []);
    index.get(name).push(fact);
    return true;
  };
  for (const fact of program.facts) insert(fact.atom, fact.atom.args.map((arg) => arg.value), { kind: 'fact', refs: fact.refs, line: fact.line, premises: [], assumptions: [] });
  function applyRule(rule, { seed = new Map(), window, demand } = {}) {
    budget.step(rule);
    let matches = [{ bindings: seed, premises: [] }];
    for (const [position, atom] of rule.body.entries()) {
      const next = [];
      const relation = signature(atom), candidates = index.get(relation) || [];
      const [start, end] = window ? window(relation, position) : [0, candidates.length];
      for (const match of matches) {
        if (demand) demand(atom, instantiate(atom, match.bindings));
        for (let i = start; i < end; i++) {
          budget.step(rule);
          comparisons++;
          const fact = candidates[i];
          const bindings = unify(atom, fact.arguments, match.bindings);
          if (bindings) next.push({ bindings, premises: [...match.premises, fact.proof] });
        }
      }
      matches = next;
      if (!matches.length) break;
    }
    for (const solution of matches) {
      budget.step(rule);
      const exceptions = rule.unless.map((atom) => ({ atom, args: instantiate(atom, solution.bindings) }));
      if (exceptions.some(({ atom, args }) => facts.has(groundKey(atom, args)))) continue;
      insert(rule.head, instantiate(rule.head, solution.bindings), {
        kind: 'rule', rule: rule.name, refs: rule.refs, line: rule.line, premises: solution.premises,
        assumptions: exceptions.map(({ atom, args }) => ({ kind: 'not-derived', literal: atomText(atom, args), scope: 'current-program' })),
      });
    }
  }
  function materialize(rules) {
    let before, previous = new Map();
    do {
      before = facts.size;
      rounds++;
      const frontier = algorithm === 'naive' ? null : new Map([...index].map(([key, rows]) => [key, rows.length]));
      for (const rule of rules) {
        if (algorithm === 'naive') { applyRule(rule); continue; }
        // The first newly derived premise partitions joins into disjoint delta variants.
        // Freeze relation lengths at round entry, including for nonlinear recursion.
        for (const [pivot, atom] of rule.body.entries()) {
          const key = signature(atom);
          if ((frontier.get(key) || 0) === (previous.get(key) || 0)) continue;
          applyRule(rule, { window(relation, position) {
            const old = previous.get(relation) || 0, all = frontier.get(relation) || 0;
            if (position < pivot) return [0, old];
            return [position === pivot ? old : 0, all];
          } });
        }
      }
      previous = frontier;
    } while (facts.size !== before);
  }
  function materializeDemands(rules) {
    const byHead = new Map(), demands = new Map();
    for (const rule of rules) {
      const name = signature(rule.head);
      if (!byHead.has(name)) byHead.set(name, []);
      byHead.get(name).push(rule);
    }
    function demand(atom, values) {
      const name = signature(atom);
      if (!byHead.has(name)) return;
      budget.step(atom);
      const key = JSON.stringify([name, values]); // null encodes free positions; the language has no null constant.
      if (!demands.has(key)) demands.set(key, { rules: byHead.get(name), values });
    }
    for (const { atom } of program.queries) {
      const values = atom.args.map(arg => arg.value);
      demand(atom, values);
      demand({ ...atom, negated: !atom.negated }, values);
    }
    let previousSize;
    do {
      previousSize = facts.size + demands.size;
      rounds++;
      for (const { rules: matchingRules, values } of demands.values()) {
        for (const rule of matchingRules) {
          budget.check(rule);
          const seed = unify(rule.head, values);
          if (seed) applyRule(rule, { seed, demand });
        }
      }
    } while (previousSize !== facts.size + demands.size);
    demandPatterns = demands.size;
  }
  const levels = [...new Set(compiled.rules.map((rule) => rule.stratum))].sort((a, b) => a - b);
  const scoped = algorithm === 'magic-sets' && program.queries.length > 0;
  const targetLevel = scoped ? Math.max(...program.queries.flatMap(({ atom }) =>
    [atom, { ...atom, negated: !atom.negated }].map(side => compiled.strata.get(signature(side)) || 0))) : Infinity;
  for (const level of levels) {
    if (level > targetLevel) break;
    const rules = compiled.rules.filter((rule) => rule.stratum === level);
    // Complete lower strata before testing absence. Only the target stratum is demand-restricted.
    if (scoped && level === targetLevel) materializeDemands(rules);
    else materialize(rules);
  }
  const labels = { true: '成立', false: '不成立', both: '冲突', unknown: '未知' };
  const queries = program.queries.map(({ atom, line }) => {
    budget.check({ line });
    const args = atom.args.map((arg) => arg.value);
    const positive = facts.get(groundKey(atom, args));
    const negative = facts.get(groundKey({ ...atom, negated: !atom.negated }, args));
    const status = positive ? negative ? 'both' : 'true' : negative ? 'false' : 'unknown';
    return { query: atomText(atom, args), line, status, label: labels[status], positiveProof: positive?.proof || null, negativeProof: negative?.proof || null };
  });
  if ([...program.facts, ...program.rules].some((item) => !item.refs.length)) warnings.push('部分事实或规则未声明来源，仅作为本程序给定的假设。');
  if (program.rules.some((rule) => rule.unless.length)) warnings.push('“除非”只表示本程序的较低层中未导出例外，不构成现实世界中的否定证据。');
  warnings.push('形式证明仅说明结论由给定事实和规则推出；来源编号与语句的语义对应及前提真实性仍须核验。');
  budget.check();
  return {
    language: 'HanLogic', version: '0.1', status: 'complete', semantics: 'finite-signed-datalog-with-stratified-exceptions',
    algorithm, factScope: scoped ? 'query' : 'complete', facts: [...facts.values()], queries, proofs, warnings,
    stats: { inputFacts: program.facts.length, derivedFacts: facts.size - new Set(program.facts.map(({ atom }) => groundKey(atom, atom.args.map((arg) => arg.value)))).size,
      facts: facts.size, rules: program.rules.length, branches: compiled.rules.length, strata: levels.filter(level => level <= targetLevel).length,
      rounds, steps: budget.steps, comparisons, demandPatterns, elapsedMs: budget.elapsedMs },
  };
}
