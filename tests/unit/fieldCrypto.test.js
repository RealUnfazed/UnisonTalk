const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const newKey = () => crypto.randomBytes(32).toString('hex');
const { encryptField, decryptField, assertEncryptionKeyConfigured } = require('../../server/utils/fieldCrypto');

describe('Cloud Chat encryption at rest (server/utils/fieldCrypto.js)', () => {
  beforeEach(() => {
    process.env.CLOUD_ENCRYPTION_KEY = newKey();
  });

  it('round-trips text, including unicode', () => {
    for (const text of ['hello', 'سلام 👋', 'a'.repeat(4000)]) {
      const { ciphertext, iv } = encryptField(text);
      assert.equal(decryptField(ciphertext, iv), text);
    }
  });

  it('stores nothing recognisable and uses a fresh IV every time', () => {
    const a = encryptField('database dump test');
    const b = encryptField('database dump test');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.ok(!Buffer.from(a.ciphertext, 'base64').toString('latin1').includes('dump'));
  });

  it('treats empty / nullish input as "nothing stored"', () => {
    assert.deepEqual(encryptField(''), { ciphertext: null, iv: null });
    assert.deepEqual(encryptField(null), { ciphertext: null, iv: null });
    assert.deepEqual(encryptField(undefined), { ciphertext: null, iv: null });
    assert.equal(decryptField(null, null), null);
    assert.equal(decryptField('x', null), null);
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const { ciphertext, iv } = encryptField('untouched');
    const bytes = Buffer.from(ciphertext, 'base64');
    bytes[0] ^= 0xff;
    assert.throws(() => decryptField(bytes.toString('base64'), iv));
  });

  it('cannot be decrypted with a different key (a database dump alone is useless)', () => {
    const { ciphertext, iv } = encryptField('secret');
    process.env.CLOUD_ENCRYPTION_KEY = newKey();
    assert.throws(() => decryptField(ciphertext, iv));
  });

  it('validates the configured key', () => {
    assert.doesNotThrow(() => assertEncryptionKeyConfigured());
    for (const bad of [undefined, '', 'short', 'z'.repeat(64), newKey() + 'aa']) {
      if (bad === undefined) delete process.env.CLOUD_ENCRYPTION_KEY;
      else process.env.CLOUD_ENCRYPTION_KEY = bad;
      assert.throws(() => assertEncryptionKeyConfigured(), /CLOUD_ENCRYPTION_KEY/);
    }
  });
});
