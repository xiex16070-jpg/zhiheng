import test from 'node:test';
import assert from 'node:assert/strict';
import { visualizationDocument } from '../src/server/visualizations.mjs';

test('visualization permits diagrams and controlled interaction but removes executable/networked content', () => {
  const output = visualizationDocument('<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" fill="#315d53" onload="fetch(`/api/bootstrap`)"></circle><foreignObject><iframe src="https://bad.test"></iframe></foreignObject></svg><script>location=`https://bad.test`</script><button data-toggle="note">展开</button><div id="note" hidden>证据</div><img src="https://bad.test"><a href="javascript:alert(1)">x</a><style>@import "https://bad.test";</style>', '研究图解');
  assert.match(output, /viewBox="0 0 100 100"/);
  assert.match(output, /data-toggle="note"/);
  assert.match(output, /id="note" hidden/);
  assert.match(output, /connect-src 'none'/);
  assert.doesNotMatch(output, /bad\.test|onload|foreignObject|<iframe|javascript:|location=/);
  assert.equal((output.match(/<script /g) || []).length, 1);
});
test('visualization rejects full documents and byte-budget abuse', () => {
  assert.throws(() => visualizationDocument('<body>x</body>', 'x'));
  assert.throws(() => visualizationDocument('汉'.repeat(180000), 'x'));
});
