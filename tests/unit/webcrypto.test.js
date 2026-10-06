const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

if (!globalThis.crypto) globalThis.crypto = require('node:crypto').webcrypto;

// client/package.json declares "type": "module", so this loads as ESM.
const load = () => import(pathToFileURL(path.join(__dirname, '../../client/src/crypto/webcrypto.js')).href);

async function pair(c) {
  const alice = await c.generateIdentityKeyPair();
  const bob = await c.generateIdentityKeyPair();
  return {
    alice,
    bob,
    aliceKey: await c.deriveSharedAesKey(alice.privateKey, bob.publicKey),
    bobKey: await c.deriveSharedAesKey(bob.privateKey, alice.publicKey),
  };
}

describe('Secret Chat crypto (client/src/crypto/webcrypto.js)', () => {
  it('both parties derive the same key and can read each other', async () => {
    const c = await load();
    const { aliceKey, bobKey } = await pair(c);
    const { ciphertext, iv } = await c.encryptText(aliceKey, 'hello bob');
    assert.equal(await c.decryptText(bobKey, ciphertext, iv), 'hello bob');
    const back = await c.encryptText(bobKey, 'hi alice');
    assert.equal(await c.decryptText(aliceKey, back.ciphertext, back.iv), 'hi alice');
  });

  it('a third party cannot decrypt', async () => {
    const c = await load();
    const { alice, aliceKey } = await pair(c);
    const eve = await c.generateIdentityKeyPair();
    const eveKey = await c.deriveSharedAesKey(eve.privateKey, alice.publicKey);
    const { ciphertext, iv } = await c.encryptText(aliceKey, 'secret');
    await assert.rejects(c.decryptText(eveKey, ciphertext, iv));
  });

  it('never leaks plaintext and never reuses an IV', async () => {
    const c = await load();
    const { aliceKey } = await pair(c);
    const a = await c.encryptText(aliceKey, 'same message');
    const b = await c.encryptText(aliceKey, 'same message');
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
    assert.ok(!Buffer.from(a.ciphertext, 'base64').toString('latin1').includes('same message'));
  });

  it('detects tampering with ciphertext', async () => {
    const c = await load();
    const { aliceKey, bobKey } = await pair(c);
    const { ciphertext, iv } = await c.encryptText(aliceKey, 'untouched');
    const bytes = new Uint8Array(c.b64ToBuf(ciphertext));
    bytes[0] ^= 0xff;
    await assert.rejects(c.decryptText(bobKey, c.bufToB64(bytes), iv));
  });

  it('handles unicode text (Persian, emoji)', async () => {
    const c = await load();
    const { aliceKey, bobKey } = await pair(c);
    const text = 'سلام دنیا 👋 — héllo';
    const { ciphertext, iv } = await c.encryptText(aliceKey, text);
    assert.equal(await c.decryptText(bobKey, ciphertext, iv), text);
  });

  it('round-trips binary attachments', async () => {
    const c = await load();
    const { aliceKey, bobKey } = await pair(c);
    const original = new Uint8Array(50000);
    globalThis.crypto.getRandomValues(original);
    const { ciphertext, iv } = await c.encryptBytes(aliceKey, original.buffer);
    assert.equal(ciphertext.byteLength, original.byteLength + 16); // + GCM tag
    const plain = new Uint8Array(await c.decryptBytes(bobKey, ciphertext, iv));
    assert.deepEqual(plain, original);
  });

  it('identity keys survive export -> import (the persistence path)', async () => {
    const c = await load();
    const original = await c.generateIdentityKeyPair();
    const pubB64 = await c.exportPublicKeyB64(original.publicKey);
    const privB64 = await c.exportPrivateKeyB64(original.privateKey);
    const restoredPub = await c.importPublicKeyB64(pubB64);
    const restoredPriv = await c.importPrivateKeyB64(privB64);
    assert.equal(await c.exportPublicKeyB64(restoredPub), pubB64);

    const other = await c.generateIdentityKeyPair();
    const fromOriginal = await c.deriveSharedAesKey(original.privateKey, other.publicKey);
    const fromRestored = await c.deriveSharedAesKey(restoredPriv, other.publicKey);
    const { ciphertext, iv } = await c.encryptText(fromOriginal, 'still readable');
    assert.equal(await c.decryptText(fromRestored, ciphertext, iv), 'still readable');
  });

  it('base64 helpers round-trip every byte value', async () => {
    const c = await load();
    const all = new Uint8Array(256).map((_, i) => i);
    assert.deepEqual(new Uint8Array(c.b64ToBuf(c.bufToB64(all))), all);
  });
});
