import { importPublicKeyB64, deriveSharedAesKey } from './webcrypto.js';

// In-memory cache only (chatId -> Promise<CryptoKey>). Deliberately not
// persisted: re-deriving a Secret Chat's key is one ECDH operation —
// cheap enough to redo per page load rather than adding another thing to
// keep in sync in IndexedDB.
const chatKeyCache = new Map();

// Resolves (and caches) the AES-GCM key used to encrypt/decrypt messages
// in a Secret Chat, given the current user's own identity key pair.
// Cloud Chats never call this at all.
export function getSecretChatKey(chat, myKeyPair, myUserId) {
  if (chatKeyCache.has(chat.id)) return chatKeyCache.get(chat.id);

  const promise = deriveDirectKey(chat, myKeyPair, myUserId);
  chatKeyCache.set(chat.id, promise);
  // If derivation fails, don't leave a rejected promise cached forever —
  // let the next attempt retry (e.g. once the other user has a public key).
  promise.catch(() => chatKeyCache.delete(chat.id));
  return promise;
}

export function forgetChatKey(chatId) {
  chatKeyCache.delete(chatId);
}

async function deriveDirectKey(chat, myKeyPair, myUserId) {
  const other = chat.participants.find((p) => p.id !== myUserId);
  if (!other || !other.publicKey) {
    throw new Error(`${other ? other.username : 'The other participant'} hasn't opened a Secret Chat before.`);
  }
  const theirPublicKey = await importPublicKeyB64(other.publicKey);
  return deriveSharedAesKey(myKeyPair.privateKey, theirPublicKey);
}
