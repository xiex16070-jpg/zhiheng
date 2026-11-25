import { tokenize } from '../agent/text.js';

// Terminology alignment, not generated evidence or semantic entailment verification.
const CONCEPTS = [
  { keys: ['逆命题', '肯定后件', 'converse'], terms: ['逆命题', '肯定后件', 'converse'] },
  { keys: ['逆否', 'contrapositive'], terms: ['逆否', 'contrapositive', 'contraposition'] },
  { keys: ['蕴含', '蕴涵', 'implication'], terms: ['蕴含', '蕴涵', 'implication'] },
  { keys: ['合取', 'conjunction'], terms: ['合取', 'conjunction'] },
  { keys: ['析取', 'disjunction'], terms: ['析取', 'disjunction'] },
  { keys: ['逻辑等价', '双向蕴含', '当且仅当'], terms: ['逻辑等价', '当且仅当', 'iff', 'logical equivalence', '<->'] },
  { keys: ['自然数', 'natural number'], terms: ['自然数', 'natural number', 'nat'] },
  { keys: ['赋值', 'assignment'], terms: ['赋值', 'assignment', 'assign'] },
  { keys: ['归纳假设', 'induction hypothesis'], terms: ['归纳假设', '归纳法假设', 'induction hypothesis', 'inductive hypothesis'] },
  { keys: ['循环不变式', '循环不变量', 'loop invariant'], terms: ['循环不变式', '循环不变量', 'loop invariant', 'invariant of the loop'] },
  { keys: ['类型保持', '保型', 'preservation'], terms: ['类型保持', '保型', 'preservation'] },
  { keys: ['进展', '可进性', '可进行', 'progress'], terms: ['进展', '可进性', '可进行', 'progress'] },
  { keys: ['curry', 'howard', '柯里', '霍华德', '命题即类型', '证明即程序'], terms: ['柯里', '霍华德', 'curry-howard', 'curry howard', '命题即类型', '证明即程序'] },
  { keys: ['小步语义', '小步操作语义', 'small-step', 'small step'], terms: ['小步', 'small-step', 'small step'] },
  { keys: ['大步语义', '大步操作语义', 'big-step', 'big step'], terms: ['大步', 'big-step', 'big step'] },
  { keys: ['霍尔', 'hoare'], terms: ['霍尔', 'hoare'] },
  { keys: ['最弱前置', 'weakest precondition'], terms: ['最弱前置', 'weakest precondition'] },
  { keys: ['子类型', 'subtyping'], terms: ['子类型', 'subtyping', 'subtype'] },
  { keys: ['正规化', 'normalization'], terms: ['正规化', 'normalization', 'normalisation'] },
];

function containsTerm(text, term) {
  if (!/^[a-z]/.test(term)) return text.includes(term);
  const literal = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${literal}(?=$|[^a-z0-9_])`).test(text);
}

export function formalConcepts(query) {
  const text = String(query).toLowerCase();
  return CONCEPTS.filter((concept) => concept.keys.some((key) => containsTerm(text, key)));
}

export function formalExpansion(query) {
  return formalConcepts(query).flatMap((concept) => concept.terms.flatMap((term) => tokenize(term).map((token) => ({ ...token, weight: token.weight * 0.7 }))));
}

export function formalConceptCoverage(query, content) {
  const concepts = formalConcepts(query);
  if (!concepts.length) return null;
  const text = String(content).toLowerCase();
  return concepts.filter((concept) => concept.terms.some((term) => containsTerm(text, term))).length / concepts.length;
}

export function missingFormalConcepts(query, contents) {
  const text = contents.join('\n').toLowerCase();
  return formalConcepts(query).filter((concept) => !concept.terms.some((term) => containsTerm(text, term))).map((concept) => concept.keys[0]);
}
