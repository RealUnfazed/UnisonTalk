const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../../server/config/validateEnv');

const STRONG = 'a'.repeat(48);

describe('validateEnv', () => {
  it('requires a session secret', () => {
    assert.equal(validateEnv({}).errors.length, 1);
  });

  it('refuses weak or placeholder secrets in production', () => {
    for (const SESSION_SECRET of ['short', 'replace_this_with_a_long_random_string', `replace_this_${STRONG}`]) {
      assert.equal(validateEnv({ NODE_ENV: 'production', SESSION_SECRET }).errors.length, 1, SESSION_SECRET);
    }
    assert.equal(validateEnv({ NODE_ENV: 'production', SESSION_SECRET: STRONG, TRUST_PROXY: '1', ALLOWED_ORIGIN: 'https://x' }).errors.length, 0);
  });

  it('only warns about the placeholder in development', () => {
    const { errors, warnings } = validateEnv({ SESSION_SECRET: 'replace_this_with_a_long_random_string' });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
  });

  it('warns (not errors) about proxy and origin settings in production', () => {
    const { errors, warnings } = validateEnv({ NODE_ENV: 'production', SESSION_SECRET: STRONG });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 2);
  });
});
