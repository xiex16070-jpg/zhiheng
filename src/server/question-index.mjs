import { questionPassages, sectionDocIds } from './kb.mjs';
import { questionPaperTopics } from './rag.mjs';

const tidy = value => String(value || '').replace(/\s+/g, ' ').trim();
const short = (s, limit) => s.length > limit ? s.slice(0, limit - 1) + '…' : s;
const generic = /^(?:专题讲义|课堂讲义|课程讲义|辅导讲义|学习资料|相关材料|导入资料|正文|摘要|目录|前言|引言|参考文献|附件|contents|introduction|abstract|第[\d一二三四五六七八九十百]+[章节篇讲页])$/iu;
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function contentText(value, filename = '') {
  let text = String(value || '').normalize('NFKC');
  const name = String(filename || '').normalize('NFKC');
  const stem = name.replace(/\.[^.]+$/, '');
  if (name) text = text.replace(new RegExp(escapeRegExp(name), 'giu'), ' ');
  // Administrative stems remain file identifiers. A semantic word in a sentence
  // must survive even when a document happened to be named after that concept.
  if (stem) text = text.replace(new RegExp('^\\s*' + escapeRegExp(stem) + '\\s*$', 'gimu'), ' ');
  if (stem.length >= 4 && /_|(?:19|20)\d{2}|第.*页|(?:^|[-\s])ocr(?:$|[-\s])/iu.test(stem)) {
    text = text.replace(new RegExp(escapeRegExp(stem), 'giu'), ' ');
  }
  return text.replace(/[^\s《》“”。，、：:]+\.(?:pdf|docx?|md|txt|pptx?|xlsx?)\b/giu, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^[\s#>*`-]+/gmu, '')
    .split(/\r?\n/).filter(line => !/^\s*(?:\d{4}[-_/年]\d{1,2}(?:[-_/月]\d{1,2}日?)?|第?\s*\d+\s*(?:[-–—至]\s*\d+)?\s*页)\s*$/u.test(line))
    .join('\n');
}

function cleanHeading(value, filename) {
  const heading = tidy(contentText(value, filename));
  if (generic.test(heading)) return '';
  return heading.replace(/^(?:第[\d一二三四五六七八九十百]+[章节篇讲]|[（(][\d一二三四五六七八九十]+[）)]|\d+(?:\.\d+)*[.、])\s*/u, '');
}

function excerptTopic(sample, filename) {
  const lines = contentText(sample, filename).split(/[\n。！？；]/u)
    .map(line => cleanHeading(line, filename)).filter(line => line.length >= 6 && !generic.test(line));
  // Use the actual first substantive clause, rather than fabricate keywords from a file label.
  return lines.map(line => line.split(/[，,：:]/u).find(part => part.trim().length >= 6) || line)[0]?.trim() || '';
}

function documentQuestion(passage) {
  const heading = cleanHeading(passage.heading, passage.name);
  const focus = short(heading || excerptTopic(passage.sample, passage.name), 46);
  if (!focus) return null;
  return { ref: passage.id, docId: passage.docId, kind: 'doc', source: '导入资料', topic: short(focus, 28),
    question: heading ? `${focus}的核心观点和依据是什么？请结合材料说明。`
      : `怎样理解“${focus}”？请结合相关材料说明。` };
}

function paperQuestion(p) {
  const title = short(cleanHeading(p.section) || cleanHeading(tidy(p.title).split(/\s*·\s*/u).at(-1)), 46);
  const prompt = /证明|归纳|定理|推导/.test(title) ? '这段论证用到了哪些前提？'
    : /规则|定义|类型|语义/.test(title) ? '这一节怎样界定核心概念？' : '作者要说明的主要问题是什么？';
  return { ref: String(p.id), kind: 'paper', source: '专业文献', topic: short(title || '文献论证', 28),
    question: title ? `关于${title}，${prompt}请用原文说明。` : '当前文献的核心论点有哪些依据？请用原文说明。' };
}

export async function researchQuestions(userId, discipline = '', round = 0) {
  if (!userId || userId === '*') return [];
  const members = await sectionDocIds(userId, discipline);
  const privateScope = members !== null;
  const docs = privateScope || !discipline ? await questionPassages(userId, members, round, 6) : [];
  const maxDocs = privateScope ? 6 : 3;
  const papers = privateScope ? [] : await questionPaperTopics(discipline, round, 6 - Math.min(maxDocs, docs.length));
  return [...docs.slice(0, 6 - papers.length).map(documentQuestion).filter(Boolean), ...papers.map(paperQuestion)];
}
