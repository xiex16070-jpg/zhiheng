import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-csl';
import '@citation-js/plugin-ris';
import { citedSources } from '../agent/text.js';

const bibtex = plugins.config.get('@bibtex').format;
bibtex.useIdAsLabel = true;
// The plugin's ASCII conversion drops characters without a LaTeX equivalent.
bibtex.asciiOnly = false;

export const referenceFormats = new Map([
  ['csl-json', { extension: 'json', type: 'application/vnd.citationstyles.csl+json' }],
  ['bibtex', { extension: 'bib', type: 'application/x-bibtex' }],
  ['ris', { extension: 'ris', type: 'application/x-research-info-systems' }],
  ['apa', { extension: 'txt', type: 'text/plain' }],
]);

function plain(value) {
  return typeof value === 'string' ? value.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim() : '';
}

function names(value) {
  return (Array.isArray(value) ? value : [value]).map(name => {
    const literal = plain(name?.literal || name);
    if (literal) return { literal };
    return Object.fromEntries(['family', 'given'].map(key => [key, plain(name?.[key])]).filter(([, text]) => text));
  }).filter(name => Object.keys(name).length);
}

function dateParts(value) {
  const match = /^([1-9]\d{3})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/.exec(String(value || ''));
  if (!match) return;
  const [year, month, day] = match.slice(1).map(Number);
  if (day && new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return;
  return { 'date-parts': [[year, month, day].filter(Boolean)] };
}

function record(c, id, number) {
  const a = c.authority || {};
  const level = a.evidenceLevel || c.evidenceLevel;
  const preprint = a.type === 'preprint' || a.publicationStatus === 'preprint';
  let type = 'document';
  if (preprint) type = 'manuscript';
  else if (c.recordType === 'textbook-section') type = 'chapter';
  else if (/(?:^|,\s*)journal[- ]article(?:,|$)/i.test(a.publicationType || '')) type = 'article-journal';
  else if (level === 'page-excerpt') type = 'webpage';
  const note = ['正文 [' + number + '] ref=' + id, plain(a.catalog || c.source),
    level === 'abstract' ? '仅摘要' : level === 'page-excerpt' ? '网页摘录' : '',
    preprint ? '预印本' : '', a.authorsTruncated ? '作者名单已截断' : '',
    c.kind === 'doc' ? ['知识库文档', plain(c.heading)].filter(Boolean).join(' · ') : '',
    c.sourceRevision ? '版本 ' + plain(c.sourceRevision) : ''].filter(Boolean).join(' · ');
  const item = { id, type, note };
  const author = names(a.authorList?.length ? a.authorList : a.authors || c.authors);
  if (author.length) item.author = author;
  const issued = dateParts(a.publishedAt || c.publishedAt || c.year || c.sourceEditionDate);
  if (issued) item.issued = issued;
  const accessed = dateParts(plain(a.retrievedAt).slice(0, 10));
  if (accessed) item.accessed = accessed;
  for (const [key, raw] of Object.entries({
    title: c.title || c.docName, 'container-title': a.venue || c.venue || c.sourceTitle,
    publisher: c.publisher, edition: c.sourceEdition, language: c.language,
    volume: a.volume || c.volume, issue: a.issue || c.issue, page: a.page || c.page,
    DOI: a.doi || c.doi, URL: c.sourceUrl || c.canonicalUrl,
  })) {
    const text = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : plain(raw);
    if (text) item[key] = text;
  }
  return item;
}

// Both arrays come from the saved answer. A marker by itself is never a source.
export function citedRecords(result) {
  return citedSources(result?.body, result?.citations).map((source, index) =>
    record(source, String(source.ref ?? source.id), index + 1));
}

const tex = { '\\': '\\textbackslash{}', '{': '\\textbraceleft{}', '}': '\\textbraceright{}',
  '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '<': '\\textless{}', '>': '\\textgreater{}' };
function escapeTex(text) {
  return text.replace(/[\\{}^~<>%$&#_]/g, char => tex[char] ?? '\\' + char);
}
function bibtexRecord(item) {
  const out = { ...item };
  for (const [key, value] of Object.entries(item)) {
    if (typeof value !== 'string' || ['id', 'type'].includes(key)) continue;
    out[key] = key === 'URL' ? value.replace(/[{}\\]/g, encodeURIComponent) : escapeTex(value);
  }
  if (item.author) out.author = item.author.map(name => {
    const safe = Object.fromEntries(Object.entries(name).map(([key, value]) => [key, escapeTex(value)]));
    if (safe.literal?.includes(' and ')) safe.literal = '{' + safe.literal + '}';
    return safe;
  });
  return out;
}

export function exportReferences(result, format) {
  if (!referenceFormats.has(format)) throw new Error('invalid_reference_format');
  const records = citedRecords(result);
  if (!records.length) return null;
  if (format === 'csl-json') return JSON.stringify(records, null, 2) + '\n';
  if (format === 'apa') {
    // Render each entry independently so APA sorting cannot renumber answer citations.
    return records.map((item, index) => '[' + (index + 1) + '] ' +
      new Cite({ ...item, id: 'ref-' + item.id }).format('bibliography', { format: 'text', template: 'apa' }).trim() +
      '\n    ' + item.note).join('\n\n') + '\n';
  }
  return new Cite(format === 'bibtex' ? records.map(bibtexRecord) : records).format(format).trimEnd() + '\n';
}
