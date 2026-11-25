import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/server/config.mjs';

export const ROOT = config.root;
export const DATA = path.resolve(ROOT, config.dataDir);
export const WANT_PORT = config.port;
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A GUI launch has no inheritable standard handles. Return one result to its
 * private one-use temp filename, keeping the reply out of the server's env. */
export async function runRuntimeCommand(command) {
  const nonce = process.env.ZHIHENG_DESKTOP_REPLY;
  delete process.env.ZHIHENG_DESKTOP_REPLY;
  const reply = process.env.ZHIHENG_DESKTOP === '1' && /^[a-f0-9]{32}$/.test(nonce || '')
    ? path.join(os.tmpdir(), 'zhiheng-reply-' + nonce + '.json') : null;
  let response;
  try { response = { ok: true, result: await command() }; }
  catch (error) {
    response = { ok: false, error: String(error.message || error).slice(0, 1500) };
    process.exitCode = 1;
    if (!reply) console.error(response.error);
  }
  if (reply) await fs.writeFile(reply, JSON.stringify(response), { flag: 'wx', mode: 0o600 });
}

export function runtimeHost(info) {
  if (info.host === '::') return '::1';
  if (!info.host || info.host === '0.0.0.0' || info.host === 'localhost') return '127.0.0.1';
  return info.host;
}

export function runtimeUrl(info) {
  const host = runtimeHost(info);
  return `http://${host.includes(':') ? '[' + host + ']' : host}:${info.port}`;
}

// Keep the existing browser origin: changing localhost to an IP would hide
// origin-bound login cookies, conversation identity and saved UI preferences.
export function browserUrl(info) {
  return ['127.0.0.1', '::1'].includes(runtimeHost(info)) ? `http://localhost:${info.port}` : runtimeUrl(info);
}

/** Direct HTTP avoids proxy settings; the boot identity must match the local lock owner. */
export async function probeRuntime(info, { timeoutMs = 1500 } = {}) {
  if (!info?.port || !info.bootId) return false;
  return new Promise(resolve => {
    let settled = false;
    const finish = result => { if (!settled) { settled = true; req.destroy(); resolve(result); } };
    const req = http.request({
      host: runtimeHost(info), port: info.port, path: '/api/health', method: 'GET',
      timeout: timeoutMs, headers: { connection: 'close' },
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 65536) finish(false); });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          finish(res.statusCode === 200 && res.headers['x-kb-boot'] === info.bootId && json.ok === true && json.ready === true);
        } catch { finish(false); }
      });
      res.on('error', () => finish(false));
      res.on('aborted', () => finish(false));
      res.on('close', () => finish(false));
    });
    req.on('timeout', () => finish(false));
    req.on('error', () => finish(false));
    req.end();
  });
}
