const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { connectRedis, attachAdapter } = require('../../server/config/scale');

function fakeRedisLib({ quitFails = false } = {}) {
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(url) { super(); this.url = url; this.connected = false; this.quitCalls = 0; clients.push(this); }
    duplicate() { return new FakeClient(this.url); }
    async connect() { this.connected = true; }
    async ping() { return 'PONG'; }
    async quit() { this.quitCalls += 1; if (quitFails && clients[0] === this) throw new Error('already closed'); }
  }
  return { lib: { createClient: ({ url }) => new FakeClient(url) }, clients };
}

describe('scale (Redis) configuration', () => {
  before(() => { process.env.LOG_LEVEL = 'silent'; });
  after(() => { delete process.env.LOG_LEVEL; });

  describe('connectRedis', () => {
    it('does nothing — and never even loads the redis package — without REDIS_URL', async () => {
      const deps = { get redis() { throw new Error('redis must not be loaded'); } };
      assert.equal(await connectRedis({}, deps), null);
      assert.equal(await connectRedis({ REDIS_URL: '' }, deps), null);
    });

    it('opens a pub/sub pair on the given URL, connected', async () => {
      const { lib, clients } = fakeRedisLib();
      const redis = await connectRedis({ REDIS_URL: 'rediss://cache.example:6380' }, { redis: lib });
      assert.equal(clients.length, 2);
      assert.ok(clients.every((c) => c.connected && c.url === 'rediss://cache.example:6380'));
      assert.equal(redis.pub, clients[0]);
      assert.equal(redis.sub, clients[1]);
      assert.equal(await redis.ping(), 'PONG');
    });

    it('attaches error listeners, so a Redis hiccup is logged instead of crashing the process', async () => {
      const { lib, clients } = fakeRedisLib();
      await connectRedis({ REDIS_URL: 'redis://x' }, { redis: lib });
      for (const client of clients) assert.doesNotThrow(() => client.emit('error', new Error('ECONNRESET')));
    });

    it('closes both clients even if one refuses', async () => {
      const { lib, clients } = fakeRedisLib({ quitFails: true });
      const redis = await connectRedis({ REDIS_URL: 'redis://x' }, { redis: lib });
      await assert.doesNotReject(redis.close());
      assert.deepEqual(clients.map((c) => c.quitCalls), [1, 1]);
    });
  });

  describe('attachAdapter', () => {
    it('leaves Socket.IO in-process when there is no Redis', () => {
      const io = { adapter() { throw new Error('should not be called'); } };
      assert.equal(attachAdapter(io, null, { get adapter() { throw new Error('should not load'); } }), false);
    });

    it('installs the Redis adapter built from the pub/sub pair', () => {
      const installed = [];
      const io = { adapter: (a) => installed.push(a) };
      const redis = { pub: { id: 'pub' }, sub: { id: 'sub' } };
      const deps = { adapter: { createAdapter: (pub, sub) => ({ built: [pub.id, sub.id] }) } };
      assert.equal(attachAdapter(io, redis, deps), true);
      assert.deepEqual(installed, [{ built: ['pub', 'sub'] }]);
    });
  });
});
