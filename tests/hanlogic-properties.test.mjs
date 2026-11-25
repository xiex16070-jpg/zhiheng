import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { runProgram } from '../src/logic/hanlogic.mjs';
import { checkProperty } from './helpers/check-property.mjs';

const node = fc.integer({ min: 0, max: 3 });
const pairs = fc.array(fc.tuple(node, node), { maxLength: 12 });
const graph = fc.record({ edges: pairs, denied: pairs, blocked: pairs, start: node });

function program({ edges, denied, blocked, start }) {
  const facts = (predicate, rows) => rows.map(([a, b]) => '事实 ' + predicate + '(' + a + ',' + b + ')。');
  const queries = [];
  for (let end = 0; end < 4; end++) {
    for (const predicate of ['路径', '非 路径', '开放']) queries.push('查询 ' + predicate + '(' + start + ',' + end + ')。');
  }
  return [...facts('边', edges), ...facts('非 路径', denied), ...facts('阻止', blocked),
    '规则 起点：若 边(?x,?y) 则 路径(?x,?y)。',
    '规则 连接：若 路径(?x,?y) 且 边(?y,?z) 则 路径(?x,?z)。',
    '规则 通行：若 路径(?x,?y) 则 开放(?x,?y) 除非 阻止(?x,?y)。', ...queries].join('\n');
}

// Non-empty directed walks by BFS. An explicit denial is independent of reachability.
function oracle({ edges, denied, blocked, start }) {
  const neighbors = x => edges.filter(([a]) => a === x).map(([, b]) => b);
  const reached = new Set(neighbors(start));
  const queue = [...reached];
  for (let i = 0; i < queue.length; i++) {
    for (const end of neighbors(queue[i])) if (!reached.has(end)) { reached.add(end); queue.push(end); }
  }
  const expected = [];
  for (let end = 0; end < 4; end++) {
    const pos = reached.has(end), neg = denied.some(([a, b]) => a === start && b === end);
    const open = pos && !blocked.some(([a, b]) => a === start && b === end);
    expected.push(pos ? (neg ? 'both' : 'true') : (neg ? 'false' : 'unknown'),
      neg ? (pos ? 'both' : 'true') : (pos ? 'false' : 'unknown'), open ? 'true' : 'unknown');
  }
  return expected;
}

test('property: HanLogic recursive queries agree with independent signed reachability', async () => {
  await checkProperty('hanlogic-reachability', fc.property(graph, input => {
    const source = program(input);
    const expected = oracle(input);
    for (const algorithm of ['naive', 'semi-naive', 'magic-sets']) {
      const result = runProgram(source, { algorithm });
      assert.equal(result.status, 'complete');
      assert.deepEqual(result.queries.map(q => q.status), expected, algorithm + '\n' + source);
    }
  }), 100, [[{ edges: [[0, 1], [1, 2], [2, 0], [2, 0]], denied: [[0, 2], [0, 3]], blocked: [[0, 1]], start: 0 }]]);
});
