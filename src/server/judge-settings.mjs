/** Owner-scoped independent judge configuration; keys never leave this module. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { createCredentialCodec } from './credential-codec.mjs';
import { withFileLock, writeJsonAtomic } from './fsutil.mjs';
const problem = (code, status = 400) => Object.assign(new Error(code), { code, status });
const fileFor = userId => { if (!/^[\w-]{1,64}$/.test(userId || '')) throw problem('invalid_owner', 403); return path.join(config.dataDir, 'judges', userId + '.json'); };
const codec = createCredentialCodec(config.dataDir);
const defaults = () => ({ version: 1, revision: 0, enabled: false, baseUrl: '', model: '', apiKey: '', timeoutMs: 45000, maxStatements: 12, maxOutputTokens:4096 });
async function load(userId) {
  const file = fileFor(userId);
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20000) throw new Error('invalid_store');
    const row = JSON.parse(await fs.readFile(file, 'utf8'));
    if (row.version !== 1 || !Number.isSafeInteger(row.revision)) throw new Error('invalid_store');
    return { ...defaults(), ...row, apiKey: row.sealedKey ? await codec.open(row.sealedKey, 'judge:' + userId) : '' };
  } catch (error) { if (error.code === 'ENOENT') return defaults(); throw problem('judge_settings_unreadable', 409); }
}
const publicSettings = ({sealedKey, apiKey, ...row}) => ({ ...row, hasKey: Boolean(apiKey), apiKey: '' });
export async function judgeSettings(userId) { return publicSettings(await load(userId)); }
export async function resolveJudge(userId) { const row = await load(userId); return row.enabled && row.baseUrl && row.model ? row : null; }
export function independentJudge(judge, answerProvider) {
  const name = p => String(p?.model || '').trim().toLowerCase().split('/').at(-1).replace(/:latest$/, '');
  // Endpoint aliases do not make the same named model an independent judge.
  return Boolean(judge?.baseUrl && name(judge) && name(answerProvider) && name(judge) !== name(answerProvider));
}
export async function saveJudgeSettings(userId, input) {
  return withFileLock(fileFor(userId), async () => {
    const old = await load(userId);
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !['revision','enabled','baseUrl','model','apiKey','clearKey','timeoutMs','maxStatements','maxOutputTokens'].includes(k))) throw problem('invalid_judge_settings');
    if (input.revision !== old.revision) throw problem('settings_conflict', 409);
    const row = { ...old, ...input, apiKey: input.clearKey ? '' : input.apiKey || old.apiKey, revision: old.revision + 1 };
    if (typeof row.enabled !== 'boolean' || typeof row.model !== 'string' || row.model.length > 160 || typeof row.apiKey !== 'string' || !/^[\x21-\x7e]{0,1024}$/.test(row.apiKey)) throw problem('invalid_judge_settings');
    row.baseUrl = String(row.baseUrl || '').trim().replace(/\/$/, ''); row.model = row.model.trim();
    if (row.baseUrl) {
      let url; try {url = new URL(row.baseUrl);} catch {throw problem('invalid_judge_url');}
      if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || row.baseUrl.length > 512 || (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw problem('invalid_judge_url');
    }
    if (row.enabled && (!row.model || !row.baseUrl)) throw problem('judge_not_configured');
    row.timeoutMs = Math.max(1000, Math.min(60000, Number(row.timeoutMs) || 45000));
    row.maxStatements = Math.max(1, Math.min(24, Math.floor(Number(row.maxStatements) || 12)));
    row.maxOutputTokens = Math.max(512, Math.min(8192, Math.floor(Number(row.maxOutputTokens) || 4096)));
    row.audit = [...(Array.isArray(old.audit) ? old.audit : []), {at:new Date().toISOString(),revision:row.revision,
      enabled:row.enabled,baseUrl:row.baseUrl,model:row.model,timeoutMs:row.timeoutMs,maxStatements:row.maxStatements,maxOutputTokens:row.maxOutputTokens,
      keyChanged:row.apiKey!==old.apiKey}].slice(-50);
    const {apiKey, clearKey, ...stored} = row;
    stored.sealedKey = apiKey ? await codec.seal(apiKey, 'judge:' + userId) : null;
    await writeJsonAtomic(fileFor(userId), stored, {mode:0o600}); return publicSettings(row);
  });
}
export async function handleJudgeSettings({req,res,url,userId,localManage,readBody,sendJson}) {
  if (url.pathname !== '/api/knowledge/judge') return false;
  const reply = (status, data) => {sendJson(res,status,data);return true;};
  if (!localManage) return reply(403,{error:'local_settings_required'});
  try {
    if (req.method === 'GET') return reply(200,await judgeSettings(userId));
    if (req.method !== 'POST') return reply(405,{error:'method_not_allowed'});
    const origin = `${req.socket.encrypted ? 'https':'http'}://${req.headers.host}`;
    if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) return reply(403,{error:'same_origin_required'});
    return reply(200,await saveJudgeSettings(userId,await readBody(req)));
  } catch(error) {return reply(error.status || 500,{error:error.code || 'judge_settings_failed'});}
}
