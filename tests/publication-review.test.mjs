import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPublicationReviews, savedPublicationDoi, resolveSavedPublications } from '../src/server/publication-review.mjs';

const doi = '10.5555/fixture.123';
const ref = 'auth_' + 'a'.repeat(20);
const original = () => ({
  'api.crossref.org': { message: { DOI: doi, type: 'journal-article' } },
  'www.ebi.ac.uk': { resultList: { result: [{ doi, id: '123', pubTypeList: { pubType: ['Journal Article'] } }] } },
  'api.openalex.org': { doi: 'https://doi.org/' + doi, is_retracted: false },
});
async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'publication-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let time = Date.parse('2026-01-01T00:00:00Z');
  const calls = [], records = original(), settings = { enabled: true, sources: ['crossref', 'europepmc', 'openalex'] };
  const options = { directory, settings: () => settings, now: () => time, readBody: async (url, headers) => {
    const address = new URL(url);
    calls.push(address);
    assert.deepEqual(headers, {});
    const record = records[address.hostname];
    if (record instanceof Error) throw record;
    return JSON.stringify(record);
  } };
  return { review: createPublicationReviews(options), restart: () => createPublicationReviews(options),
    calls, records, settings, step: delta => { time += delta; } };
}

test('saved DOI comes only from explicit identity or unambiguous front matter', () => {
  assert.equal(savedPublicationDoi({ authority: { doi: doi.toUpperCase() } }), doi);
  assert.equal(savedPublicationDoi({ sourceUrl: 'https://doi.org/' + doi }), doi);
  assert.equal(savedPublicationDoi({ text: 'Title\nDOI: ' + doi + '\nAbstract…\nReferences\nDOI: 10.5555/other' }), doi);
  for (const text of ['References\nDOI: ' + doi, 'This mentions ' + doi, 'DOI: ' + doi + '\nDOI: 10.5555/other']) {
    assert.equal(savedPublicationDoi({ text }), '');
  }
});

test('saved source ownership and identity control which DOI can be queried', async () => {
  const citation = { ref, kind: 'external', authority: { type: 'academic', doi } };
  const store = { getTaskForUser: async (taskId, uid) => taskId === 't1' && uid === 'alice' ? { conversationId: 'c', result: { citations: [citation] } } : null,
    getConversation: async () => ({ userId: 'alice' }), citationMessage: async (_id, messageId) => messageId === 1 ? { citations: [citation] } : null };
  const deps = { store, getChunkById: async (id, uid) => id === 'kdoc_0' && uid === 'alice' ? { docText: 'DOI: ' + doi } : null,
    getPaper: async () => ({ recordType: 'textbook-section' }) };
  const savedPublication = (context, uid) => resolveSavedPublications(context, uid, deps)(context.ref);
  assert.equal(await savedPublication({ ref, taskId: 't1' }, 'alice'), citation);
  assert.equal(await savedPublication({ ref, taskId: 't1' }, 'bob'), null);
  assert.equal(await savedPublication({ ref, conversationId: 'c', messageId: 1 }, 'alice'), citation);
  assert.equal(await savedPublication({ ref, conversationId: 'c', messageId: 1 }, 'bob'), null);
  assert.equal(savedPublicationDoi(await savedPublication({ ref: 'kdoc_0' }, 'alice')), doi);
  assert.equal(await savedPublication({ ref: 'kdoc_0' }, 'bob'), null);
  assert.equal(await savedPublication({ ref: '1' }, 'alice'), null);
  assert.equal(await savedPublication({ ref, doi }, 'alice'), null);
  assert.equal(await resolveSavedPublications({ taskId: 't1' }, 'alice', { ...deps, workspaceId: 'other' })(ref), null);
});

test('read-only import/citation, missing DOI, disabled services and mismatched confirmation make no calls', async t => {
  const { review, calls, settings } = await setup(t);
  assert.equal((await review('a', doi)).reason, 'unchecked');
  assert.equal((await review('a', '', doi)).reason, 'missing_doi');
  assert.equal((await review('a', doi, '10.5555/other')).reason, 'identifier_changed');
  settings.enabled = false;
  assert.equal((await review('a', doi, doi)).reason, 'disabled');
  assert.equal(calls.length, 0);
});

