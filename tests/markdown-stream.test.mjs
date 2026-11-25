import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdownParser, renderMarkdown, renderMarkdownBlock } from '../src/ui/markdown.js';

test('arbitrarily split CRLF, headings, code fences and inference cards agree with final rendering', () => {
  const lines = [
    '  ## 缩进标题', '**命题**', '> 原文', '> 后续', '', '- 第一条', '- 第二条', '',
    '```logic', '若 [[S1]]，则 <p>。', '```', '推理如下', '[推断]（依据[[S1]]；方法:演绎）结论',
    '[推断]（方法:归纳）第二结论',
  ];
  const source = lines.join('\r\n');
  const expected = renderMarkdown(source);
  assert.match(expected, /<h3>缩进标题<\/h3>/);
  assert.match(expected, /<blockquote>原文后续<\/blockquote>/);
  assert.match(expected, /<ul><li>第一条<\/li><li>第二条<\/li><\/ul>/);
  assert.match(expected, /<code class="lang-logic">若 \[\[S1\]\]，则 &lt;p&gt;。<\/code>/);
  assert.match(expected, /data-audit="1"/);
  const stable = [];
  const parser = createMarkdownParser(block => stable.push(block));
  let prefix = '';
  for (const char of source) {
    prefix += char;
    parser.append(char);
    const visible = stable.slice();
    parser.pending(block => visible.push(block));
    let seq = 0;
    const html = visible.map(block => {
      const result = renderMarkdownBlock(block, {}, seq);
      if (block.kind === 'inference') seq++;
      return result;
    }).join('\n');
    assert.equal(html, renderMarkdown(prefix));
  }
});

test('inline code stays literal as delimiters arrive and metadata is escaped', () => {
  const ctx = { pending: true, numberFor: () => ({ n: 1, ref: '42', title: '" onmouseover="bad()' }) };
  assert.equal(renderMarkdown('`[[S1]] <img>', ctx), '<p><code>[[S1]] &lt;img&gt;</code></p>');
  const html = renderMarkdown('`[[S1]] <img>` **依据**[[S2]]', ctx);
  assert.equal((html.match(/<button /g) || []).length, 1);
  assert.match(html, /data-cite="42" title="&quot; onmouseover=&quot;bad\(\)"/);
  assert.match(html, /<strong>依据<\/strong>/);
});

test('unmatched evidence is readable text and has no source action', () => {
  const numberFor = id => id === 'S1' ? { ref: 'public-source', n: 1 } : { bad: true, n: '?' };
  for (const pending of [true, false]) {
    const html = renderMarkdown('依据[[S1]]；待核对[[S2]]。', { numberFor, pending });
    assert.match(html, /<button[^>]+data-cite="public-source"/);
    assert.match(html, /<span class="cite bad">来源未匹配<\/span>/);
    assert.equal((html.match(/data-cite=/g) || []).length, 1);
  }
});

test('tables and safe links agree at every stream boundary without raw HTML or active URLs', () => {
  const source = '| 结论 | 证据 |\n| :--- | ---: |\n| **成立** | [[S1]] |\n| `a|b` | 转义\\|管道 |\n\n[官方资料](https://example.org/p?q=1&b=2)\n\n[代码 `x`](https://example.org)';
  const context = { numberFor: id => ({ n: 1, ref: id }) };
  const html = renderMarkdown(source, context);
  assert.match(html, /<table>/); assert.match(html, /scope="col"/);
  assert.match(html, /<code>a\|b<\/code>/); assert.match(html, /转义\|管道/);
  assert.match(html, /class="cite"/); assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/example.org\/p\?q=1&amp;b=2"/);
  assert.match(html, /代码 <code>x<\/code><\/a>/);
  const stable = [], parser = createMarkdownParser(block => stable.push(block));
  let prefix = '';
  for (const char of source) {
    prefix += char; parser.append(char);
    const visible = stable.slice(); parser.pending(block => visible.push(block));
    assert.equal(visible.map(block => renderMarkdownBlock(block, context)).join('\n'), renderMarkdown(prefix, context));
  }
  for (const url of ['javascript:alert(1)', 'data:text/html,bad', 'file:///C:/secret', '//example.org', 'https://u:p@example.org', 'java\u0000script:bad']) {
    assert.doesNotMatch(renderMarkdown(`[链接](${url})`), /<a /);
  }
  assert.doesNotMatch(renderMarkdown('![跟踪图片](https://example.org/a.png) <script>bad()</script>'), /<img|<script|<a /);
  assert.doesNotMatch(renderMarkdown('```\n| a | b |\n| --- | --- |\n```'), /<table>/);
});

