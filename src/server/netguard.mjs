import dns from 'node:dns/promises';
import net from 'node:net';

const V4_BLOCKED = [
  [0, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24],
  [0xe0000000, 4], [0xf0000000, 4],
];

function v4Number(ip) {
  return ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function inCidr4(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (v4Number(ip) & mask) === (base & mask);
}

function ipv6Words(ip) {
  let source = String(ip || '').toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(source);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const n = v4Number(dotted[1]);
    source = `${source.slice(0, dotted.index)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = source.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => parseInt(word, 16));
}

function wordsV4(high, low) {
  const n = ((high << 16) | low) >>> 0;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function embeddedV4(ip) {
  const words = ipv6Words(ip);
  if (!words) return null;
  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  if (firstFiveZero && words[5] === 0xffff) return wordsV4(words[6], words[7]);
  // Deprecated IPv4-compatible form (::127.0.0.1) is still accepted by some stacks.
  if (words.slice(0, 6).every((word) => word === 0) && (words[6] !== 0 || words[7] > 1)) {
    return wordsV4(words[6], words[7]);
  }
  // Well-known NAT64 and 6to4 prefixes can otherwise disguise an IPv4 target.
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0)) {
    return wordsV4(words[6], words[7]);
  }
  if (words[0] === 0x2002) return wordsV4(words[1], words[2]);
  return null;
}

export function isLoopbackIp(ip) {
  const s = String(ip || '').toLowerCase();
  const mapped = net.isIPv6(s) ? embeddedV4(s) : null;
  const words = net.isIPv6(s) ? ipv6Words(s) : null;
  const loopback6 = words?.slice(0, 7).every((word) => word === 0) && words?.[7] === 1;
  return Boolean(loopback6) || (net.isIPv4(s) && inCidr4(s, 0x7f000000, 8)) || (mapped ? isLoopbackIp(mapped) : false);
}

export function isBlockedIp(ip, { allowLoopback = false } = {}) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return true;
  const mapped = net.isIPv6(s) ? embeddedV4(s) : null;
  if (mapped) return isBlockedIp(mapped, { allowLoopback });
  if (net.isIPv4(s)) {
    if (allowLoopback && isLoopbackIp(s)) return false;
    return V4_BLOCKED.some(([base, bits]) => inCidr4(s, base, bits));
  }
  if (net.isIPv6(s)) {
    const words = ipv6Words(s);
    if (!words) return true;
    const allZero = words.every((word) => word === 0);
    const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
    if (allowLoopback && loopback) return false;
    const ula = (words[0] & 0xfe00) === 0xfc00;
    const linkLocal = (words[0] & 0xffc0) === 0xfe80;
    const siteLocal = (words[0] & 0xffc0) === 0xfec0;
    const multicast = (words[0] & 0xff00) === 0xff00;
    const localNat64 = words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1;
    const discardOnly = words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0);
    const ietfSpecial = words[0] === 0x2001 && (words[1] & 0xfe00) === 0; // 2001::/23
    const documentation = (words[0] === 0x2001 && words[1] === 0x0db8) ||
      (words[0] === 0x3fff && (words[1] & 0xf000) === 0); // RFC 3849 / RFC 9637
    const retired6bone = words[0] === 0x3ffe;
    const segmentRouting = words[0] === 0x5f00;
    return allZero || loopback || ula || linkLocal || siteLocal || multicast || localNat64 ||
      discardOnly || ietfSpecial || documentation || retired6bone || segmentRouting;
  }
  return true;
}

export async function resolveHost(hostname, { lookup = dns.lookup, allowLoopback = false } = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, reason: '目标缺少主机名' };
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return allowLoopback ? { ok: true, ips: ['127.0.0.1'] } : { ok: false, reason: '本地主机被拒绝' };
  }
  if (host.endsWith('.local') || host.endsWith('.internal')) return { ok: false, reason: '内网主机名被拒绝' };
  let ips;
  if (net.isIP(host)) {
    ips = [host];
  } else {
    try {
      const rows = await lookup(host, { all: true });
      ips = (Array.isArray(rows) ? rows : [rows]).map((row) => row.address).filter(Boolean);
    } catch (err) {
      return { ok: false, reason: `DNS 解析失败：${err.code || err.message}` };
    }
  }
  if (!ips.length) return { ok: false, reason: 'DNS 无解析结果' };
  for (const ip of ips) {
    if (isBlockedIp(ip, { allowLoopback })) return { ok: false, reason: `目标解析到内网/保留地址 ${ip}` };
  }
  return { ok: true, ips: [...new Set(ips)] };
}

/** 将 Node HTTP 的实际连接固定在已经校验过的地址集合中，防止二次 DNS 解析。 */
export function pinnedLookup(ips) {
  const allowed = [...new Set((ips || []).filter((ip) => net.isIP(ip)))];
  return (_hostname, options, callback) => {
    const opts = typeof options === 'object' ? options : { family: Number(options) || 0 };
    const family = Number(opts.family || 0);
    const candidates = family ? allowed.filter((ip) => net.isIP(ip) === family) : allowed;
    if (!candidates.length) {
      const err = new Error('没有符合地址族的已校验目标地址');
      err.code = 'EHOSTUNREACH';
      callback(err);
      return;
    }
    if (opts.all) callback(null, candidates.map((address) => ({ address, family: net.isIP(address) })));
    else callback(null, candidates[0], net.isIP(candidates[0]));
  };
}
