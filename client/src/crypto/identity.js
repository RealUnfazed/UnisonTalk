// Secret Chats need a long-term ECDH identity key pair; Cloud Chats never
// call anything in this file at all. This is deliberately lazy — called
// the first time a person opens the "New secret chat" flow, or opens an
// existing Secret Chat — so an account that never touches the feature
// never generates a key, uploads a public key, or pays any of this cost.
//
// The trade-off, stated plainly: a Secret Chat's key lives only in the
// browser(s) where it's been used. Logging in on a new device gives that
// device a fresh key pair, and Secret Chats from before that point won't
// be readable there — this mirrors real Telegram's Secret Chats exactly.
// It does NOT affect Cloud Chats, which are the default and sync
// everywhere on login with no key of any kind.

import { generateIdentityKeyPair, exportPublicKeyB64 } from './webcrypto.js';
import { loadIdentityKeyPair, saveIdentityKeyPair } from './keyStore.js';

// Returns { keyPair, publicKeyB64, isNewDevice, mismatched }.
//
//   isNewDevice — this browser had no local key AND the account already
//                 had a different public key on file: Secret Chats from
//                 another device exist and won't be readable here.
//
//   mismatched  — this browser HAD a local key, but it doesn't match
//                 what's on file for the account. This shouldn't happen
//                 in normal use, but it's the exact failure mode that
//                 produces silent "Unable to decrypt this message" with
//                 no explanation — e.g. if a browser's local key and the
//                 server's record ever get out of sync (testing against
//                 changing server data, manually editing the database,
//                 restoring from a backup, etc). The caller re-uploads
//                 the local key to reconcile, but that only fixes things
//                 going forward — anything encrypted under the previous
//                 pairing is unrecoverable, so this needs to be surfaced,
//                 not silently patched over.
export async function getOrCreateIdentity(userId, serverPublicKey) {
  const existing = await loadIdentityKeyPair(userId);

  if (existing) {
    const publicKeyB64 = await exportPublicKeyB64(existing.publicKey);
    const mismatched = Boolean(serverPublicKey) && serverPublicKey !== publicKeyB64;
    if (mismatched) {
      console.warn(
        '[crypto] local Secret Chat key does not match the public key on file for',
        userId,
        '- reconciling by re-uploading the local key. Messages encrypted under the ' +
          'previous pairing will no longer decrypt from this device.'
      );
    }
    return { keyPair: existing, publicKeyB64, isNewDevice: false, mismatched };
  }

  const keyPair = await generateIdentityKeyPair();
  await saveIdentityKeyPair(userId, keyPair);
  const publicKeyB64 = await exportPublicKeyB64(keyPair.publicKey);

  const isNewDevice = Boolean(serverPublicKey) && serverPublicKey !== publicKeyB64;
  if (isNewDevice) {
    console.warn(
      '[crypto] no local Secret Chat key found for',
      userId,
      'but the account already has one on file - generating a new device key.'
    );
  }

  return { keyPair, publicKeyB64, isNewDevice, mismatched: false };
}
