const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { liveness, createReadiness } = require('../../server/routes/healthRoutes');

function run(handler, locals = {}) {
  return new Promise((resolve) => {
    const res = { headers: {}, statusCode: 200 };
    res.set = (k, v) => { res.headers[k] = v; return res; };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (body) => { res.body = body; resolve(res); return res; };
    handler({ app: { locals } }, res);
  });
}

describe('health endpoints', () => {
  before(() => { process.env.LOG_LEVEL = 'silent'; });
  after(() => { delete process.env.LOG_LEVEL; });

  it('liveness needs no dependencies and is never cached', async () => {
    const res = await run(liveness);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(typeof res.body.uptime, 'number');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  });

  it('readiness is 200 only when every check passes', async () => {
    const readiness = createReadiness();
    const ok = await run(readiness, { readinessChecks: [{ name: 'mongo', check: async () => {} }, { name: 'redis', check: async () => 'PONG' }] });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, { status: 'ready', checks: { mongo: 'ok', redis: 'ok' } });
    assert.equal(ok.headers['Cache-Control'], 'no-store');

    const down = await run(readiness, { readinessChecks: [{ name: 'mongo', check: async () => {} }, { name: 'redis', check: async () => { throw new Error('ECONNREFUSED 10.0.0.5:6379') } }] });
    assert.equal(down.statusCode, 503);
    assert.deepEqual(down.body.checks, { mongo: 'ok', redis: 'failed' });
  });

  it('names the failing check but never says why (details go to the log)', async () => {
    const res = await run(createReadiness(), { readinessChecks: [{ name: 'mongo', check: async () => { throw new Error('auth failed for user admin at 10.1.2.3') } }] });
    assert.ok(!JSON.stringify(res.body).includes('10.1.2.3'));
    assert.ok(!JSON.stringify(res.body).includes('admin'));
  });

  it('treats a hung dependency as failed instead of hanging the probe', async () => {
    const res = await run(createReadiness({ timeoutMs: 30 }), { readinessChecks: [{ name: 'mongo', check: () => new Promise(() => {}) }] });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.checks.mongo, 'failed');
  });

  it('goes 503 as soon as shutdown begins, without running any check', async () => {
    let ran = false;
    const res = await run(createReadiness(), { shuttingDown: true, readinessChecks: [{ name: 'mongo', check: async () => { ran = true; } }] });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.status, 'shutting_down');
    assert.equal(ran, false);
  });

  it('with no checks registered it is ready', async () => {
    assert.equal((await run(createReadiness(), {})).statusCode, 200);
  });
});
