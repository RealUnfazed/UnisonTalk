const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MemoryStorage } = require('../../server/storage/memoryDriver');
const { EncryptedStorage, isEncrypted } = require('../../server/storage/encryptedStorage');
const { copyObjects, guessContentType } = require('../../server/storage/migrate');

const KEY = crypto.randomBytes(32).toString('hex');

describe('moving uploads between stores', () => {
  it('guesses content types: avatars by extension, attachments are opaque', () => {
    assert.equal(guessContentType('avatars/1-a.png'), 'image/png');
    assert.equal(guessContentType('avatars/1-a.JPG'), 'image/jpeg');
    assert.equal(guessContentType('avatars/1-a.webp'), 'image/webp');
    assert.equal(guessContentType('avatars/1-a.weird'), 'application/octet-stream');
    assert.equal(guessContentType('1-a.png'), 'application/octet-stream');
  });

  it('copies attachments and avatars as raw bytes, and skips what the destination already has', async () => {
    const source = new MemoryStorage();
    const destination = new MemoryStorage();
    await source.put('1-a.bin', Buffer.from('attachment'));
    await source.put('avatars/2-b.png', Buffer.from('avatar'));
    await destination.put('1-a.bin', Buffer.from('already here'));
    const progress = [];

    assert.deepEqual(await copyObjects({ source, destination, onProgress: (k) => progress.push(k) }), { copied: 1, skipped: 1 });
    assert.deepEqual(progress, ['avatars/2-b.png']);
    assert.equal((await destination.read('1-a.bin')).toString(), 'already here', 'an existing object is never overwritten');
    assert.equal((await destination.read('avatars/2-b.png')).toString(), 'avatar');
    assert.equal(destination.objects.get('avatars/2-b.png').contentType, 'image/png');
  });

  it('a full migration: legacy plaintext in one store ends up encrypted in another, readable with the same key', async () => {
    const oldStore = new MemoryStorage();
    await oldStore.put('1-legacy.bin', Buffer.from('written before encryption existed'));
    const newInner = new MemoryStorage();
    const newStorage = new EncryptedStorage({ inner: newInner, masterKeyHex: KEY });

    await copyObjects({ source: oldStore, destination: newInner });          // step 1: copy raw bytes
    assert.equal(isEncrypted(await newInner.read('1-legacy.bin')), false);
    await newStorage.encryptExisting();                                       // step 2: encrypt in place
    assert.ok(isEncrypted(await newInner.read('1-legacy.bin')));
    assert.equal((await newStorage.read('1-legacy.bin')).toString(), 'written before encryption existed');
  });

  it('copying ALREADY-encrypted files between stores keeps them readable (same key, same storage key)', async () => {
    const a = new EncryptedStorage({ inner: new MemoryStorage(), masterKeyHex: KEY });
    await a.put('1-x.bin', Buffer.from('encrypted at the source'));
    const bInner = new MemoryStorage();
    await copyObjects({ source: a.inner, destination: bInner });
    const b = new EncryptedStorage({ inner: bInner, masterKeyHex: KEY });
    assert.equal((await b.read('1-x.bin')).toString(), 'encrypted at the source');
    assert.deepEqual(await b.encryptExisting(), { encrypted: 0, alreadyEncrypted: 1 }, 'not encrypted twice');
  });
});
