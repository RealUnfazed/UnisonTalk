// All real cryptography for Secret Chats lives in this one file, built
// entirely on the browser's native Web Crypto API (window.crypto.subtle)
// — no third-party crypto library, nothing to `npm install` on the
// client, nothing that could silently downgrade to a fake/no-op
// implementation.
//
// This is only ever used for Secret Chats. Cloud Chats (the default —
// see models/Chat.js) don't touch this file at all; their messages are
// plain text, stored and synced server-side like any normal chat app.
//
// The Secret Chat scheme, in one paragraph: every user who's ever opened
// a Secret Chat has a long-term ECDH (P-256) key pair, generated and kept
// entirely in that browser (see crypto/keyStore.js). For a Secret Chat
// between Alice and Bob, both independently derive the *same*
// AES-256-GCM key from (their own private key, the other's public key)
// — that's the Diffie-Hellman property: the two computations land on the
// same shared secret without either side ever transmitting it.
//
// Known simplifications vs. a protocol like Signal (disclosed honestly,
// not hidden): no forward secrecy or key ratcheting (a compromised key
// exposes every past message encrypted under it), and no out-of-band
// safety-number verification (so a server that actively lied about
// someone's public key could, in principle, sit in the middle of a
// conversation — this protects against a server that passively logs
// traffic, not one that's fully hostile and interactive). See README.md's
// "Security model" section.

const ECDH_ALGO = { name: 'ECDH', namedCurve: 'P-256' };
const AES_ALGO = { name: 'AES-GCM', length: 256 };
const IV_BYTES = 12; // standard AES-GCM IV size

// ---------------------------------------------------------------------
// base64 <-> ArrayBuffer helpers
// ---------------------------------------------------------------------

export function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function b64ToBuf(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function randomIv() {
  return crypto.getRandomValues(new Uint8Array(IV_BYTES));
}

// ---------------------------------------------------------------------
// Identity key pairs (long-term ECDH keys, one per user, Secret-Chat-only)
// ---------------------------------------------------------------------

// `extractable: true` on both keys of the pair is a deliberate trade-off:
// Web Crypto applies one extractability flag to the whole pair, and we
// need to export both halves — the public key to upload, and the private
// key to persist locally (see crypto/keyStore.js, which stores portable
// exported bytes rather than trusting browsers' CryptoKey structured-clone
// support, which has had inconsistent behavior).
export async function generateIdentityKeyPair() {
  return crypto.subtle.generateKey(ECDH_ALGO, true, ['deriveKey', 'deriveBits']);
}

export async function exportPublicKeyB64(publicKey) {
  const raw = await crypto.subtle.exportKey('spki', publicKey);
  return bufToB64(raw);
}

export async function importPublicKeyB64(b64) {
  return crypto.subtle.importKey('spki', b64ToBuf(b64), ECDH_ALGO, true, []);
}

export async function exportPrivateKeyB64(privateKey) {
  const raw = await crypto.subtle.exportKey('pkcs8', privateKey);
  return bufToB64(raw);
}

export async function importPrivateKeyB64(b64) {
  return crypto.subtle.importKey('pkcs8', b64ToBuf(b64), ECDH_ALGO, true, ['deriveKey', 'deriveBits']);
}

// The core Diffie-Hellman step: combine my private key with someone else's
// public key to get an AES-GCM key neither of us transmitted. Whoever else
// holds the matching private key for that public key can derive the exact
// same AES key from (their private key, my public key).
export async function deriveSharedAesKey(myPrivateKey, theirPublicKey) {
  return crypto.subtle.deriveKey(
    { name: 'ECDH', public: theirPublicKey },
    myPrivateKey,
    AES_ALGO,
    false,
    ['encrypt', 'decrypt']
  );
}

// ---------------------------------------------------------------------
// Encrypt / decrypt
// ---------------------------------------------------------------------

export async function encryptText(key, plaintext) {
  const iv = randomIv();
  const data = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { ciphertext: bufToB64(ciphertext), iv: bufToB64(iv) };
}

export async function decryptText(key, ciphertextB64, ivB64) {
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) },
    key,
    b64ToBuf(ciphertextB64)
  );
  return new TextDecoder().decode(plainBuf);
}

// Binary variant for attachments — ciphertext stays as raw bytes (an
// ArrayBuffer/Blob) instead of base64, so a large file doesn't pay a ~33%
// text-encoding size penalty just to travel over the wire.
export async function encryptBytes(key, arrayBuffer) {
  const iv = randomIv();
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, arrayBuffer);
  return { ciphertext, iv: bufToB64(iv) };
}

export async function decryptBytes(key, ciphertextBuffer, ivB64) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) },
    key,
    ciphertextBuffer
  );
}
