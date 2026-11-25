/**
 * 缓存层：Redis 为主，不可用时降级为进程内缓存。
 * 承担：会话上下文、限流、任务事件流、分布式锁、指标计数。
 */

import { config } from './config.mjs';

// 驱动可选：缺失时直接走进程内缓存
let Redis = null;
try {
  Redis = (await import('ioredis')).default;
} catch {
  Redis = null;
}

let client = null;
let ready = false;
let lastError = Redis ? '' : 'driver_missing';
const prefix = config.redis.keyPrefix;

export function redisStatus() {
  return { ready, error: lastError, host: config.redis.host, port: config.redis.port, prefix };
}

class MemoryCache {
  constructor() {
    this.map = new Map();
  }
  #alive(entry) {
    return entry && (entry.expireAt === 0 || entry.expireAt > Date.now());
  }
  async get(key) {
    const e = this.map.get(key);
    if (!this.#alive(e)) {
      this.map.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key, value, ttlSec = 0) {
    this.map.set(key, { value, expireAt: ttlSec ? Date.now() + ttlSec * 1000 : 0 });
  }
  async del(key) {
    this.map.delete(key);
  }
  async incr(key, ttlSec = 60) {
    const cur = Number((await this.get(key)) || 0) + 1;
    await this.set(key, cur, ttlSec);
    return cur;
  }
  async rpush(key, value, ttlSec = 3600) {
    const list = (await this.get(key)) || [];
    list.push(value);
    await this.set(key, list, ttlSec);
    return list.length;
  }
  async lrange(key, start = 0, end = -1) {
    const list = (await this.get(key)) || [];
    return end === -1 ? list.slice(start) : list.slice(start, end + 1);
  }
  async acquireLock(key, ttlMs = 30000) {
    const cur = await this.get(key);
    if (cur) return false;
    await this.set(key, '1', Math.ceil(ttlMs / 1000));
    return true;
  }
  async releaseLock(key) {
    this.map.delete(key);
  }
  async hincrby(key, field, by = 1) {
    const h = (await this.get(key)) || {};
    h[field] = (h[field] || 0) + by;
    await this.set(key, h, 0);
    return h[field];
  }
  async hgetall(key) {
    return (await this.get(key)) || {};
  }
}

const memory = new MemoryCache();

export async function initRedis() {
  if (!config.redis.enabled) {
    lastError = 'disabled';
    return null;
  }
  if (!Redis) {
    lastError = 'driver_missing';
    console.warn('[redis] 未安装 ioredis，使用进程内缓存');
    return null;
  }
  return new Promise((resolve) => {
    const c = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 3000,
    });
    c.on('error', (err) => {
      lastError = String(err.message || err);
    });
    c.connect()
      .then(async () => {
        await c.ping();
        client = c;
        ready = true;
        lastError = '';
        resolve(client);
      })
      .catch((err) => {
        lastError = String(err.message || err);
        ready = false;
        client = null;
        console.warn(`[redis] 不可用，切换到进程内缓存：${lastError}`);
        resolve(null);
      });
  });
}

const k = (key) => `${prefix}${key}`;

export const cache = {
  get engine() {
    return ready ? 'redis' : 'memory';
  },

  async get(key) {
    if (!ready) return memory.get(k(key));
    const raw = await client.get(k(key));
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  },

  async set(key, value, ttlSec = 0) {
    if (!ready) return memory.set(k(key), value, ttlSec);
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSec) await client.set(k(key), raw, 'EX', ttlSec);
    else await client.set(k(key), raw);
  },

  async del(key) {
    if (!ready) return memory.del(k(key));
    await client.del(k(key));
  },

  async incr(key, ttlSec = 60) {
    if (!ready) return memory.incr(k(key), ttlSec);
    const n = await client.incr(k(key));
    if (n === 1) await client.expire(k(key), ttlSec);
    return n;
  },

  async rpush(key, value, ttlSec = 3600) {
    if (!ready) return memory.rpush(k(key), value, ttlSec);
    const n = await client.rpush(k(key), JSON.stringify(value));
    await client.expire(k(key), ttlSec);
    return n;
  },

  async lrange(key, start = 0, end = -1) {
    if (!ready) return memory.lrange(k(key), start, end);
    const list = await client.lrange(k(key), start, end);
    return list.map((s) => {
      try {
        return JSON.parse(s);
      } catch {
        return s;
      }
    });
  },

  async acquireLock(key, ttlMs = 30000) {
    if (!ready) return memory.acquireLock(k(key), ttlMs);
    const ok = await client.set(k(key), '1', 'PX', ttlMs, 'NX');
    return ok === 'OK';
  },

  async releaseLock(key) {
    if (!ready) return memory.releaseLock(k(key));
    await client.del(k(key));
  },

  async hincrby(key, field, by = 1) {
    if (!ready) return memory.hincrby(k(key), field, by);
    return client.hincrby(k(key), field, by);
  },

  async hgetall(key) {
    if (!ready) return memory.hgetall(k(key));
    return client.hgetall(k(key));
  },

  async close() {
    if (client) await client.quit();
  },
};
