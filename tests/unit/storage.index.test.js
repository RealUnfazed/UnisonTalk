const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createStorage, createDriver, getStorage, setStorage } = require('../../server/storage');
const { LocalStorage } = require('../../server/storage/localDriver');
const { S3Storage } = require('../../server/storage/s3Driver');
const { EncryptedStorage } = require('../../server/storage/encryptedStorage');
const { MemoryStorage } = require('../../server/storage/memoryDriver');
const { newObjectName } = require('../../server/storage/names');
const { assertSafeKey, StorageKeyError } = require('../../server/storage/keys');
const { sdk } = require('../helpers/fakeS3');

const KEY = crypto.randomBytes(32).toString('hex');

describe('createStorage', () => {
  it('defaults to local disk, always wrapped in attachment encryption', () => {
    const storage = createStorage({ CLOUD_ENCRYPTION_KEY: KEY }, { root: '/tmp/somewhere' });
    assert.ok(storage instanceof EncryptedStorage);
    assert.ok(storage.inner instanceof LocalStorage);
    assert.equal(storage.inner.root, '/tmp/somewhere');
  });

  it('selects S3 with STORAGE_DRIVER=s3 (case-insensitive) — and only then needs the AWS SDK', () => {
    const storage = createStorage({ CLOUD_ENCRYPTION_KEY: KEY, STORAGE_DRIVER: 'S3', S3_BUCKET: 'b' }, { sdk });
    assert.ok(storage.inner instanceof S3Storage);
    const guarded = { get sdk() { throw new Error('the AWS SDK must not be loaded for local storage'); } };
    assert.doesNotThrow(() => createStorage({ CLOUD_ENCRYPTION_KEY: KEY }, guarded));
  });

  it('refuses unknown drivers and a missing encryption key', () => {
    assert.throws(() => createDriver({ STORAGE_DRIVER: 'ftp' }), /Unknown STORAGE_DRIVER/);
    assert.throws(() => createStorage({}), /CLOUD_ENCRYPTION_KEY/);
  });
});

describe('getStorage / setStorage', () => {
  afterEach(() => setStorage(null));

  it('is a lazily created singleton that tests can replace', () => {
    const replacement = new MemoryStorage();
    setStorage(replacement);
    assert.equal(getStorage(), replacement);
    assert.equal(getStorage(), getStorage());
  });
});

describe('newObjectName', () => {
  it('is "<ms timestamp>-<128 random bits>" with an optional validated extension', () => {
    assert.match(newObjectName(), /^\d{13}-[0-9a-f]{32}$/);
    assert.match(newObjectName('.png'), /^\d{13}-[0-9a-f]{32}\.png$/);
    assert.equal(new Set(Array.from({ length: 1000 }, () => newObjectName('.bin'))).size, 1000);
  });

  it('rejects extensions that could smuggle a path or a surprise type', () => {
    for (const ext of ['png', '.PNG', '.p/ng', '../x', '.toolongext', '.', '. png']) assert.throws(() => newObjectName(ext), /invalid extension/, ext);
  });

  it('produces names the storage layer accepts', () => {
    assert.doesNotThrow(() => assertSafeKey(newObjectName('.bin')));
    assert.doesNotThrow(() => assertSafeKey(`avatars/${newObjectName('.webp')}`));
    assert.throws(() => assertSafeKey('avatars/../1-a.bin'), StorageKeyError);
  });
});
