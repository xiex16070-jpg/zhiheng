/** AI-authored questions/claims over public original text; deliberately has NO gold labels. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest } from './annotation-workflow.mjs';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const drafts = [
  ['96199028498296', '函数作为一等值有哪些用法？', '函数可以作为参数传给其他函数，也可以作为结果返回。'],
  ['112993184944198', '教材如何描述 Coq 的内建类型？', '这段教材称布尔、整数和字符串都是 Coq 内建的原语类型。'],
  ['248972118884854', 'Check 指令能提供什么信息？', '该教材给出了 Check 指令在全部输入上的平均执行时间。'],
  ['76197957658141', '模块如何避免定义名称冲突？', '模块中的定义可以通过 X.foo 这样的名称引用。'],
  ['204593812226983', 'repeat 的两个参数分别表示什么？', '这段程序的 repeat n count 总是返回空列表。'],
  ['150266300691305', '列表联接有什么语法和实现？', '该段原文给出了 app 在 GPU 上运行的性能数据。'],
];
export async function publicPilot() {
  const rows = new Map((await fs.readFile(path.join(root, 'data/formal/papers.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse).map(r => [String(r.id), r]));
  const licenseNotice = await fs.readFile(path.join(root, 'data/formal/sources/lf-current/LICENSE'), 'utf8');
  return { version: 'public-annotation-pilot-20261107-v1', provenance: 'AI-authored pilot tasks, public source-checked passages, no human annotations and no expected labels. Not a promotion benchmark.',
    cases: drafts.map(([ref, question, claim], i) => {
      const r = rows.get(ref); if (!r || r.contentRole !== 'exposition' || digest(r.abstract) !== r.contentSha256 || r.license !== 'MIT') throw new Error('public_pilot_source_mismatch');
      return { id: `pilot-${i + 1}`, question, claim, source: { ref, uri: r.sourceUrl, license: r.license, public: true, text: r.abstract,
        attribution: `${r.sourceTitle}; ${r.authors.join(', ')}; ${r.translators}`, licenseNotice }, span: { start: 0, end: r.abstract.length } };
    }) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--output'); if (i < 0 || !process.argv[i + 1]) throw new Error('Use --output NEW_FILE.json');
  const pack = await publicPilot(); await fs.writeFile(process.argv[i + 1], JSON.stringify(pack, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: process.argv[i + 1], cases: pack.cases.length, humanLabels: 0 }));
}
