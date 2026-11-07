const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { securityHeaders, CSP } = require('../../server/middleware/securityHeaders');

function headersFor({ env = {}, req = {} } = {}) {
  const keys = ['CSP_MODE', 'NODE_ENV'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  keys.forEach((k) => delete process.env[k]);
  Object.assign(process.env, env);
  try {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    securityHeaders(req, res, () => {});
    return res.headers;
  } finally {
    keys.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  }
}

describe('securityHeaders', () => {
  it('always sets the baseline hardening headers', () => {
    const h = headersFor();
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['X-Frame-Options'], 'DENY');
    assert.equal(h['Referrer-Policy'], 'strict-origin-when-cross-origin');
    assert.match(h['Permissions-Policy'], /camera=\(\)/);
    assert.equal(h['Cross-Origin-Opener-Policy'], 'same-origin');
  });

  it('CSP is report-only by default, enforced on request, and can be off', () => {
    let h = headersFor();
    assert.ok(h['Content-Security-Policy-Report-Only']);
    assert.ok(!h['Content-Security-Policy']);
    h = headersFor({ env: { CSP_MODE: 'enforce' } });
    assert.ok(h['Content-Security-Policy']);
    assert.ok(!h['Content-Security-Policy-Report-Only']);
    h = headersFor({ env: { CSP_MODE: 'off' } });
    assert.ok(!h['Content-Security-Policy'] && !h['Content-Security-Policy-Report-Only']);
  });

  it('the policy forbids inline/eval scripts, framing, plugins and foreign form targets', () => {
    const script = CSP.split('; ').find((d) => d.startsWith('script-src'));
    assert.ok(!script.includes("'unsafe-inline'") && !script.includes("'unsafe-eval'"));
    assert.match(CSP, /frame-ancestors 'none'/);
    assert.match(CSP, /object-src 'none'/);
    assert.match(CSP, /form-action 'self'/);
    assert.match(CSP, /base-uri 'self'/);
  });

  it('sends HSTS only for secure requests in production', () => {
    assert.ok(headersFor({ env: { NODE_ENV: 'production' }, req: { secure: true } })['Strict-Transport-Security']);
    assert.ok(!headersFor({ env: { NODE_ENV: 'production' }, req: { secure: false } })['Strict-Transport-Security']);
    assert.ok(!headersFor({ req: { secure: true } })['Strict-Transport-Security']);
  });
});
