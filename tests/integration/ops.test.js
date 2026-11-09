const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startTestApp } = require('../helpers/testApp');

describe('operations endpoints', () => {
  let ctx;
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });

  it('/healthz answers without sessions or the database', async () => {
    const res = await request(ctx.app).get('/healthz').expect(200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.ok(!res.headers['set-cookie'], 'a probe must not create session rows');
  });

  it('/readyz checks MongoDB for real', async () => {
    const res = await request(ctx.app).get('/readyz').expect(200);
    assert.equal(res.body.status, 'ready');
    assert.equal(res.body.checks.mongo, 'ok');
  });

  it('/readyz goes 503 once shutdown begins, so the load balancer drains the instance', async () => {
    ctx.app.locals.shuttingDown = true;
    try {
      const res = await request(ctx.app).get('/readyz').expect(503);
      assert.equal(res.body.status, 'shutting_down');
      await request(ctx.app).get('/healthz').expect(200); // still alive, just not accepting traffic
    } finally {
      ctx.app.locals.shuttingDown = false;
    }
  });

  it('/readyz reports a failing dependency without leaking why', async () => {
    ctx.app.locals.readinessChecks.push({ name: 'redis', check: async () => { throw new Error('connect ECONNREFUSED 10.9.8.7:6379'); } });
    try {
      const res = await request(ctx.app).get('/readyz').expect(503);
      assert.equal(res.body.checks.redis, 'failed');
      assert.equal(res.body.checks.mongo, 'ok');
      assert.ok(!JSON.stringify(res.body).includes('10.9.8.7'));
    } finally {
      ctx.app.locals.readinessChecks.pop();
    }
  });

  it('every API response carries a request id; a sane upstream id is kept, a malformed one replaced', async () => {
    const plain = await request(ctx.app).get('/api/auth/me');
    assert.match(plain.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    const kept = await request(ctx.app).get('/api/auth/me').set('X-Request-Id', 'trace-abc12345');
    assert.equal(kept.headers['x-request-id'], 'trace-abc12345');
    const replaced = await request(ctx.app).get('/api/auth/me').set('X-Request-Id', 'not a valid id');
    assert.notEqual(replaced.headers['x-request-id'], 'not a valid id');
  });
});