test('blocks containing pipes interrupt tables and preserve inference audit identity throughout streaming', () => {
  const table = '| 项目 | 说明 |\n| --- | --- |\n| x | y |\n';
  const context = { numberFor: id => ({ n: 1, ref: id }) };
  const cases = [
    ['## A | B | C', /<h3>A \| B \| C<\/h3>/],
    ['- A | B | C', /<ul><li>A \| B \| C<\/li><\/ul>/],
    ['1. A | B | C', /<ol><li>A \| B \| C<\/li><\/ol>/],
    ['> A | B | C', /<blockquote>A \| B \| C<\/blockquote>/],
    ['[推断]（依据[[S1]]；方法:演绎）A | B | C', /class="inference" data-inf="0"/],
    ['```text|example\nA | B | C\n```', /<pre><code class="lang-text\|example">A \| B \| C<\/code><\/pre>/],
  ];
  for (const [suffix, blockPattern] of cases) {
    const source = table + suffix;
    const html = renderMarkdown(source, context);
    assert.match(html, blockPattern, suffix);
    assert.equal((html.match(/<tbody><tr>/g) || []).length, 1);
    assert.equal((html.match(/<td /g) || []).length, 2, 'only the original body row belongs to the table');
    if (suffix.startsWith('[推断]')) {
      assert.match(html, /data-audit="0"/);
      assert.match(html, /class="inf-body">A \| B \| C<\/div>/);
      assert.match(html, /class="inf-refs">依据 <button[^>]*data-cite="S1"/);
    }
    const stable = [], parser = createMarkdownParser(block => stable.push(block));
    let prefix = '';
    for (const char of source) {
      prefix += char; parser.append(char);
      const visible = stable.slice(); parser.pending(block => visible.push(block));
      let sequence = 0;
      const streamed = visible.map(block => {
        const rendered = renderMarkdownBlock(block, context, sequence);
        if (block.kind === 'inference') sequence++;
        return rendered;
      }).join('\n');
      assert.equal(streamed, renderMarkdown(prefix, context), `${suffix}: ${JSON.stringify(prefix)}`);
    }
  }
});

test('balanced link targets remain complete, including nested and escaped parentheses', () => {
  const source = '[定义](https://en.wikipedia.org/wiki/Logic_(disambiguation)) ' +
    '[嵌套](https://example.org/a_(b_(c))?q=(d)&v=2) ' +
    '[转义](https://example.org/a_\\(b\\))';
  const html = renderMarkdown(source);
  assert.match(html, /href="https:\/\/en\.wikipedia\.org\/wiki\/Logic_\(disambiguation\)"/);
  assert.match(html, /href="https:\/\/example\.org\/a_\(b_\(c\)\)\?q=\(d\)&amp;v=2"/);
  assert.match(html, /href="https:\/\/example\.org\/a_\(b\)"/);
  assert.equal((html.match(/<a /g) || []).length, 3);
  assert.doesNotMatch(html, /<\/a>\)/);
  const stable = [], parser = createMarkdownParser(block => stable.push(block));
  let prefix = '';
  for (const char of source) {
    prefix += char; parser.append(char);
    const visible = stable.slice(); parser.pending(block => visible.push(block));
    assert.equal(visible.map(block => renderMarkdownBlock(block, {})).join('\n'), renderMarkdown(prefix));
  }
  assert.doesNotMatch(renderMarkdown('[未闭合](https://example.org/a_(b)'), /<a /);
  assert.doesNotMatch(renderMarkdown('[危险](javascript:alert((1))) ![图片](https://example.org/a_(b).png)'), /<a |<img/);
  assert.doesNotMatch(renderMarkdown('[凭据](https://u:p@example.org/a_(b))'), /<a /);
  assert.match(renderMarkdown('[未闭合](https://example.org/a_(b)\n\n[正常](https://example.org)'), /href="https:\/\/example.org\/"/);
});
