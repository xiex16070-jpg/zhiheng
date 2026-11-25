import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('saved DOI review through file import, explicit consent, citation batch, and owner boundary', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-review-http-'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && !child.signalCode) { const end = once(child, 'exit'); child.kill(); await end; }
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  // config.mjs reads .env relative to its source, irrespective of the process cwd.
  await fs.cp(path.join(root, 'src'), path.join(directory, 'src'), { recursive: true });
  for (const name of ['server.mjs', 'package.json']) await fs.copyFile(path.join(root, name), path.join(directory, name));
  await fs.symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'junction');
  const data = path.join(directory, 'data'); await fs.mkdir(data);
  const corpus = path.join(data, 'papers.jsonl'); await fs.writeFile(corpus, '');
  const doi = '10.5555/fixture-biblio';
  await fs.writeFile(path.join(directory, 'offline.mjs'), `
    import fs from 'node:fs/promises';
    globalThis.fetch = async url => {
      await fs.appendFile('requests.txt', String(url) + '\\n');
      if (new URL(url).hostname === 'api.crossref.org') return Response.json({message: {
        DOI: '${doi}', type: 'journal-article', 'updated-by': [{type: 'correction', source: 'publisher', DOI: '10.5555/fixture-notice'}]
      }});
      throw new Error('unexpected fixture request');
    };
  `);
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { PORT: '0', HOST: '127.0.0.1', DATA_DIR: data, CORPUS_JSONL: corpus, MYSQL_ENABLED: '0',
    REDIS_ENABLED: '0', EMBEDDING_PROVIDER: 'off', RERANK_ENABLED: '0', SCHOLAR_SOURCES: 'crossref' });
  child = spawn(process.execPath, ['--import', './offline.mjs', 'server.mjs'], { cwd: directory, env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '', base;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', part => { logs = (logs + part).slice(-1200); });
  for (let i = 0; i < 250; i++) {
    if (child.exitCode !== null) assert.fail(logs);
    try {
      const port = (await fs.readFile(path.join(data, '.server-port'), 'utf8')).trim();
      base = 'http://127.0.0.1:' + port;
      if ((await (await fetch(base + '/api/health')).json()).ready) break;
    } catch { /* Wait for the ephemeral listener. */ }
    await new Promise(resolve => setTimeout(resolve, 40));
    if (i === 249) assert.fail('fixture did not boot: ' + logs);
  }
  const login = async () => (await fetch(base + '/api/bootstrap')).headers.get('set-cookie').split(';')[0];
  const cookie = await login(), otherCookie = await login();
  const form = new FormData();
  form.append('file', new Blob(['Study title\nDOI: ' + doi + '\nAbstract\nFixture body.']), 'study.txt');
  const upload = () => fetch(base + '/api/kb/import', { method: 'POST', headers: { cookie }, body: form }).then(r => r.json());
  const first = (await upload()).results[0];
  assert.equal(first.publicationReview.reason, 'unchecked');
  const ref = first.doc.id + '_0', endpoint = base + '/api/literature/status?ref=' + ref;
  const post = body => fetch(endpoint, { method: 'POST', headers: { cookie, 'x-publication-review': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { cookie: otherCookie } })).status, 404);
  assert.equal((await post({ refs: [ref], mode: 'use' })).reviews[0].review.reason, 'unchecked');
  await assert.rejects(fs.access(path.join(directory, 'requests.txt')), { code: 'ENOENT' });
  assert.equal((await post({ mode: 'track', confirmDoi: doi })).status, 'corrected');
  const again = (await upload()).results[0];
  assert.equal(again.publicationReview.cached, true); assert.equal(again.publicationReview.status, 'corrected');
  assert.equal((await post({ mode: 'read', refs: [ref] })).reviews[0].review.sources[0].notices[0].source, 'publisher');
  assert.equal((await post({ mode: 'stop', confirmDoi: doi })).tracking, false);
  assert.equal((await fs.readFile(path.join(directory, 'requests.txt'), 'utf8')).trim().split('\n').length, 1);
});
