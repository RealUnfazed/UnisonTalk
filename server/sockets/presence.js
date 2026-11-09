// Delays "went offline" by a short grace period. Two reasons:
//   1. A page refresh or a flaky connection drops and re-opens a socket in
//      a moment; without a grace period everyone would see the person
//      flicker offline/online.
//   2. With several server instances, "was that their last connection?" can
//      only be answered by recounting AFTER the dust settles — see
//      sockets/index.js, which recounts across the whole cluster.
function createPresenceTracker({ graceMs }) {
  const pending = new Map(); // userId -> { timer, run }

  const cancel = (userId) => {
    const entry = pending.get(userId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(userId);
  };

  return {
    // `run` is called once after graceMs unless cancelled (the user came back).
    scheduleOffline(userId, run) {
      cancel(userId);
      const timer = setTimeout(() => {
        pending.delete(userId);
        Promise.resolve(run()).catch(() => {});
      }, graceMs);
      timer.unref();
      pending.set(userId, { timer, run });
    },
    cancel,
    // Run everything still waiting, now — used at shutdown so nobody is
    // left marked online by a timer that will never fire.
    async flush() {
      const entries = [...pending.entries()];
      pending.clear();
      await Promise.allSettled(entries.map(([, { timer, run }]) => { clearTimeout(timer); return run(); }));
    },
    get size() {
      return pending.size;
    },
  };
}

module.exports = { createPresenceTracker };
