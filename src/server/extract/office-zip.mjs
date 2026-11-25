import zlib from 'node:zlib';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Bounded, in-memory Office ZIP reader. No member is ever extracted to disk. */
export function readOfficeZip(bytes, { maxBytes = 64 * 1024 * 1024, maxEntries = 2048, signal } = {}) {
  signal?.throwIfAborted();
  if (!Buffer.isBuffer(bytes) || bytes.length > 25 * 1024 * 1024) throw new Error('office_zip_size');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('office_invalid_zip');
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  const centralEnd = offset + bytes.readUInt32LE(end + 12);
  if (!count || count > maxEntries || centralEnd !== end || bytes.readUInt16LE(end + 8) !== count) throw new Error('office_zip_directory');
  const members = new Map(); let total = 0;
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    if (offset + 46 > centralEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('office_invalid_zip');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const crc = bytes.readUInt32LE(offset + 16), compressed = bytes.readUInt32LE(offset + 20), plain = bytes.readUInt32LE(offset + 24);
    const nameLen = bytes.readUInt16LE(offset + 28), extraLen = bytes.readUInt16LE(offset + 30), commentLen = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42), next = offset + 46 + nameLen + extraLen + commentLen;
    if (next > centralEnd) throw new Error('office_invalid_zip');
    const name = bytes.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset = next;
    if (!name || name.length > 512 || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(s => s === '..' || s === '.') || members.has(name)) throw new Error('office_unsafe_zip_path');
    total += plain;
    if (flags & 1 || ![0, 8].includes(method) || plain > 16 * 1024 * 1024 || total > maxBytes || compressed > bytes.length) throw new Error('office_zip_budget');
    if (local + 30 > centralEnd || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw new Error('office_invalid_zip_member');
    const localNameLen = bytes.readUInt16LE(local + 26), localExtraLen = bytes.readUInt16LE(local + 28);
    const start = local + 30 + localNameLen + localExtraLen;
    if (start + compressed > centralEnd || bytes.subarray(local + 30, local + 30 + localNameLen).toString('utf8') !== name) throw new Error('office_invalid_zip_member');
    const raw = bytes.subarray(start, start + compressed);
    const value = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(16 * 1024 * 1024, maxBytes - total + plain)) });
    if (value.length !== plain || crc32(value) !== crc) throw new Error('office_corrupt_zip_member');
    if (/\.(xml|rels)$/i.test(name) && /<!\s*(DOCTYPE|ENTITY)/i.test(value.toString('utf8'))) throw new Error('office_xml_entity');
    members.set(name, value);
  }
  if (offset !== centralEnd) throw new Error('office_invalid_zip_directory');
  return members;
}

export function xmlText(value = '') {
  return String(value).replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (all, hex, dec, named) => {
    if (named) return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[named.toLowerCase()];
    const n = parseInt(hex || dec, hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
  });
}

export function xmlAttribute(tag, name) {
  const match = new RegExp('(?:^|\\s)' + name + '=["\\\']([^"\\\']*)["\\\']').exec(tag);
  return match ? xmlText(match[1]) : '';
}
