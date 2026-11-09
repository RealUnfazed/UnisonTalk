const logger = require('../utils/logger');

// Counters live in a "store": in-memory by default (one process), or Redis
// when REDIS_URL is set so limits hold across all instances (server.js calls
// setDefaultStore at startup — limiters look the store up per request, so
// they can be created at import time, before Redis is connected).
//
// A store implements hit(key, windowMs) -> { count, resetAt } (sync or a
// Promise) and refund(key). Keys are namespaced per limiter by `name`;
// give every limiter a STABLE name — instances share counters by key.

class MemoryStore {
  constructor() {
    this.hits = new Map(); // key -> { count, resetAt }
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }, 60_000);
    this.sweeper.unref();
  }

  hit(key, windowMs) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return { count: entry.count, resetAt: entry.resetAt };
  }

  refund(key) {
    const entry = this.hits.get(key);
    if (entry && entry.count > 0) entry.count -= 1;
  }

  reset(prefix = '') {
    for (const k of this.hits.keys()) if (k.startsWith(prefix)) this.hits.delete(k);
  }
}

// Shared counters over a node-redis client. If Redis is unreachable it FAILS
// OPEN onto a local in-memory store: a Redis outage must degrade rate
// limiting to per-instance, not lock everyone out of logging in.
class RedisStore {
  constructor({ client, prefix = 'rl:', fallback = new MemoryStore() }) {
    this.client = client;
    this.prefix = prefix;
    this.fallback = fallback;
    this.lastWarn = 0;
  }

  async hit(key, windowMs) {
    const k = this.prefix + key;
    try {
      const [count, ttl] = await this.client.multi().incr(k).pTTL(k).exec();
      let remaining = Number(ttl);
      if (!(remaining > 0)) {
        // First hit in a window (or a key that somehow lost its expiry):
        // start the window now, so a counter can never become permanent.
        await this.client.pExpire(k, windowMs);
        remaining = windowMs;
      }
      return { count: Number(count), resetAt: Date.now() + remaining };
    } catch (err) {
      this.warn(err);
      return this.fallback.hit(key, windowMs);
    }
  }

  async refund(key) {
    try {
      await this.client.decr(this.prefix + key);
    } catch (err) {
      this.warn(err);
      this.fallback.refund(key);
    }
  }

  warn(err) {
    const now = Date.now();
    if (now - this.lastWarn < 30_000) return; // one line per 30s, not one per request
    this.lastWarn = now;
    logger.warn('[rate-limit] Redis unavailable, using per-instance counters:', err.message);
  }

  reset() {}
}

let defaultStore = null;
const getDefaultStore = () => defaultStore || (defaultStore = new MemoryStore());
const setDefaultStore = (store) => { defaultStore = store; };

let sequence = 0;

function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests, please try again later.', skipSuccessful = false, name, store }) {
  // Unnamed limiters get a creation-order name, which is stable across
  // instances running the same code — but explicit names are better.
  const prefix = `${name || `limiter-${(sequence += 1)}`}:`;

  const middleware = (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return next();

    const activeStore = store || getDefaultStore();
    const k = prefix + String(key(req));

    const proceed = (entry) => {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000));
      res.setHeader('RateLimit-Limit', max);
      res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
      res.setHeader('RateLimit-Reset', retryAfter);

      if (entry.count > max) {
        res.setHeader('Retry-After', retryAfter);
        return res.status(429).json({ error: message });
      }
      if (skipSuccessful) {
        res.on('finish', () => {
          if (res.statusCode < 400) Promise.resolve(activeStore.refund(k)).catch(() => {});
        });
      }
      next();
    };

    // The memory store answers synchronously; Redis returns a Promise.
    const result = activeStore.hit(k, windowMs);
    if (result && typeof result.then === 'function') result.then(proceed, next);
    else proceed(result);
  };

  middleware.reset = () => (store || getDefaultStore()).reset(prefix);
  return middleware;
}

module.exports = rateLimit;
module.exports.MemoryStore = MemoryStore;
module.exports.RedisStore = RedisStore;
module.exports.setDefaultStore = setDefaultStore;
module.exports.getDefaultStore = getDefaultStore;
