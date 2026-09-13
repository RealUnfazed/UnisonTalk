import { generateIdentityKeyPair, exportPublicKeyB64 } from './webcrypto.js';
import { loadIdentityKeyPair, saveIdentityKeyPair } from './keyStore.js';

// Makes sure this browser has an ECDH identity key pair for `userId`,
// generating one if needed, and reports whether this is a "new device"
// relative to what the server already has on file for this account —
// the caller uses that to warn the person that older encrypted content
// (older group chats, specifically) won't be readable from here.
//
// Returns { keyPair, publicKeyB64, isNewDevice }.
export async function getOrCreateIdentity(userId, serverPublicKey) {
  const existing = await loadIdentityKeyPair(userId);

  if (existing) {
    const publicKeyB64 = await exportPublicKeyB64(existing.publicKey);
    return { keyPair: existing, publicKeyB64, isNewDevice: false };
  }

  const keyPair = await generateIdentityKeyPair();
  await saveIdentityKeyPair(userId, keyPair);
  const publicKeyB64 = await exportPublicKeyB64(keyPair.publicKey);

  // If the server already had a (different) public key on file, this
  // account has been used from another browser/device before. There's no
  // way to recover that old private key — it never left the other device
  // — so this browser is starting fresh.
  const isNewDevice = Boolean(serverPublicKey) && serverPublicKey !== publicKeyB64;

  return { keyPair, publicKeyB64, isNewDevice };
}
