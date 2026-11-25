/** 分块与引用解析的核心不变量。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText } from '../src/server/chunker.mjs';
import { extractRefs, escapeHtml } from '../src/agent/text.js';
import { parseMultipart, boundaryOf } from '../src/server/multipart.mjs';

const SAMPLE = `第一章 背景

牡丹产业目前面临标准化程度低的问题。种植分散、以散户为主，导致品质参差不齐。

第二章 方案

针对鲜切花与花籽的品质分级，研发基于计算机视觉的智能分选系统。通过图像采集识别花朵开放度、花径、色泽与瑕疵等指标，建立品质等级模型，输出采收建议与分级定价方案。

第4页

系统还需要接入冷链数据，形成从田间到餐桌的全程追溯。`;

test('分块切片必须等于原文对应区间', () => {
  const chunks = chunkText(SAMPLE);
  assert.ok(chunks.length > 0);
  for (const c of chunks) {
    assert.equal(SAMPLE.slice(c.start, c.end), c.text, `偏移不一致: ${c.start}-${c.end}`);
    assert.ok(c.end > c.start);
  }
});

test('空文本与纯空白返回空数组', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('页脚「第4页」不会被当成章节标题', () => {
  const chunks = chunkText(SAMPLE);
  for (const c of chunks) assert.notEqual(c.heading, '第4页');
});

test('repeated PDF page edges stay in source slices but never become headings',()=>{
  const pages=Array.from({length:3},(_,i)=>`研究院内部报告\n第${i+1}个不同段落阐述合取推理及相关证据。\n保留引文定位，不删除任何原文字符。\n研究院版权所有`);
  const text=pages.join('\n\n'),sourceMap=[];let start=0;
  for(const [i,page]of pages.entries()){sourceMap.push({page:i+1,start,end:start+page.length});start+=page.length+2;}
  const chunks=chunkText(text,{sourceMap,target:60,max:120});
  assert.ok(chunks.length>0);for(const c of chunks){assert.equal(text.slice(c.start,c.end),c.text);assert.notEqual(c.heading,'研究院内部报告');assert.notEqual(c.heading,'研究院版权所有');}
  assert.ok(chunks.some(c=>c.text.includes('研究院内部报告')));
});

test('超长单句会被硬切而不是丢弃', () => {
  const long = '长'.repeat(3000);
  const chunks = chunkText(`标题\n\n${long}`, { target: 300, max: 500 });
  assert.ok(chunks.length >= 2);
  const joined = chunks.map((c) => c.text).join('');
  assert.equal(joined.length, 3000);
});

test('引用标记同时支持论文 ID 与文档片段 ID', () => {
  const text = '第一条 [[12858]] 第二条 [[k1a2b3c_4]] 重复 [[12858]] 无效 [[ ]]。';
  assert.deepEqual(extractRefs(text), ['12858', 'k1a2b3c_4']);
});

test('HTML 转义', () => {
  assert.equal(escapeHtml('<b>&"x"</b>'), '&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
});

test('multipart 能解析出文件名与内容', () => {
  const boundary = '----testBoundary123';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.md"\r\nContent-Type: text/markdown\r\n\r\n`
    ),
    Buffer.from('# 标题\n\n正文内容'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  assert.equal(boundaryOf(`multipart/form-data; boundary=${boundary}`), boundary);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].filename, 'a.md');
  assert.equal(parts[0].data.toString('utf8'), '# 标题\n\n正文内容');
});

test('multipart 多文件', () => {
  const boundary = 'X';
  const mk = (name, text) =>
    `--X\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n${text}\r\n`;
  const body = Buffer.from(`${mk('a.txt', 'AAA')}${mk('b.txt', 'BBB')}--X--\r\n`);
  const parts = parseMultipart(body, boundary);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => p.data.toString()), ['AAA', 'BBB']);
});
