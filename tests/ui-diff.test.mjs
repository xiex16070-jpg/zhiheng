import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, renderDiff } from '../src/ui/diff.js';
import { publicSteps } from '../src/server/public-steps.mjs';

test('diff preserves unchanged islands, line numbers, and reconstructs both files',()=>{
  const before='header\na\nstable\nb\nfooter',after='header\nA\nstable\nB\nfooter';
  const rows=diffLines(before,after);
  assert.equal(rows.filter(r=>r.kind!=='added').map(r=>r.text).join('\n'),before);
  assert.equal(rows.filter(r=>r.kind!=='removed').map(r=>r.text).join('\n'),after);
  assert.equal(rows.find(r=>r.text==='stable').kind,'context');
  assert.equal(rows.find(r=>r.text==='B').newLine,4);
  assert.ok(renderDiff(before,after).includes('diff-hunk'));
});
test('new files have no phantom deletion; rendered changes cannot inject markup',()=>{
  assert.deepEqual(diffLines('','x').map(r=>r.kind),['added']);
  const html=renderDiff('one','<script>evil()</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(renderDiff('a\n'+Array(20).fill('unchanged').join('\n')+'\nb','A\n'+Array(20).fill('unchanged').join('\n')+'\nB').includes('diff-unchanged'));
});
test('public steps redact nested credentials and preserve the surrounding tool result', () => {
  const fixtureValue = 'public redaction test marker';
  const url = 'https://example.invalid/search?token=';
  const [step] = publicSteps([{
    name: 'search',
    detail: {
      args: {
        apiKey: fixtureValue,
        url: url + encodeURIComponent(fixtureValue),
        headers: { authorization: fixtureValue },
        query: 'Bearer ' + encodeURIComponent(fixtureValue),
      },
      nested: [{ password: fixtureValue, resultCount: 3 }],
    },
  }]);
  assert.equal(step.name, 'search');
  const redacted = '[redacted]';
  assert.deepEqual(step.detail, {
    args: { apiKey: redacted, url: url + redacted, headers: redacted, query: redacted },
    nested: [{ password: redacted, resultCount: 3 }],
  });
});
