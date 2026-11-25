import test from 'node:test';
import assert from 'node:assert/strict';
import { RESEARCH_STRATEGIES, runResearchStrategy } from '../src/server/research-strategies.mjs';

const hit = (ref, text) => ({ ref, title: text, snippet: text });
const base = hit('base', 'original source');
const fail = () => assert.fail('unexpected call');

test('ReAct keeps normal retrieval and makes no extra model or search calls', async () => {
  assert.deepEqual(RESEARCH_STRATEGIES, ['react', 'ircot', 'tot']);
  const r = await runResearchStrategy({ strategy: 'react', question: 'Q', initial: [base, base], ask: fail, search: fail });
  assert.deepEqual(r.results, [base]);
  assert.deepEqual(r.outline, []);
  assert.equal(r.stats.modelCalls, 0);
  assert.equal(r.stats.searches, 0);
});

test('IRCoT builds a second query from retrieved evidence, never from a model-supplied citation', async () => {
  let generation = 0;
  const found = await runResearchStrategy({ strategy: 'ircot', question: 'Q', initial: [base],
    ask(messages) {
      assert.match(messages[0].content, /\[IRCoT:next\]/);
      const context = JSON.parse(messages[1].content);
      const query = generation++ ? 'specific technique' : 'bridge paper';
      if (generation === 2) assert.ok(context.evidence.some(e => e.excerpt === 'NEW_BRIDGE_TEXT'));
      return JSON.stringify({ query, ref: 'invented' });
    },
    search(query) {
      return query === 'bridge paper' ? [hit('one', 'NEW_BRIDGE_TEXT')] : [hit('two', 'FOLLOWUP_TEXT')];
    },
  });
  assert.deepEqual(new Set(found.results.map(h => h.ref)), new Set(['base', 'one', 'two']));
  assert.deepEqual(found.outline, ['bridge paper', 'specific technique']);
  assert.equal(found.stats.modelCalls, 2);
  assert.equal(found.stats.searches, 2);
  assert.equal(found.stats.hops, 2);
  assert.equal(found.stats.stop, 'hop_limit');
  assert.deepEqual(found.process, [
    { id: 1, parent: null, depth: 1, status: 'ok', hits: 1, novel: 1, retained: true },
    { id: 2, parent: 1, depth: 2, status: 'ok', hits: 1, novel: 1, retained: true },
  ]);
  assert.doesNotMatch(JSON.stringify(found.process), /BRIDGE|FOLLOWUP|bridge paper|invented/);
  assert.doesNotMatch(JSON.stringify(found.stats), /BRIDGE|FOLLOWUP|bridge paper|technique/);
});

test('ToT scores branches on real evidence and can switch winner after expanding a runner-up', async () => {
  const searched = [];
  const result = await runResearchStrategy({ strategy: 'tot', question: 'proof target', initial: [base],
    ask(messages) {
      if (messages[0].content.startsWith('[ToT:propose]')) return '{"branches":["bridge","lemma","unrelated"]}';
      const { paths } = JSON.parse(messages[1].content);
      assert.deepEqual(paths.map(p => p.id), [2, 1]);
      return JSON.stringify({ children: [
        { parent: 3, query: 'discarded branch' }, { parent: 1, query: 'verification' },
        { parent: 1, query: 'repeat parent' }, { parent: 2, query: 'nope' },
      ] });
    },
    search(q) {
      searched.push(q);
      return {
        bridge: [hit('first', 'bridge proof')], lemma: [hit('second', 'lemma proof target')],
        unrelated: [hit('unrelated', 'NOT_RELEVANT')], verification: [hit('verified', 'verification proof target')], nope: [],
      }[q];
    },
  });
  assert.deepEqual(searched, ['bridge', 'lemma', 'unrelated', 'verification', 'nope']);
  assert.equal(result.stats.branches, 5);
  assert.equal(result.stats.evaluated, 5);
  assert.equal(result.stats.modelCalls, 2);
  assert.deepEqual(result.stats.selected, [1, 4]);
  assert.deepEqual(result.outline, ['bridge', 'verification']);
  assert.deepEqual(new Set(result.results.map(r => r.ref)), new Set(['base', 'first', 'verified']));
  assert.equal(result.stats.stop, 'complete');
  assert.deepEqual(result.process.map(({id,parent,depth,hits}) => ({id,parent,depth,hits})), [
    {id:1,parent:null,depth:1,hits:1}, {id:2,parent:null,depth:1,hits:1}, {id:3,parent:null,depth:1,hits:1},
    {id:4,parent:1,depth:2,hits:1}, {id:5,parent:2,depth:2,hits:0},
  ]);
  assert.ok(result.process.every(operation => Number.isFinite(operation.score)));
  assert.doesNotMatch(JSON.stringify(result.process), /NOT_RELEVANT|verification|proof/);
  assert.doesNotMatch(JSON.stringify(result.stats), /proof|verification/);
});

test('budget, repeated queries, empty results, invalid plans and service failures are explicit', async () => {
  for (const [strategy, ask, search, stop, calls] of [
    ['tot', () => null, fail, 'budget', 0],
    ['tot', () => '{"branches":["one","ONE"]}', fail, 'invalid_plan', 1],
    ['ircot', () => '{"query":" q "}', fail, 'repeated_query', 1],
    ['ircot', () => '{"query":"next"}', () => [base], 'no_new_evidence', 1],
    ['ircot', () => '{"query":"next"}', () => [], 'no_evidence', 1],
    ['ircot', () => 'not JSON', fail, 'invalid_plan', 1],
    ['ircot', () => { throw Error('PRIVATE exception'); }, fail, 'model_unavailable', 1],
    ['ircot', () => '{"query":"next"}', () => { throw Error('PRIVATE exception'); }, 'search_unavailable', 1],
  ]) {
    const result = await runResearchStrategy({ strategy, question: 'Q', initial: [base], ask, search });
    assert.equal(result.stats.stop, stop);
    assert.equal(result.stats.modelCalls, calls);
    assert.deepEqual(result.results, [base]);
    assert.doesNotMatch(JSON.stringify(result.stats), /PRIVATE/);
  }
  let calls = 0;
  const partial = await runResearchStrategy({ strategy: 'tot', question: 'proof', initial: [base],
    ask: () => ++calls === 1 ? '{"branches":["alpha","beta"]}' : null,
    search: q => [hit(q, q === 'beta' ? 'beta proof' : 'alpha')],
  });
  assert.equal(partial.stats.stop, 'budget');
  assert.equal(partial.stats.modelCalls, 1);
  assert.deepEqual(partial.stats.selected, [2]);
  assert.deepEqual(partial.outline, ['beta']);
});

test('cancellation during an auxiliary call or search propagates', async () => {
  for (const during of ['ask', 'search']) {
    const controller = new AbortController();
    await assert.rejects(runResearchStrategy({ strategy: 'ircot', question: 'Q', initial: [base], signal: controller.signal,
      ask() { if (during === 'ask') controller.abort(); return '{"query":"next"}'; },
      search() { controller.abort(); return []; },
    }), { name: 'AbortError' });
  }
});
