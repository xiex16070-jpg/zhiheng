/**
 * 身份与鉴权。
 *
 * 之前服务端直接信任客户端自报的 uid（请求头 / Cookie / 请求体），
 * 等于把用户身份交给调用方声明，任何人换个 id 就能读到别人的文档与会话。
 *
 * 现在改成「签名会话」：Cookie 里的 uid 形如 `id.hmac`，由服务端用 HMAC-SHA256 签发。
 * 签名密钥来自 AUTH_SECRET，缺省时进程首次启动生成并持久化到 data/.auth-secret。
 * 没有合法签名的身份声明一律不被接受。
 *
 * R01（audit N-03/N-16/N-19）收紧：
 * - Cookie 格式升级为 `id.exp.sig`（带过期时间）；旧格式 `id.sig` 仍可验证，
 *   返回 { legacy: true }，bootstrap 会透明重签为新格式。
 * - 所有 id 必须匹配白名单 `ID_RE`（防路径穿越，N-16）。
 * - 本机回环明文身份默认**关闭**，仅 LEGACY_LOOPBACK_IDENTITY=1 时临时开启
 *   （历史数据迁移用）；TRUST_PROXY=1 时带 X-Forwarded-For 的请求不视为回环。
 * - 解析失败一律返回 null（不再回退共享的 'anon' 身份），由调用方决定 401。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

/** userId 白名单：字母数字下划线连字符，1~32 位（N-16：杜绝 `..`、空格等进目录名） */
export const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

let cachedSecret = null;

function secret() {
  if (config.auth.secret) return config.auth.secret;
  if (cachedSecret) return cachedSecret;

  const file = path.join(config.dataDir, '.auth-secret');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) {
      cachedSecret = v;
      return v;
    }
  } catch {
    /* 首次启动 */
  }

  cachedSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  } catch {
    /* 只读文件系统时会话在重启后失效，属可接受行为 */
  }
  return cachedSecret;
}

function signature(data) {
  return crypto.createHmac('sha256', secret()).update(String(data)).digest('base64url').slice(0, 22);
}

// Purpose-separated from session signatures. Only the server can seal/open the
// local credential store; neither the key nor plaintext is returned by HTTP.
function credentialKey() {
  return crypto.createHmac('sha256', secret()).update('zhiheng:local-web-search:v1').digest();
}
export function sealWebSearchKey(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', credentialKey(), iv);
  cipher.setAAD(Buffer.from('zhiheng-web-search-v1'));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function openWebSearchKey(sealed) {
  if (!sealed || !['iv', 'tag', 'ciphertext'].every(k => typeof sealed[k] === 'string' && sealed[k].length <= 2048)) throw new Error('invalid_credential');
  const iv = Buffer.from(sealed.iv, 'base64'), tag = Buffer.from(sealed.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_credential');
  const decipher = crypto.createDecipheriv('aes-256-gcm', credentialKey(), iv);
  decipher.setAAD(Buffer.from('zhiheng-web-search-v1'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * 生成可写进 Cookie 的值：`id.exp.sig`。
 * @throws id 不合法（不匹配 ID_RE）时抛错——签发方必须保证 id 来源可信。
 */
export function signIdentity(id, ttlDays = config.auth.ttlDays) {
  const s = String(id);
  if (!ID_RE.test(s)) throw new Error(`invalid userId: ${s}`);
  const exp = Math.floor(Date.now() / 1000) + Math.max(1, Number(ttlDays) || 365) * 86400;
  return `${s}.${exp}.${signature(`${s}.${exp}`)}`;
}

/**
 * 校验签名。
 * @returns {{id: string, legacy: boolean}|null}
 *  - 新格式 `id.exp.sig`：校验签名与过期时间 → { id, legacy: false }
 *  - 旧格式 `id.sig`（无过期）：校验签名 → { id, legacy: true }（bootstrap 应重签）
 *  - 其余（含明文、伪造、过期、非法 id）→ null
 */
export function verifyIdentity(value) {
  const v = String(value || '');
  const parts = v.split('.');
  if (parts.length === 3) {
    const [id, exp, sig] = parts;
    if (!ID_RE.test(id) || !sig) return null;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return null;
    return safeEqual(sig, signature(`${id}.${exp}`)) ? { id, legacy: false } : null;
  }
  if (parts.length === 2) {
    const [id, sig] = parts;
    if (!ID_RE.test(id) || !sig) return null;
    return safeEqual(sig, signature(id)) ? { id, legacy: true } : null;
  }
  return null;
}

/**
 * 从旧式明文 Cookie/Header 中解析 id（N-19：`id.sig` 残片必须剥掉签名再校验）。
 * 去掉最后一个 `.` 及其后内容，再过 ID_RE；不合法返回 null。
 */
export function parseLegacyId(raw) {
  const s = String(raw || '');
  if (!s) return null;
  const dot = s.lastIndexOf('.');
  const id = dot > 0 ? s.slice(0, dot) : s;
  return ID_RE.test(id) ? id : null;
}

/**
 * 解析一次请求的身份。
 *
 * @param {{cookieValue?:string, headerId?:string, loopback:boolean}} input
 *  - 有合法签名（新/旧格式）→ 用签名里的身份
 *  - 本机回环且 LEGACY_LOOPBACK_IDENTITY=1 → 允许旧式明文身份（迁移期）
 *  - 其他情况 → **null**（调用方负责 401；绝不回退共享的 'anon'）
 */
export function resolveIdentity({ cookieValue = '', headerId = '', loopback = false }) {
  const verified = verifyIdentity(cookieValue);
  if (verified) return verified.id;
  if (loopback && config.auth.legacyLoopback) {
    return parseLegacyId(cookieValue || headerId || '');
  }
  return null;
}

/**
 * R02（N-03）：MCP 调用方解析——令牌必须绑定身份。
 *
 * @param {{authorization?:string, loopback:boolean, uid?:string|null}} input
 * @returns {{ok:true, callerId:string, allowAll:boolean}|{ok:false, status:number}}
 *  - 配置了令牌（MCP_TOKENS 多令牌 / MCP_TOKEN 单令牌）：必须携带
 *    `Authorization: Bearer <token>` 且常量时间比较命中；命中即绑定对应用户，
 *    allowAll=false（只能访问自己的数据）。未命中/未携带 → 401。
 *  - 未配置任何令牌：仅本机回环放行（TRUST_PROXY 判定由调用方完成），
 *    callerId 取签名身份否则 'mcp'，allowAll=true（单机 Claude Desktop 场景）。
 */
export function resolveMcpCaller({ authorization = '', loopback = false, uid = null }) {
  const entries = [...config.mcp.tokens.entries()];
  if (config.mcp.token) entries.push([config.mcp.token, config.mcp.userId]);

  if (entries.length > 0) {
    const m = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
    if (!m) return { ok: false, status: 401 };
    const given = Buffer.from(m[1].trim());
    for (const [tok, boundId] of entries) {
      const want = Buffer.from(tok);
      if (want.length === given.length && crypto.timingSafeEqual(want, given)) {
        return { ok: true, callerId: boundId, allowAll: false };
      }
    }
    return { ok: false, status: 401 };
  }

  if (!loopback) return { ok: false, status: 401 };
  return { ok: true, callerId: uid || config.mcp.userId, allowAll: true };
}
