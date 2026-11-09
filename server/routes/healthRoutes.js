const logger = require('../utils/logger');

// Liveness: "is the process up?" — no dependencies, so an orchestrator only
// restarts the container when it is truly wedged, not when Mongo blips.
function liveness(_req, res) {
  res.set('Cache-Control', 'no-store').json({ status: 'ok', uptime: Math.round(process.uptime()) });
}

// The timer is cleared as soon as the check settles, so a fast probe leaves nothing
// behind (and it must not be unref'd: it's what keeps a hung check's race alive).
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Readiness: "should the load balancer send traffic here?" Runs every
// registered check (Mongo, Redis...) and goes 503 during shutdown so the LB
// drains this instance first. Responses name which check failed but never
// say why — details go to the log, not to whoever hits the endpoint.
function createReadiness({ timeoutMs = 2000 } = {}) {
  return async function readiness(req, res) {
    res.set('Cache-Control', 'no-store');
    const { shuttingDown, readinessChecks = [] } = req.app.locals;
    if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });

    const results = await Promise.all(
      readinessChecks.map(async ({ name, check }) => {
        try {
          await withTimeout(check(), timeoutMs);
          return [name, 'ok'];
        } catch (err) {
          logger.warn(`[health] readiness check "${name}" failed:`, err.message);
          return [name, 'failed'];
        }
      })
    );
    const ready = results.every(([, state]) => state === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable', checks: Object.fromEntries(results) });
  };
}

function createHealthRouter() {
  const express = require('express'); // loaded here so the handlers above stay testable without it
  const router = express.Router();
  router.get('/healthz', liveness);
  router.get('/readyz', createReadiness());
  return router;
}

module.exports = { createHealthRouter, createReadiness, liveness };
