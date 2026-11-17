const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MemoryStorage } = require('../../server/storage/memoryDriver');
const { EncryptedStorage, isEncrypted, deriveFileKey, MAGIC, OVERHEAD } = require('../../server/storage/encryptedStorage');

const newKey = () => crypto.randomBytes(32).toString('hex');
const collect = async (stream) => { const chunks = []; for await (const c of stream) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
const SECRET = Buffer.from('payroll: alice earns 12345 — a very private document');

describe('encryption at rest for attachments', () => {
  let inner, storage, masterKey;
  beforeEach(() => {
    inner = new MemoryStorage();
    masterKey = newKey();
    storage = new EncryptedStorage({ inner, masterKeyHex: masterKey });
  });

  it('stores ciphertext in the layer underneath — never the plaintext — and reads it back', async () => {
    await storage.put('1-a.bin', SECRET, { contentType: 'application/pdf' });
    const stored = await inner.read('1-a.bin');
    assert.ok(stored.subarray(0, 4).equals(MAGIC));
    assert.equal(stored.length, SECRET.length + OVERHEAD);
    assert.ok(!stored.includes('payroll') && !stored.includes('12345'));
    assert.equal(inner.objects.get('1-a.bin').contentType, 'application/octet-stream', 'the real content type is not disclosed to the store');
    assert.ok(SECRET.equals(await storage.read('1-a.bin')));
  });

  it('uses a fresh random IV every time', async () => {
    await storage.put('1-a.bin', SECRET);
    await storage.put('1-b.bin', SECRET);
    assert.ok(!(await inner.read('1-a.bin')).equals(await inner.read('1-b.bin')));
  });

  it('does NOT encrypt avatars (public by design) and keeps their content type', async () => {
    await storage.put('avatars/1-a.png', Buffer.from('png bytes'), { contentType: 'image/png' });
    assert.equal((await inner.read('avatars/1-a.png')).toString(), 'png bytes');
    assert.equal(inner.objects.get('avatars/1-a.png').contentType, 'image/png');
    assert.equal((await storage.read('avatars/1-a.png')).toString(), 'png bytes');
    assert.equal((await collect((await storage.stream('avatars/1-a.png')).stream)).toString(), 'png bytes');
  });

  it('detects tampering anywhere in the stored object (ciphertext or tag)', async () => {
    await storage.put('1-a.bin', SECRET);
    const original = await inner.read('1-a.bin');
    for (const offset of [MAGIC.length + 12 + 3, original.length - 1]) { // inside the ciphertext, and the last tag byte
      const tampered = Buffer.from(original);
      tampered[offset] ^= 0xff;
      await inner.put('1-a.bin', tampered);
      await assert.rejects(storage.read('1-a.bin'), (err) => err.code === 'E_STORAGE_AUTH');
      await assert.rejects(storage.stream('1-a.bin'), (err) => err.code === 'E_STORAGE_AUTH');
    }
  });

  it("binds each file to ITS storage key: ciphertext moved into another file's slot is refused", async () => {
    await storage.put('1-a.bin', SECRET);
    await storage.put('1-b.bin', Buffer.from('something else'));
    await inner.put('1-b.bin', await inner.read('1-a.bin')); // an attacker with write access to the bucket swaps them
    await assert.rejects(storage.read('1-b.bin'), (err) => err.code === 'E_STORAGE_AUTH');
  });

  it('cannot be read with a different CLOUD_ENCRYPTION_KEY', async () => {
    await storage.put('1-a.bin', SECRET);
    const other = new EncryptedStorage({ inner, masterKeyHex: newKey() });
    await assert.rejects(other.read('1-a.bin'), (err) => err.code === 'E_STORAGE_AUTH');
  });

  it('serves legacy plaintext files (written before encryption existed) unchanged', async () => {
    await inner.put('old.bin', Buffer.from('legacy plaintext'));
    assert.equal((await storage.read('old.bin')).toString(), 'legacy plaintext');
    assert.equal((await collect((await storage.stream('old.bin')).stream)).toString(), 'legacy plaintext');
    // ...including a short file that merely starts with the magic bytes
    await inner.put('tiny.bin', Buffer.from('UTE1xyz'));
    assert.equal((await storage.read('tiny.bin')).toString(), 'UTE1xyz');
    assert.equal(isEncrypted(Buffer.from('UTE1xyz')), false);
  });

  it('streams decrypted bytes with the PLAINTEXT size (not the stored size)', async () => {
    await storage.put('1-a.bin', SECRET);
    const { stream, size } = await storage.stream('1-a.bin');
    assert.equal(size, SECRET.length);
    assert.ok(SECRET.equals(await collect(stream)));
    assert.equal(await storage.stream('missing.bin'), null);
    assert.equal(await storage.read('missing.bin'), null);
  });

  it('derives its file key from the master key (separate keys for text and files)', () => {
    const hex = newKey();
    const derived = deriveFileKey(hex);
    assert.equal(derived.length, 32);
    assert.ok(!derived.equals(Buffer.from(hex, 'hex')), 'the raw master key must never encrypt files directly');
    assert.ok(derived.equals(deriveFileKey(hex)), 'deterministic');
    assert.ok(!derived.equals(deriveFileKey(newKey())));
  });

  it('refuses to start without a valid key', () => {
    for (const bad of [undefined, '', 'short', 'z'.repeat(64), newKey() + 'aa']) {
      assert.throws(() => new EncryptedStorage({ inner, masterKeyHex: bad }), /CLOUD_ENCRYPTION_KEY/);
    }
  });

  it('passes exists/delete/list/init/ping straight through', async () => {
    await storage.put('1-a.bin', SECRET);
    assert.equal(await storage.exists('1-a.bin'), true);
    assert.deepEqual((await storage.list('')).map((e) => e.key), ['1-a.bin']);
    await storage.delete('1-a.bin');
    assert.equal(await storage.exists('1-a.bin'), false);
    await assert.doesNotReject(Promise.all([storage.init(), storage.ping()]));
  });

  describe('encryptExisting (migrating legacy files)', () => {
    it('encrypts plaintext attachments, leaves encrypted files and avatars alone, and is safe to re-run', async () => {
      await inner.put('legacy.bin', Buffer.from('old secret'));
      await storage.put('fresh.bin', Buffer.from('new secret'));
      await inner.put('avatars/p.png', Buffer.from('public avatar'));
      const progress = [];

      assert.deepEqual(await storage.encryptExisting({ onProgress: (k) => progress.push(k) }), { encrypted: 1, alreadyEncrypted: 1 });
      assert.deepEqual(progress, ['legacy.bin']);
      assert.ok(isEncrypted(await inner.read('legacy.bin')));
      assert.equal((await storage.read('legacy.bin')).toString(), 'old secret');
      assert.equal((await inner.read('avatars/p.png')).toString(), 'public avatar');

      assert.deepEqual(await storage.encryptExisting(), { encrypted: 0, alreadyEncrypted: 2 });
      assert.equal((await storage.read('legacy.bin')).toString(), 'old secret');
    });
  });
});
