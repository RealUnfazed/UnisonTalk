// A small, dependency-free, in-memory rate limiter. Per-process only — fine
// for a single server; behind several instances (or to survive restarts)
// swap in express-rate-limit with a Redis store. Counts are keyed by
// whatever `key(req)` returns (default: client IP — which is only the real
// client IP if TRUST_PROXY is set correctly behind a proxy, see app.js).
function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'Too many requests, please try again later.', skipSuccessful = false }) {
  const hits = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  sweep.unref();

  const middleware = (req, res, next) => {
    if (process.env.RATE_LIMIT_DISABLED === 'true') return next();

    const now = Date.now();
    const k = String(key(req));
    let entry = hits.get(k);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;

    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - entry.count));
    res.setHeader('RateLimit-Reset', retryAfter);

    if (entry.count > max) {
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({ error: message });
    }
    if (skipSuccessful) {
      res.on('finish', () => {
        if (res.statusCode < 400 && entry.count > 0) entry.count -= 1;
      });
    }
    next();
  };

  middleware.reset = () => hits.clear();
  return middleware;
}

module.exports = rateLimit;
