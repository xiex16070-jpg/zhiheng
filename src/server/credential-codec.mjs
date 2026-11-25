import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { withFileLock } from './fsutil.mjs';

// Separate from login-cookie rotation; back up this file with credential stores.
export function createCredentialCodec(directory) {
  const file = path.join(directory, '.credential-key');
  let pending;
  async function master() {
    pending ||= withFileLock(file, async () => {
      await fs.mkdir(directory, { recursive: true });
      try {
        const value = await fs.readFile(file);
        if (value.length !== 32) throw new Error('invalid_credential_key');
        return value;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const value = crypto.randomBytes(32);
        try {
          const handle = await fs.open(file, 'wx', 0o600);
          try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
          return value;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existing = await fs.readFile(file);
          if (existing.length !== 32) throw new Error('invalid_credential_key');
          return existing;
        }
      }
    }).catch(error => { pending = null; throw error; });
    return pending;
  }
  return {
    async seal(value, purpose) {
      if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 450000) throw new Error('credential_too_large');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', await master(), iv);
      cipher.setAAD(Buffer.from(purpose));
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    },
    async open(sealed, purpose) {
      if (!sealed || !['iv', 'tag', 'data'].every(k => typeof sealed[k] === 'string' && sealed[k].length <= 600000)) throw new Error('invalid_credential');
      const iv = Buffer.from(sealed.iv, 'base64'), tag = Buffer.from(sealed.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error('invalid_credential');
      const decipher = crypto.createDecipheriv('aes-256-gcm', await master(), iv);
      decipher.setAAD(Buffer.from(purpose)); decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
