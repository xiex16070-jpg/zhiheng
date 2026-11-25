import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../src/agent/text.js';
import { charCoverage } from '../src/server/rag.mjs';
import { fuse } from '../src/server/retrieve.mjs';

const terms = (text, options) => tokenize(text, options).map(t => t.term);
test('Coq ASCII operators survive intact, identifiers require formal context', () => {
  for (const op of ['<->', '->', '/\\', '\\/', ':=', '|-']) {
    assert.deepEqual(terms(`A ${op} I`), ['a', op, 'i']);
    assert.deepEqual(terms(op), [op]);
    assert.equal(charCoverage(op, `A ${op} I`), 1);
  }
  assert.deepEqual(terms('A I x'), []);
  assert.deepEqual(terms('`x` is a variable'), ['x', 'variable']);
  assert.deepEqual(terms('P -> Q', { formalSyntax: false }), []);
});

test('Unicode logic notation is indexed as the ASCII forms used by the corpus', () => {
  assert.deepEqual(terms('P ∧ Q → Q ∧ P'), ['p', '/\\', 'q', '->', 'q', '/\\', 'p']);
  assert.deepEqual(terms('¬(P∧¬P)'), ['~', 'p', '/\\', '~', 'p']);
  assert.deepEqual(terms('A ↔ B'), terms('A <-> B'));
  assert.ok(terms('∀ n : nat, n + 0 = n').includes('forall'));
});

test('a PDF line wrap inside a Chinese word does not split it; a blank line still does', () => {
  assert.ok(terms('数字化振\n兴项目').includes('振兴'));
  assert.ok(terms('数字化振 \r\n 兴项目').includes('振兴'));
  assert.ok(!terms('第一段\n\n第二段').includes('段第'));
});

test('a rewritten lexical list cannot outvote independent agreeing channels', () => {
  const a = { ref: 'A' }, b = { ref: 'B' };
  const lexical = { name: 'paper', items: [a, b] };
  const extra = { name: 'paper', items: [a] };
  const vector = { name: 'vector', items: [b] };
  const fused = fuse([lexical, extra, extra, vector], 60, 2);
  assert.deepEqual(fused.map(x => x.ref), ['B', 'A']);
  assert.equal(fused[1].rrf, Number((1 / 61).toFixed(5)));
  assert.deepEqual(fused[0].channels, ['paper', 'vector']);
});
