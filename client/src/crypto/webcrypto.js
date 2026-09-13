// All real cryptography lives in this one file, built entirely on the
// browser's native Web Crypto API (window.crypto.subtle) — no third-party
// crypto library, nothing to `npm install` on the client, nothing that
// could silently downgrade to a fake/no-op implementation.
//
// The scheme, in one paragraph: every user has a long-term ECDH (P-256)
// key pair. For a private chat, both participants independently derive
// the *same* AES-256-GCM key from (my private key, their public key) —
// that's the Diffie-Hellman property: the two computations land on the
// same shared secret without either side ever transmitting it. For a
// group chat, there's no single pair to derive from, so instead a random
// AES-256-GCM "group key" is generated once and a copy of it is
// encrypted ("wrapped") individually for each member using that same
// ECDH-derived trick — see crypto/chatKeys.js for that part. Either way,
// only ciphertext + a public key directory ever reaches the server.
//
// Known simplifications vs. a protocol like Signal (disclosed honestly,
// not hidden): no forward secrecy or key ratcheting (a compromised key
// exposes all past messages encrypted with it), no out-of-band safety
// number verification (so a server that actively lied about someone's
// public key could man-in-the-middle a conversation — this protects
// against a server that passively logs traffic, not one that's fully
// hostile and interactive), and no multi-device sync (a new browser means
// a new key pair, which can't decrypt anything encrypted under the old
// one). See README.md's "Security model" section.

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
// Identity key pairs (long-term ECDH keys, one per user)
// ---------------------------------------------------------------------

// `extractable: true` on both keys of the pair is a deliberate, documented
// trade-off: Web Crypto applies one extractability flag to the whole pair,
// and we need to export the *public* half to upload it. We simply never
// call exportKey on the private half in application code — see
// crypto/keyStore.js, which persists the CryptoKey object itself (IndexedDB
// supports storing CryptoKey directly) rather than raw exported bytes.
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
// Symmetric (AES-256-GCM) keys — used directly for private chats (via
// deriveSharedAesKey above) and generated fresh for group chats.
// ---------------------------------------------------------------------

// `extractable: true` here is required so the raw bytes can be wrapped
// (encrypted) individually for each group member — see chatKeys.js.
export async function generateGroupKey() {
  return crypto.subtle.generateKey(AES_ALGO, true, ['encrypt', 'decrypt']);
}

export async function exportRawKey(key) {
  return crypto.subtle.exportKey('raw', key);
}

export async function importRawKey(rawBytes, extractable = false) {
  return crypto.subtle.importKey('raw', rawBytes, AES_ALGO, extractable, ['encrypt', 'decrypt']);
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

// ---------------------------------------------------------------------
// Key wrapping — encrypting one key's raw bytes with another key, used to
// hand a group's shared AES key to each member individually.
// ---------------------------------------------------------------------

export async function wrapRawKeyBytes(rawKeyBytes, wrappingKey) {
  const iv = randomIv();
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, rawKeyBytes);
  return { wrappedKey: bufToB64(wrapped), iv: bufToB64(iv) };
}

export async function unwrapRawKeyBytes(wrappedKeyB64, ivB64, wrappingKey) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(b64ToBuf(ivB64)) },
    wrappingKey,
    b64ToBuf(wrappedKeyB64)
  );
}
