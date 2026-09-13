import {
  importPublicKeyB64,
  exportPublicKeyB64,
  deriveSharedAesKey,
  generateGroupKey,
  exportRawKey,
  importRawKey,
  wrapRawKeyBytes,
  unwrapRawKeyBytes,
} from './webcrypto.js';

// In-memory cache only (chatId -> Promise<CryptoKey>). Deliberately not
// persisted: re-deriving a private chat's key is one ECDH operation, and
// re-unwrapping a group key is one ECDH + one AES-GCM decrypt — both cheap
// enough to redo per page load rather than adding another thing to keep in
// sync in IndexedDB.
const chatKeyCache = new Map();

// Resolves (and caches) the AES-GCM key used to encrypt/decrypt messages
// in `chat`, given the current user's own identity key pair.
export function getChatKey(chat, myKeyPair, myUserId) {
  if (chatKeyCache.has(chat.id)) return chatKeyCache.get(chat.id);

  const promise = chat.isGroup
    ? unwrapGroupKey(chat, myKeyPair, myUserId)
    : deriveDirectKey(chat, myKeyPair, myUserId);

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
    throw new Error(`${other ? other.username : 'The other participant'} hasn't set up encryption yet.`);
  }
  const theirPublicKey = await importPublicKeyB64(other.publicKey);
  return deriveSharedAesKey(myKeyPair.privateKey, theirPublicKey);
}

async function unwrapGroupKey(chat, myKeyPair, myUserId) {
  const myWrap = chat.groupKeyWraps.find((w) => w.userId === myUserId);
  if (!myWrap) throw new Error("You don't have a key for this group on this device.");

  const wrapperPublicKey = await importPublicKeyB64(myWrap.wrapperPublicKey);
  const wrappingKey = await deriveSharedAesKey(myKeyPair.privateKey, wrapperPublicKey);
  const rawKeyBytes = await unwrapRawKeyBytes(myWrap.wrappedKey, myWrap.iv, wrappingKey);
  return importRawKey(rawKeyBytes, false);
}

// Used when *creating* a new group chat: generates a fresh group key and
// wraps a copy of it for every member (including the creator, so the
// creator can also unwrap it the normal way on any device that already
// has their identity key). `members` is [{ username, publicKey }, ...]
// and should include the creator themselves.
export async function createGroupKeyWraps(myKeyPair, members) {
  const groupKey = await generateGroupKey();
  const rawKeyBytes = await exportRawKey(groupKey);
  const wrapperPublicKey = await exportPublicKeyB64(myKeyPair.publicKey);

  const keyWraps = [];
  for (const member of members) {
    if (!member.publicKey) {
      throw new Error(`${member.username} hasn't set up encryption yet.`);
    }
    const theirPublicKey = await importPublicKeyB64(member.publicKey);
    const wrappingKey = await deriveSharedAesKey(myKeyPair.privateKey, theirPublicKey);
    const { wrappedKey, iv } = await wrapRawKeyBytes(rawKeyBytes, wrappingKey);
    keyWraps.push({ username: member.username, wrappedKey, iv });
  }

  return { groupKey, wrapperPublicKey, keyWraps };
}

// Lets the controller seed the cache immediately after creating a group,
// instead of waiting to re-derive it from the server's response.
export function cacheChatKey(chatId, keyPromiseOrKey) {
  chatKeyCache.set(chatId, Promise.resolve(keyPromiseOrKey));
}
