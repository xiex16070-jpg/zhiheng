/** Canonical source, never an execution path accepting an unchecked AST. */
const term = value => value.kind==='variable'?'?'+value.value:typeof value.value==='number'?String(value.value):JSON.stringify(value.value);
const atom = value => (value.negated?'非 ':'')+value.predicate+'('+value.args.map(term).join(', ')+')';
const condition = value => value.type==='atom'?atom(value):'('+value.items.map(condition).join(value.type==='and'?' 且 ':' 或 ')+')';
const refs = value => value.length?' 依据 '+value.map(JSON.stringify).join(', '):'';
export function formatProgram(program) {
  return [...program.facts.map(f=>'事实 '+atom(f.atom)+refs(f.refs)+'。'),
    ...program.rules.map(r=>'规则 '+r.name+'：若 '+condition(r.body)+' 则 '+atom(r.head)+(r.unless?.length?' 除非 '+r.unless.map(atom).join(' 或 '):'')+refs(r.refs)+'。'),
    ...program.queries.map(q=>'查询 '+atom(q.atom||q)+'。')].join('\n')+'\n';
}
