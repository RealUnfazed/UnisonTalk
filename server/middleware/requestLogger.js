const crypto = require('node:crypto');
const logger = require('../utils/logger');

// Accepts an upstream proxy's X-Request-Id (so one ID follows a request
// through nginx -> app) but only if it's a sane token: it ends up in logs
// and response headers, so anything else is replaced, never echoed.
const ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

function createRequestLogger(baseLogger) {
  return function requestLogger(req, res, next) {
    const incoming = req.get('x-request-id');
    req.id = incoming && ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    req.log = baseLogger.child({ requestId: req.id });

    // Path only — never the query string: the SSO callback carries `code` and
    // `state` there, and other URLs could carry anything.
    const path = req.originalUrl.split('?')[0];
    const started = process.hrtime.bigint();

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      req.log[level]('request', {
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(ms),
        userId: req.session && req.session.userId,
        ip: req.ip,
      });
    });
    next();
  };
}

module.exports = { requestLogger: createRequestLogger(logger), createRequestLogger, ID_RE };
