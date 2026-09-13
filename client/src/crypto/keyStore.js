// Persists the user's ECDH identity key pair in IndexedDB so it survives
// page reloads and browser restarts, without ever touching the network or
// the server. Modern browsers can store a CryptoKey object directly via
// IndexedDB's structured-clone support — we don't need to export it to
// raw bytes just to save it locally.

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
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({
      userId,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadIdentityKeyPair(userId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(userId);
    req.onsuccess = () => {
      const record = req.result;
      resolve(record ? { publicKey: record.publicKey, privateKey: record.privateKey } : null);
    };
    req.onerror = () => reject(req.error);
  });
}
