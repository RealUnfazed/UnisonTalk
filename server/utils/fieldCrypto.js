const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

// Encryption-at-rest for Cloud Chats. This is a fundamentally different
// kind of protection than Secret Chats (see client/src/crypto/webcrypto.js):
// the server CAN decrypt these — that's exactly what makes "log in on any
// device, your history is just there" possible with no client-side key —
// but a raw MongoDB dump, a stolen disk/backup, or a database credential
// leak yields only ciphertext, *provided* CLOUD_ENCRYPTION_KEY wasn't also
// exposed. That key deliberately never touches the database: it lives only
// in the environment (.env), so "the DB got dumped" and "the encryption
// key got dumped" are two separate failures, not one.
//
// This does NOT protect against a fully compromised, running server
// process (which has the key loaded in memory to do its job) — that's the
// same trade-off every server-side "encryption at rest" system makes
// (disk encryption, cloud provider KMS, etc.). If that threat model
// matters for a conversation, that's what Secret Chats are for.

function getKey() {
  const hex = process.env.CLOUD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(
      'CLOUD_ENCRYPTION_KEY is missing or invalid — it must be a 64-character hex string ' +
        '(32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
        'and set it in your .env file.'
    );
  }
  return Buffer.from(hex, 'hex');
}

// Throws immediately if the key is missing/malformed — called at server
// startup so misconfiguration fails loudly before anyone sends a message,
// rather than mysteriously the first time someone tries to chat.
function assertEncryptionKeyConfigured() {
  getKey();
}

// Encrypts a plaintext string for storage. Returns { ciphertext, iv }
// (both base64, or both null for empty/nullish input, so "no content" —
// e.g. an attachment-only message — stores cleanly instead of encrypting
// an empty string).
function encryptField(plaintext) {
  if (plaintext == null || plaintext === '') return { ciphertext: null, iv: null };

  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

// Decrypts a { ciphertext, iv } pair back to the original string. Returns
// null if either piece is missing (nothing was stored). Backward
// compatibility note: if a deployment has pre-existing Cloud Chat messages
// from before this encryption was added, they'll have a value in the
// plaintext field but no matching `*Iv` field — callers should check for
// that case themselves and treat the raw value as already-plaintext
// rather than calling this function on it (see utils/serialize.js).
function decryptField(ciphertextB64, ivB64) {
  if (!ciphertextB64 || !ivB64) return null;

  const key = getKey();
  const combined = Buffer.from(ciphertextB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);
  const encrypted = combined.subarray(0, combined.length - AUTH_TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

module.exports = { encryptField, decryptField, assertEncryptionKeyConfigured };
