const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { wrap } = require('../../server/utils/asyncRoutes');

describe('wrap (async route handlers)', () => {
  it('forwards a rejected promise to next() instead of leaving it unhandled', async () => {
    const boom = new Error('db exploded');
    const { handler } = wrap({ handler: async () => { throw boom; } });
    let received;
    handler({}, {}, (err) => { received = err; });
    await new Promise((r) => setImmediate(r));
    assert.equal(received, boom);
  });

  it('does not call next() on success, and passes req/res through', async () => {
    let calledNext = false;
    let seen;
    const { handler } = wrap({ handler: async (req, res) => { seen = [req, res]; } });
    handler('req', 'res', () => { calledNext = true; });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, ['req', 'res']);
    assert.equal(calledNext, false);
  });

  it('leaves non-function exports alone', () => {
    assert.equal(wrap({ CONSTANT: 42 }).CONSTANT, 42);
  });
});
