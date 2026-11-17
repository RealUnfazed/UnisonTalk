const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnv } = require('../../server/config/validateEnv');

const base = { SESSION_SECRET: 'a'.repeat(48) };

describe('validateEnv — storage', () => {
  it('local is the default and needs nothing', () => {
    assert.deepEqual(validateEnv(base).errors, []);
    assert.deepEqual(validateEnv({ ...base, STORAGE_DRIVER: 'local' }).errors, []);
  });

  it('refuses an unknown driver', () => {
    assert.equal(validateEnv({ ...base, STORAGE_DRIVER: 'ftp' }).errors.length, 1);
  });

  it('s3 needs a bucket, and credentials are all-or-nothing', () => {
    assert.equal(validateEnv({ ...base, STORAGE_DRIVER: 's3' }).errors.length, 1);
    assert.deepEqual(validateEnv({ ...base, STORAGE_DRIVER: 'S3', S3_BUCKET: 'b' }).errors, []);
    assert.equal(validateEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'AKIA' }).errors.length, 1);
    assert.equal(validateEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_SECRET_ACCESS_KEY: 's' }).errors.length, 1);
    assert.deepEqual(validateEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 's' }).errors, []);
  });

  it('warns about an unrecognised S3_SSE value but still boots', () => {
    const { errors, warnings } = validateEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_SSE: 'rot13' });
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 1);
    assert.equal(validateEnv({ ...base, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_SSE: 'aws:kms' }).warnings.length, 0);
  });
});
