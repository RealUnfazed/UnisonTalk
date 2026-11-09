const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createShutdown, installSignalHandlers } = require('../../server/utils/shutdown');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('graceful shutdown', () => {
  before(() => { process.env.LOG_LEVEL = 'silent'; });
  after(() => { delete process.env.LOG_LEVEL; });

  it('runs the steps in order, then exits 0', async () => {
    const order = [];
    const exits = [];
    const shutdown = createShutdown({
      steps: [
        { name: 'a', run: async () => { await sleep(10); order.push('a'); } },
        { name: 'b', run: () => { order.push('b'); } },
        { name: 'c', run: async () => { order.push('c'); } },
      ],
      exit: (code) => exits.push(code),
    });
    await shutdown('SIGTERM');
    assert.deepEqual(order, ['a', 'b', 'c']);
    assert.deepEqual(exits, [0]);
  });

  it('keeps going when a step fails — one stuck dependency must not block exit — and exits 1', async () => {
    const order = [];
    const exits = [];
    const shutdown = createShutdown({
      steps: [
        { name: 'redis', run: async () => { throw new Error('already closed'); } },
        { name: 'mongo', run: async () => { order.push('mongo'); } },
      ],
      exit: (code) => exits.push(code),
    });
    await shutdown('SIGTERM');
    assert.deepEqual(order, ['mongo']);
    assert.deepEqual(exits, [1]);
  });

  it('ignores a second signal instead of restarting the sequence', async () => {
    let runs = 0;
    const exits = [];
    const shutdown = createShutdown({ steps: [{ name: 'x', run: async () => { runs += 1; await sleep(20); } }], exit: (c) => exits.push(c) });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);
    assert.equal(runs, 1);
    assert.deepEqual(exits, [0]);
  });

  it('forces exit(1) when a step hangs past the deadline', async () => {
    const exits = [];
    const shutdown = createShutdown({ steps: [{ name: 'hang', run: () => new Promise(() => {}) }], timeoutMs: 40, exit: (c) => exits.push(c) });
    shutdown('SIGTERM'); // never resolves, by design
    await sleep(150);
    assert.deepEqual(exits, [1]);
  });

  it('is triggered by SIGTERM and SIGINT', () => {
    const proc = new EventEmitter();
    const received = [];
    installSignalHandlers((signal) => received.push(signal), proc);
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    assert.deepEqual(received, ['SIGTERM', 'SIGINT']);
  });
});
