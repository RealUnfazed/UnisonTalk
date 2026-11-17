const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { assertSafeKey } = require('./keys');

// Encrypts chat attachments before they reach ANY driver, so neither a disk
// image nor a bucket (or whoever can read it) sees file contents.
//
//   stored object = "UTE1" | IV (12) | AES-256-GCM ciphertext | auth tag (16)
//
//  - The file key is derived (HKDF) from CLOUD_ENCRYPTION_KEY, so the same
//    raw key never encrypts both message text and files.
//  - The storage key is bound in as authenticated data: swapping one file's
//    ciphertext into another file's slot fails authentication, not silently
//    serves the wrong file.
//  - Files written before this existed have no "UTE1" header and are served
//    as-is (legacy plaintext) until `encryptExisting()` rewrites them.
//  - Avatars are NOT encrypted: they're public by design.
const MAGIC = Buffer.from('UTE1');
const IV_LEN = 12;
const TAG_LEN = 16;
const OVERHEAD = MAGIC.length + IV_LEN + TAG_LEN;

function deriveFileKey(masterKeyHex) {
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(masterKeyHex, 'hex'), Buffer.alloc(0), 'unisontalk:file-encryption:v1', 32));
}

function isEncrypted(buffer) {
  return buffer.length >= OVERHEAD && buffer.subarray(0, MAGIC.length).equals(MAGIC);
}

function encryptBuffer(plain, key, storageKey) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(storageKey));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, body, cipher.getAuthTag()]);
}

function decryptBuffer(stored, key, storageKey) {
  try {
    const iv = stored.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = stored.subarray(stored.length - TAG_LEN);
    const body = stored.subarray(MAGIC.length + IV_LEN, stored.length - TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(storageKey));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    const err = new Error(`stored file "${storageKey}" failed authentication (tampered, corrupted, or the wrong CLOUD_ENCRYPTION_KEY)`);
    err.code = 'E_STORAGE_AUTH';
    throw err;
  }
}

const defaultShouldEncrypt = (key) => !key.startsWith('avatars/');

class EncryptedStorage {
  constructor({ inner, masterKeyHex, shouldEncrypt = defaultShouldEncrypt }) {
    if (!/^[0-9a-fA-F]{64}$/.test(masterKeyHex || '')) {
      throw new Error('EncryptedStorage needs CLOUD_ENCRYPTION_KEY (64 hex characters)');
    }
    this.inner = inner; // exposed for migrations, which copy raw bytes
    this.key = deriveFileKey(masterKeyHex);
    this.shouldEncrypt = shouldEncrypt;
  }

  init() { return this.inner.init(); }

  ping() { return this.inner.ping(); }

  exists(key) { return this.inner.exists(key); }

  delete(key) { return this.inner.delete(key); }

  list(prefix) { return this.inner.list(prefix); }

  async put(key, buffer, options = {}) {
    assertSafeKey(key);
    if (!this.shouldEncrypt(key)) return this.inner.put(key, buffer, options);
    // The content type isn't disclosed to the store either: it's just bytes.
    return this.inner.put(key, encryptBuffer(buffer, this.key, key), { ...options, contentType: 'application/octet-stream' });
  }

  async read(key) {
    assertSafeKey(key);
    const stored = await this.inner.read(key);
    if (!stored) return null;
    if (!this.shouldEncrypt(key) || !isEncrypted(stored)) return stored; // avatar, or legacy plaintext
    return decryptBuffer(stored, this.key, key);
  }

  // GCM only releases plaintext after the whole tag is verified, so encrypted
  // files are decrypted in memory (uploads are capped at 20 MB) and streamed from there.
  async stream(key) {
    assertSafeKey(key);
    if (!this.shouldEncrypt(key)) return this.inner.stream(key);
    const plain = await this.read(key);
    return plain ? { stream: Readable.from([plain]), size: plain.length } : null;
  }

  // Encrypts attachments written before encryption existed. Safe to re-run:
  // anything already encrypted is left alone.
  async encryptExisting({ onProgress } = {}) {
    const result = { encrypted: 0, alreadyEncrypted: 0 };
    for (const entry of await this.inner.list('')) {
      const stored = await this.inner.read(entry.key);
      if (!stored) continue;
      if (isEncrypted(stored)) {
        result.alreadyEncrypted += 1;
        continue;
      }
      await this.inner.put(entry.key, encryptBuffer(stored, this.key, entry.key), { contentType: 'application/octet-stream' });
      result.encrypted += 1;
      if (onProgress) onProgress(entry.key);
    }
    return result;
  }
}

module.exports = { EncryptedStorage, isEncrypted, encryptBuffer, decryptBuffer, deriveFileKey, MAGIC, OVERHEAD };
