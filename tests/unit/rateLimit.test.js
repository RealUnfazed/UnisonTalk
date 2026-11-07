const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const rateLimit = require('../../server/middleware/rateLimit');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function call(mw, req = { ip: '1.1.1.1' }) {
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = 200;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  let passed = false;
  mw(req, res, () => { passed = true; });
  return { res, passed };
}

describe('rateLimit middleware', () => {
  beforeEach(() => { delete process.env.RATE_LIMIT_DISABLED; });

  it('allows up to `max`, then answers 429 with Retry-After', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3, message: 'slow down' });
    for (let i = 0; i < 3; i += 1) assert.equal(call(mw).passed, true);
    const blocked = call(mw);
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 429);
    assert.deepEqual(blocked.res.body, { error: 'slow down' });
    assert.ok(Number(blocked.res.headers['Retry-After']) >= 1);
    assert.equal(blocked.res.headers['RateLimit-Remaining'], 0);
  });

  it('counts each key separately', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1, key: (req) => req.k });
    assert.equal(call(mw, { k: 'a' }).passed, true);
    assert.equal(call(mw, { k: 'b' }).passed, true);
    assert.equal(call(mw, { k: 'a' }).passed, false);
  });

  it('starts a fresh window after windowMs', async () => {
    const mw = rateLimit({ windowMs: 30, max: 1 });
    assert.equal(call(mw).passed, true);
    assert.equal(call(mw).passed, false);
    await sleep(50);
    assert.equal(call(mw).passed, true);
  });

  it('skipSuccessful: good requests are refunded, failed ones still count', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 2, skipSuccessful: true });
    for (let i = 0; i < 6; i += 1) {
      const { res, passed } = call(mw);
      assert.equal(passed, true, `success #${i} must never be limited`);
      res.statusCode = 200;
      res.emit('finish');
    }
    const outcomes = [];
    for (let i = 0; i < 3; i += 1) {
      const { res, passed } = call(mw);
      outcomes.push(passed);
      if (passed) { res.statusCode = 401; res.emit('finish'); }
    }
    assert.deepEqual(outcomes, [true, true, false]);
  });

  it('can be switched off (used by the test suite)', () => {
    process.env.RATE_LIMIT_DISABLED = 'true';
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    for (let i = 0; i < 20; i += 1) assert.equal(call(mw).passed, true);
  });

  it('reset() clears all counters', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    call(mw);
    assert.equal(call(mw).passed, false);
    mw.reset();
    assert.equal(call(mw).passed, true);
  });
});