test('exact DOI checks, notice direction, cache isolation, expiry and coalescing', async t => {
  const { review, restart, calls, records, step } = await setup(t);
  records['api.crossref.org'].message['update-to'] = [{ type: 'retraction', DOI: '10.5555/another-original' }];
  records['www.ebi.ac.uk'].resultList.result[0].commentCorrectionList = { commentCorrection: [{ type: 'Retraction of' }] };
  const [first, cached] = await Promise.all([review('a', doi, doi), review('a', doi, doi)]);
  assert.equal(first.status, 'no_notice'); assert.equal(cached.cached, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].searchParams.get('query'), 'DOI:"' + doi + '"');
  assert.equal(calls[2].searchParams.has('filter'), false);
  assert.equal(first.sources.every(s => s.checkedAt === first.checkedAt && s.url.startsWith('https://')), true);
  step(1000); assert.equal((await restart()('a', doi)).checkedAt, first.checkedAt);
  assert.equal((await review('b', doi)).reason, 'unchecked');
  step(86400000); assert.equal((await review('a', doi)).stale, true); assert.equal(calls.length, 3);
  const updated = await review('a', doi, doi); assert.equal(calls.length, 6);
  assert.notEqual(updated.checkedAt, first.checkedAt); assert.equal(updated.stale, false);
});

test('retraction, correction, source conflict, preserved provenance and prior adverse evidence', async t => {
  const { review, records, step } = await setup(t);
  const notice = { DOI: '10.5555/notice', type: 'retraction', source: 'retraction-watch' };
  records['api.crossref.org'].message['updated-by'] = [notice];
  records['api.openalex.org'].is_retracted = true;
  let result = await review('a', doi, doi);
  assert.equal(result.status, 'retracted');
  assert.deepEqual(result.sources[0].notices[0], { status: 'retracted', type: 'retraction', noticeDoi: notice.DOI, source: notice.source });
  records['api.openalex.org'].is_retracted = false; step(86400001);
  assert.equal((await review('a', doi, doi)).status, 'conflict');
  records['api.crossref.org'].message['updated-by'] = [{ ...notice, type: 'correction' }];
  step(86400001); result = await review('a', doi, doi); assert.equal(result.status, 'corrected');
  for (const key of Object.keys(records)) records[key] = new DOMException('offline fixture', 'AbortError');
  step(86400001); result = await review('a', doi, doi);
  assert.equal(result.status, 'unknown'); assert.equal(result.previous.status, 'corrected');
  assert.equal(result.sources.every(s => s.issue === 'timeout'), true);
});

test('upstream errors, missing DOI matches and incomplete coverage remain unknown', async t => {
  const { review, records, settings } = await setup(t);
  records['api.crossref.org'] = Object.assign(new Error('HTTP 503'), { status: 503 });
  records['www.ebi.ac.uk'].resultList.result[0].doi = '10.5555/unrelated';
  let result = await review('a', doi, doi);
  assert.equal(result.status, 'unknown'); assert.equal(result.incomplete, true);
  assert.equal(result.sources[0].httpStatus, 503); assert.equal(result.sources[1].issue, 'not_found');
  settings.sources = ['europepmc'];
  records['www.ebi.ac.uk'].resultList.result[0] = { doi, commentCorrectionList: { commentCorrection: [{ type: 'Erratum in' }] } };
  result = await review('b', doi, doi); assert.equal(result.status, 'corrected');
  records['www.ebi.ac.uk'].resultList.result[0] = { doi, pubTypeList: { pubType: ['Retracted Publication'] } };
  assert.equal((await review('c', doi, doi)).status, 'retracted');
});

test('only explicit per-user DOI opt-in permits later renewal on use, and consent can be revoked', async t => {
  const { review, calls, step, restart } = await setup(t);
  assert.equal((await review('a', doi, null, 'use')).reason, 'unchecked');
  const first = await review('a', doi, doi, 'track');
  assert.equal(first.tracking, true);
  assert.equal((await review('a', doi, null, 'use')).checkedAt, first.checkedAt);
  step(86400001);
  assert.equal((await review('a', doi)).stale, true);
  assert.equal((await review('b', doi, null, 'use')).reason, 'unchecked');
  assert.equal(calls.length, 3);
  const renewed = await restart()('a', doi, null, 'use');
  assert.equal(renewed.stale, false); assert.notEqual(renewed.checkedAt, first.checkedAt);
  const stopped = await review('a', doi, doi, 'stop');
  assert.equal(stopped.tracking, false);
  step(86400001);
  assert.equal((await restart()('a', doi, null, 'use')).stale, true);
  assert.equal(calls.length, 6);
});
