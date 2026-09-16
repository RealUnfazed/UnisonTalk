// Persists the user's ECDH identity key pair in IndexedDB so it survives
// page reloads, browser restarts, and logging out and back in — without
// ever touching the network or the server.
//
// The pair is stored as exported, portable bytes (PKCS8 for the private
// key, SPKI for the public key — see crypto/webcrypto.js), not as raw
// CryptoKey objects. Browsers CAN store a CryptoKey object directly via
// IndexedDB's structured-clone support, but that's a newer capability
// with a real, high-stakes failure mode here: if it silently doesn't
// round-trip correctly, the app would quietly treat every login as a
// brand-new device and generate a fresh key pair, permanently breaking
// decryption of everything encrypted under the old one — with no error
// message, since ECDH derivation doesn't "fail" for a wrong key, it just
// produces a different one. Exporting to plain bytes and re-importing on
// load sidesteps that risk entirely; it's the standard, well-supported way
// to persist Web Crypto keys.

import { exportPublicKeyB64, importPublicKeyB64, exportPrivateKeyB64, importPrivateKeyB64 } from './webcrypto.js';

const DB_NAME = 'unisontalk-keys';
const DB_VERSION = 1;
const STORE = 'identityKeys';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'userId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveIdentityKeyPair(userId, keyPair) {
  const [publicKeySpki, privateKeyPkcs8] = await Promise.all([
    exportPublicKeyB64(keyPair.publicKey),
    exportPrivateKeyB64(keyPair.privateKey),
  ]);

  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const req = tx.objectStore(STORE).put({ userId, publicKeySpki, privateKeyPkcs8 });
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });

  console.info('[crypto] identity key pair saved to IndexedDB for', userId);
}

export async function loadIdentityKeyPair(userId) {
  const db = await openDb();
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(userId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });

  if (!record) {
    console.info('[crypto] no stored identity key pair found for', userId);
    return null;
  }

  try {
    const [publicKey, privateKey] = await Promise.all([
      importPublicKeyB64(record.publicKeySpki),
      importPrivateKeyB64(record.privateKeyPkcs8),
    ]);
    console.info('[crypto] identity key pair loaded from IndexedDB for', userId);
    return { publicKey, privateKey };
  } catch (err) {
    // A stored record that fails to import is as good as missing — better
    // to fall back to generating fresh (with the usual new-device warning)
    // than to silently proceed with something broken.
    console.error('[crypto] stored identity key pair for', userId, 'failed to import:', err);
    return null;
  }
}
