import crypto from 'node:crypto';
import { ID_RE } from './auth.mjs';

/** SERVICE_TOKENS is a server-side secret: comma-separated token:userId, never returned to a client. */
export function createServiceAuth(raw = process.env.SERVICE_TOKENS || '') {
  const entries = [];
  for (const value of String(raw).split(',')) {
    const delimiter = value.lastIndexOf(':'); if (delimiter < 1) continue;
    const token = value.slice(0, delimiter).trim(), userId = value.slice(delimiter + 1).trim();
    if (token.length < 24 || token.length > 512 || !ID_RE.test(userId) || /\s/.test(token)) continue;
    entries.push({ hash: crypto.createHash('sha256').update(token).digest(), userId });
  }
  return {
    enabled: entries.length > 0,
    authenticate(req, { route = '/api/chat' } = {}) {
      // Service principals only submit scheduled tasks; cannot mutate settings or grant approval.
      if (String(req.method).toUpperCase() !== 'POST' || route !== '/api/chat') return null;
      const auth = String(req.headers?.authorization || ''); if (!auth.startsWith('Bearer ') || auth.length > 1024) return null;
      const token = auth.slice(7); const hash = crypto.createHash('sha256').update(token).digest(); let match = null;
      for (const entry of entries) if (crypto.timingSafeEqual(entry.hash, hash)) match = entry.userId;
      return match ? { userId: match, kind: 'service', canApprove: false, canConfigure: false, scopes: ['chat:submit'] } : null;
    },
  };
}
