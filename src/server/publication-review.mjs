import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';

const DAY = 86400000;
const RETRY = 300000;

function normalizeDoi(value) {
  if (typeof value !== 'string') return '';
  let doi = value.trim();
  if (/^https?:\/\/(?:dx\.)?doi\.org\//i.test(doi)) {
    try { doi = decodeURIComponent(new URL(doi).pathname.slice(1)); } catch { return ''; }
  }
  doi = doi.replace(/^doi:\s*/i, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s\p{C}<>"\\]{1,200}$/u.test(doi) ? doi : '';
}

// Only accept explicit front-matter identifiers. A citation or a reference-list
// DOI may identify a different publication from the document being imported.
export function savedPublicationDoi(record) {
  const direct = normalizeDoi(record?.authority?.doi || record?.doi || record?.DOI)
    || normalizeDoi(record?.sourceUrl) || normalizeDoi(record?.canonicalUrl);
  if (direct) return direct;
  if (typeof record?.text !== 'string') return '';
  const header = record.text.slice(0, 1800).split(/\r?\n/).slice(0, 16);
  const found = new Set();
  for (const line of header) {
    const s = line.trim();
    if (/^(?:references|bibliography|abstract\b|参考文献|摘要)/i.test(s)) break;
    const match = /^(?:doi\s*[:：]\s*|https?:\/\/(?:dx\.)?doi\.org\/)(10\.\S+)$/i.exec(s);
    if (match) found.add(normalizeDoi(match[1]));
  }
  return found.size === 1 ? [...found][0] : '';
}

async function savedCitations({ taskId, conversationId, messageId }, uid, store, workspaceId) {
  const task = taskId && /^[\w-]{1,128}$/.test(taskId) ? await store.getTaskForUser(taskId, uid) : null;
  if (taskId && (!task || task.checkpoint?.rewoundAt)) return;
  const id = task?.conversationId || conversationId;
  if (!id || !/^[\w-]{1,128}$/.test(id)) return;
  const conversation = await store.getConversation(id);
  if (conversation?.userId !== uid || (conversation.workspaceId || 'default') !== workspaceId) return;
  if (task) return task.result?.citations;
  if (!/^\d+$/.test(String(messageId)) || !Number.isSafeInteger(Number(messageId))) return;
  return (await store.citationMessage(id, Number(messageId)))?.citations;
}

export function resolveSavedPublications(context, uid, { getPaper, getChunkById, store, workspaceId = 'default' }) {
  let citations;
  return async ref => {
    if (typeof ref !== 'string' || !/^[\w-]{1,128}$/.test(ref)) return null;
    let cite;
    if (context.taskId || context.conversationId) {
      citations ||= savedCitations(context, uid, store, workspaceId);
      cite = (await citations)?.find(c => String(c.ref || c.id) === ref);
      if (!cite) return null;
    }
    if (/^\d+$/.test(ref)) {
      const paper = await getPaper(Number(ref));
      return paper?.recordType === 'textbook-section' ? null : paper;
    }
    if (!/^auth_[a-f0-9]{20}$/.test(ref)) {
      const chunk = await getChunkById(ref, uid);
      return chunk ? { text: chunk.docText } : null;
    }
    return ['academic', 'preprint'].includes(cite?.authority?.type) ? cite : null;
  };
}

function crossref(record, doi) {
  const work = record?.message;
  if (normalizeDoi(work?.DOI) !== doi || typeof work.type !== 'string') throw new Error('invalid_record');
  const notices = [];
  const incoming = work['updated-by'] || [];
  const inSitu = (work['update-to'] || []).filter(entry => normalizeDoi(entry?.DOI) === doi);
  for (const entry of [...incoming, ...inSitu]) {
    if (typeof entry?.type !== 'string') throw new Error('invalid_record');
    const type = entry.type.toLowerCase();
    const status = /^(retraction|withdrawal|removal)$/.test(type) ? 'retracted'
      : /^(correction|corrigendum|erratum)$/.test(type) ? 'corrected' : 'other_update';
    notices.push({ status, type: type.slice(0, 64), noticeDoi: normalizeDoi(entry.DOI),
      source: ['publisher', 'retraction-watch'].includes(entry.source) ? entry.source : 'Crossref' });
  }
  return { notices };
}

function europePmc(record, doi) {
  const rows = record?.resultList?.result;
  if (!Array.isArray(rows)) throw new Error('invalid_record');
  const matches = rows.filter(row => normalizeDoi(row?.doi) === doi);
  if (!matches.length) return { issue: 'not_found' };
  const notices = [];
  for (const row of matches) {
    const types = row.pubTypeList?.pubType || [];
    if (types.some(t => /^retracted publication$/i.test(t))) notices.push({ status: 'retracted', type: 'Retracted Publication' });
    for (const link of row.commentCorrectionList?.commentCorrection || []) {
      const type = String(link.type || '');
      // "Retraction of" / "Erratum for" describe the notice, not the original.
      if (/^retraction\s*in$/i.test(type)) notices.push({ status: 'retracted', type });
      if (/^(?:erratum|correction|corrected and republished)\s*in$/i.test(type)) notices.push({ status: 'corrected', type });
      if (/^expression of concern\s*in$/i.test(type)) notices.push({ status: 'other_update', type });
    }
  }
  return { notices };
}

function openAlex(row, doi) {
  if (normalizeDoi(row?.doi) !== doi || typeof row.is_retracted !== 'boolean') throw new Error('invalid_record');
  return { retracted: row.is_retracted, notices: row.is_retracted ? [{ status: 'retracted', type: 'is_retracted' }] : [] };
}

function summarize(sources) {
  const notices = sources.flatMap(s => s.notices || []);
  const has = status => notices.some(n => n.status === status);
  const incomplete = sources.some(s => s.issue && s.issue !== 'not_found');
  if (has('retracted') && (sources.some(s => s.retracted === false) || notices.some(n => n.type === 'reinstatement'))) return 'conflict';
  if (has('retracted')) return 'retracted';
  if (has('other_update')) return 'unknown';
  if (has('corrected')) return 'corrected';
  return !incomplete && sources.some(s => !s.issue && s.name !== 'OpenAlex') ? 'no_notice' : 'unknown';
}

export function createPublicationReviews({ directory, readBody, settings, now = Date.now }) {
  async function lookup(doi, options) {
    const encoded = encodeURIComponent(doi);
    const epmc = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search');
    epmc.search = new URLSearchParams({ query: `DOI:"${doi}"`, format: 'json', pageSize: '10', resultType: 'core' });
    const services = [
      ['crossref', 'Crossref', 'https://api.crossref.org/works/' + encoded, crossref],
      ['europepmc', 'Europe PMC', epmc.href, europePmc],
      ['openalex', 'OpenAlex', 'https://api.openalex.org/works/https://doi.org/' + encoded + '?select=doi,is_retracted', openAlex],
    ].filter(([id]) => options.sources.includes(id)
      && !(id === 'europepmc' && options.europePmcEnabled === false) && !(id === 'openalex' && options.openAlexEnabled === false));
    return Promise.all(services.map(async ([id, name, url, parse]) => {
      const checkedAt = new Date(now()).toISOString();
      try {
        const headers = id === 'openalex' && options.openAlexKey ? { authorization: 'Bearer ' + options.openAlexKey } : {};
        const result = parse(JSON.parse(await readBody(url, headers)), doi);
        return { name, url, checkedAt, ...result };
      } catch (error) {
        const issue = error.status === 404 ? 'not_found' : ['AbortError', 'TimeoutError'].includes(error.name) ? 'timeout'
          : error.message === 'invalid_record' || error instanceof SyntaxError ? 'invalid_response' : 'unavailable';
        return { name, url, checkedAt, issue, ...(Number.isInteger(error.status) ? { httpStatus: error.status } : {}) };
      }
    }));
  }

  return async function review(userId, value, confirmDoi = null, mode = 'read') {
    const doi = normalizeDoi(value);
    const unknown = reason => ({ doi, status: 'unknown', reason, checkedAt: null, expiresAt: null, cached: false, stale: false, sources: [] });
    if (!doi) return unknown('missing_doi');
    const key = crypto.createHash('sha256').update(JSON.stringify([userId, doi])).digest('hex');
    const file = path.join(directory, key + '.json');
    return withFileLock(file, async () => {
      let old;
      try { old = JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const stale = old && Date.parse(old.expiresAt) <= now();
      if (confirmDoi && normalizeDoi(confirmDoi) !== doi) return unknown('identifier_changed');
      if (old && mode === 'stop') {
        old.tracking = false;
        await writeJsonAtomic(file, old, { mode: 0o600 });
      }
      if (confirmDoi && mode === 'track' && old && !stale && !old.tracking) {
        old.tracking = true;
        await writeJsonAtomic(file, old, { mode: 0o600 });
      }
      const check = mode !== 'stop' && (confirmDoi || (mode === 'use' && old?.tracking));
      if (!check || old && !stale) return old ? { ...old, cached: true, stale: Boolean(stale) } : unknown('unchecked');
      const options = settings();
      const disabled = () => old ? { ...old, cached: true, stale: true, reason: 'disabled' } : unknown('disabled');
      if (!options.enabled) return disabled();
      const sources = await lookup(doi, options);
      if (!sources.length) return disabled();
      const status = summarize(sources);
      const checkedAt = new Date(now()).toISOString();
      const incomplete = sources.some(s => s.issue && s.issue !== 'not_found');
      const snapshot = { doi, status, checkedAt, sources, incomplete, tracking: mode === 'track' || old?.tracking === true,
        expiresAt: new Date(now() + (incomplete || status === 'unknown' ? RETRY : DAY)).toISOString() };
      if (old && (status === 'unknown' || (incomplete && status !== old.status))) {
        const prior = ['retracted', 'corrected', 'conflict'].includes(old.status) ? old : old.previous;
        if (prior) snapshot.previous = { status: prior.status, checkedAt: prior.checkedAt };
      }
      await writeJsonAtomic(file, snapshot, { mode: 0o600 });
      return { ...snapshot, cached: false, stale: false };
    });
  };
}
