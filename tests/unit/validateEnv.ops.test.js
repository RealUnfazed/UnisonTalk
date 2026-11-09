const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../../server/config/validateEnv');

const base = { SESSION_SECRET: 'a'.repeat(48) };

describe('validateEnv — operations settings', () => {
  it('accepts redis:// and rediss:// URLs, and no URL at all', () => {
    for (const REDIS_URL of ['redis://localhost:6379', 'rediss://user:pw@cache.example:6380/0', undefined]) {
      assert.deepEqual(validateEnv({ ...base, REDIS_URL }).errors, []);
    }
  });

  it('refuses a REDIS_URL that is not a Redis URL (fail at boot, not on first request)', () => {
    for (const REDIS_URL of ['localhost:6379', 'http://redis', 'redis']) {
      assert.equal(validateEnv({ ...base, REDIS_URL }).errors.length, 1, REDIS_URL);
    }
  });

  it('warns about an unknown LOG_LEVEL but still boots', () => {
    const { errors, warnings } = validateEnv({ ...base, LOG_LEVEL: 'verbose' });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(validateEnv({ ...base, LOG_LEVEL: 'warn' }).warnings.length, 0);
  });
});
