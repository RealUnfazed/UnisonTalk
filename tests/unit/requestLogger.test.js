const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLogger } = require('../../server/utils/logger');
const { createRequestLogger } = require('../../server/middleware/requestLogger');

function run({ headers = {}, url = '/api/chats', status = 200, session } = {}) {
  const lines = [];
  const logger = createLogger({ format: 'json', level: 'debug', write: (level, line) => lines.push({ level, ...JSON.parse(line) }) });
  const req = { originalUrl: url, method: 'GET', ip: '203.0.113.9', session, get: (h) => headers[h.toLowerCase()] };
  const res = new EventEmitter();
  res.headers = {};
  res.statusCode = status;
  res.setHeader = (k, v) => { res.headers[k] = v; };
  let nexted = false;
  createRequestLogger(logger)(req, res, () => { nexted = true; });
  res.emit('finish');
  return { req, res, lines, nexted };
}

describe('requestLogger', () => {
  it('gives every request an id, echoes it in X-Request-Id, and continues', () => {
    const { req, res, nexted } = run();
    assert.match(req.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.headers['X-Request-Id'], req.id);
    assert.ok(nexted);
  });

  it('keeps a sane upstream id so one id can follow a request through the proxy', () => {
    assert.equal(run({ headers: { 'x-request-id': 'trace-abc12345' } }).req.id, 'trace-abc12345');
  });

  it('replaces hostile or malformed upstream ids instead of echoing them', () => {
    for (const bad of ['short', 'has spaces in it', 'x'.repeat(65), 'evil\r\nSet-Cookie: a=b', '<script>alert(1)</script>']) {
      const { req, res } = run({ headers: { 'x-request-id': bad } });
      assert.notEqual(req.id, bad);
      assert.match(res.headers['X-Request-Id'], /^[0-9a-f-]{36}$/);
    }
  });

  it('logs method, path, status, duration, user and ip — with the request id', () => {
    const { lines, req } = run({ url: '/api/chats', status: 200, session: { userId: 'u1' } });
    const entry = lines[0];
    assert.equal(entry.msg, 'request');
    assert.deepEqual(
      [entry.method, entry.path, entry.status, entry.userId, entry.ip, entry.requestId],
      ['GET', '/api/chats', 200, 'u1', '203.0.113.9', req.id]
    );
    assert.equal(typeof entry.ms, 'number');
  });

  it('NEVER logs the query string (SSO callbacks carry codes there)', () => {
    const { lines } = run({ url: '/api/auth/sso/phasetime/callback?code=SUPERSECRET&state=ALSOSECRET' });
    assert.equal(lines[0].path, '/api/auth/sso/phasetime/callback');
    assert.ok(!JSON.stringify(lines[0]).includes('SUPERSECRET'));
    assert.ok(!JSON.stringify(lines[0]).includes('ALSOSECRET'));
  });

  it('picks the level from the status: info, warn, error', () => {
    assert.equal(run({ status: 200 }).lines[0].level, 'info');
    assert.equal(run({ status: 302 }).lines[0].level, 'info');
    assert.equal(run({ status: 404 }).lines[0].level, 'warn');
    assert.equal(run({ status: 429 }).lines[0].level, 'warn');
    assert.equal(run({ status: 500 }).lines[0].level, 'error');
  });
});
