const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createPresenceTracker } = require('../../server/sockets/presence');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('presence tracker (grace period before "offline")', () => {
  it('fires after the grace period', async () => {
    const tracker = createPresenceTracker({ graceMs: 25 });
    let fired = 0;
    tracker.scheduleOffline('u1', () => { fired += 1; });
    assert.equal(fired, 0);
    assert.equal(tracker.size, 1);
    await sleep(60);
    assert.equal(fired, 1);
    assert.equal(tracker.size, 0);
  });

  it('is cancelled when the user comes back (a refresh is not "offline")', async () => {
    const tracker = createPresenceTracker({ graceMs: 25 });
    let fired = 0;
    tracker.scheduleOffline('u1', () => { fired += 1; });
    tracker.cancel('u1');
    await sleep(60);
    assert.equal(fired, 0);
  });

  it('rescheduling replaces the pending timer — only the latest runs, once', async () => {
    const tracker = createPresenceTracker({ graceMs: 25 });
    const ran = [];
    tracker.scheduleOffline('u1', () => ran.push('first'));
    tracker.scheduleOffline('u1', () => ran.push('second'));
    await sleep(60);
    assert.deepEqual(ran, ['second']);
  });

  it('tracks users independently', async () => {
    const tracker = createPresenceTracker({ graceMs: 25 });
    const ran = [];
    tracker.scheduleOffline('a', () => ran.push('a'));
    tracker.scheduleOffline('b', () => ran.push('b'));
    tracker.cancel('a');
    await sleep(60);
    assert.deepEqual(ran, ['b']);
  });

  it('flush() runs everything pending immediately (used at shutdown) and clears it', async () => {
    const tracker = createPresenceTracker({ graceMs: 10_000 });
    const ran = [];
    tracker.scheduleOffline('a', async () => { await sleep(5); ran.push('a'); });
    tracker.scheduleOffline('b', () => ran.push('b'));
    await tracker.flush();
    assert.deepEqual(ran.sort(), ['a', 'b']);
    assert.equal(tracker.size, 0);
  });

  it('swallows a failing callback rather than crashing the process', async () => {
    const tracker = createPresenceTracker({ graceMs: 10 });
    tracker.scheduleOffline('u1', async () => { throw new Error('db down'); });
    await sleep(40); // an unhandled rejection here would fail the run
    await assert.doesNotReject(tracker.flush());
  });
});
