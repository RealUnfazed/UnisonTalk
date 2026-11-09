const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const rateLimit = require('../../server/middleware/rateLimit');
const { MemoryStore, RedisStore } = rateLimit;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeRes() {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
// Runs the middleware and resolves with { passed, res, error } once it settles.
const call = (mw, req = { ip: '1.1.1.1' }) =>
  new Promise((resolve) => {
    const res = fakeRes();
    let settled = false;
    const done = (extra) => { if (!settled) { settled = true; resolve({ res, ...extra }); } };
    const json = res.json;
    res.json = (body) => { json(body); done({ passed: false }); return res; }; // a 429 answers instead of calling next()
    mw(req, res, (err) => done({ passed: !err, error: err }));
    setTimeout(() => done({ passed: false, timedOut: true }), 500).unref(); // safety net only
  });

// A scriptable stand-in for a node-redis client.
function fakeRedis({ failing = false } = {}) {
  const data = new Map();
  const calls = { pExpire: [], decr: [] };
  return {
    data, calls,
    failing,
    multi() {
      const ops = [];
      const chain = {
        incr(k) { ops.push(() => { if (this.failing) throw new Error('ECONNREFUSED'); const n = (data.get(k)?.count ?? 0) + 1; data.set(k, { count: n, ttl: data.get(k)?.ttl ?? -1 }); return n; }); return chain; },
        pTTL(k) { ops.push(() => data.get(k)?.ttl ?? -2); return chain; },
        async exec() { return ops.map((op) => op()); },
      };
      chain.incr = chain.incr.bind(this);
      return chain;
    },
    async pExpire(k, ms) { calls.pExpire.push([k, ms]); data.get(k).ttl = ms; },
    async decr(k) { if (this.failing) throw new Error('down'); calls.decr.push(k); const e = data.get(k); if (e) e.count -= 1; },
  };
}

describe('rate-limit stores', () => {
  before(() => { process.env.LOG_LEVEL = 'silent'; delete process.env.RATE_LIMIT_DISABLED; });
  after(() => { delete process.env.LOG_LEVEL; });

  describe('MemoryStore', () => {
    it('counts, expires windows, refunds, and resets by prefix', async () => {
      const store = new MemoryStore();
      assert.equal(store.hit('a:1', 40).count, 1);
      assert.equal(store.hit('a:1', 40).count, 2);
      store.refund('a:1');
      assert.equal(store.hit('a:1', 40).count, 2);
      store.hit('b:1', 40);
      store.reset('a:');
      assert.equal(store.hit('a:1', 40).count, 1, 'reset(prefix) clears that prefix');
      assert.equal(store.hit('b:1', 40).count, 2, '...and only that prefix');
      await sleep(60);
      assert.equal(store.hit('b:1', 40).count, 1, 'a new window starts after windowMs');
    });
  });

  describe('sharing counters between instances', () => {
    it('two limiters with the SAME name and store share one budget — different names do not', async () => {
      const store = new MemoryStore();
      const instanceA = rateLimit({ name: 'login', windowMs: 60_000, max: 2, store });
      const instanceB = rateLimit({ name: 'login', windowMs: 60_000, max: 2, store }); // "another server"
      const other = rateLimit({ name: 'search', windowMs: 60_000, max: 2, store });

      assert.ok((await call(instanceA)).passed);
      assert.ok((await call(instanceB)).passed);
      assert.equal((await call(instanceA)).res.statusCode, 429, 'the third request is blocked no matter which instance gets it');
      assert.ok((await call(other)).passed, 'a differently named limiter has its own budget');
    });
  });

  describe('async stores', () => {
    it('waits for the store, then lets the request through or answers 429', async () => {
      const slow = { hit: async (key) => { await sleep(5); return { count: key.endsWith('over') ? 99 : 1, resetAt: Date.now() + 1000 }; }, refund: async () => {}, reset() {} };
      const mw = rateLimit({ name: 'slow', windowMs: 1000, max: 5, store: slow, key: (r) => r.k });
      assert.ok((await call(mw, { k: 'fine' })).passed);
      const blocked = await call(mw, { k: 'over' });
      assert.equal(blocked.res.statusCode, 429);
      assert.ok(blocked.res.headers['Retry-After']);
    });

    it('hands a store failure to next(err) rather than hanging', async () => {
      const broken = { hit: () => Promise.reject(new Error('store exploded')), refund() {}, reset() {} };
      const result = await call(rateLimit({ name: 'broken', windowMs: 1000, max: 5, store: broken }));
      assert.equal(result.error.message, 'store exploded');
    });
  });

  describe('RedisStore', () => {
    it('starts a window on the first hit (so a counter can never become permanent) and not again', async () => {
      const client = fakeRedis();
      const store = new RedisStore({ client, prefix: 'rl:' });
      const first = await store.hit('login:1.2.3.4', 15_000);
      assert.equal(first.count, 1);
      assert.deepEqual(client.calls.pExpire, [['rl:login:1.2.3.4', 15_000]]);
      assert.ok(first.resetAt > Date.now() && first.resetAt <= Date.now() + 15_000);

      const second = await store.hit('login:1.2.3.4', 15_000);
      assert.equal(second.count, 2);
      assert.equal(client.calls.pExpire.length, 1, 'the window is NOT restarted by later hits');
    });

    it('repairs a key that lost its expiry', async () => {
      const client = fakeRedis();
      client.data.set('rl:x', { count: 5, ttl: -1 });
      await new RedisStore({ client }).hit('x', 1000);
      assert.deepEqual(client.calls.pExpire, [['rl:x', 1000]]);
    });

    it('refunds by decrementing', async () => {
      const client = fakeRedis();
      const store = new RedisStore({ client });
      await store.hit('k', 1000);
      await store.refund('k');
      assert.deepEqual(client.calls.decr, ['rl:k']);
    });

    it('FAILS OPEN to per-instance counters when Redis is down — never locking everyone out', async () => {
      const client = fakeRedis({ failing: true });
      const store = new RedisStore({ client });
      const a = await store.hit('login:ip', 1000);
      const b = await store.hit('login:ip', 1000);
      assert.deepEqual([a.count, b.count], [1, 2], 'still limits, locally');
      await store.refund('login:ip'); // must not throw either
    });
  });

  describe('default store', () => {
    it('is looked up per request, so limiters made at import time pick up Redis later', async () => {
      const early = rateLimit({ name: 'early', windowMs: 1000, max: 1 }); // created BEFORE the store is swapped in
      const original = rateLimit.getDefaultStore();
      const fake = { hits: [], hit(k) { this.hits.push(k); return { count: 1, resetAt: Date.now() + 1000 }; }, refund() {}, reset() {} };
      rateLimit.setDefaultStore(fake);
      try {
        await call(early);
        assert.deepEqual(fake.hits, ['early:1.1.1.1']);
      } finally {
        rateLimit.setDefaultStore(original);
      }
    });
  });
});
