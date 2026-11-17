const logger = require('./logger');

// URL <-> storage key. These are the ONLY shapes of upload URL the app
// produces, and the regexes are deliberately the same shape the storage
// layer's key validation accepts.
const NAME = '[A-Za-z0-9][A-Za-z0-9._-]{0,119}';
const ATTACHMENT_URL_RE = new RegExp(`^/uploads/(${NAME})$`);
const AVATAR_URL_RE = new RegExp(`^/uploads/avatars/(${NAME})$`);

function attachmentKeyFromUrl(url) {
  const match = typeof url === 'string' ? ATTACHMENT_URL_RE.exec(url) : null;
  return match && !match[1].includes('..') ? match[1] : null;
}

function avatarKeyFromUrl(url) {
  const match = typeof url === 'string' ? AVATAR_URL_RE.exec(url) : null;
  return match && !match[1].includes('..') ? `avatars/${match[1]}` : null;
}

// Files uploaded but never attached to a message (abandoned compose, failed
// send, replaced avatar whose delete failed) would otherwise sit in storage
// forever. `isReferenced` is injected so this stays testable without a DB.
async function sweepOrphanUploads({ storage, prefix = '', olderThanMs, isReferenced, now = Date.now() }) {
  const removed = [];
  for (const entry of await storage.list(prefix)) {
    if (entry.name.startsWith('.')) continue;
    if (now - entry.lastModified.getTime() < olderThanMs) continue; // young: its message may not have been sent yet
    if (await isReferenced(entry.name)) continue;
    await storage.delete(entry.key);
    removed.push(entry.name);
  }
  return removed;
}

// Best-effort deletes: a failure is logged and left for the orphan sweep.
function deleteByKey(storage, key) {
  if (!key) return Promise.resolve();
  return storage.delete(key).catch((err) => logger.warn(`[storage] could not delete ${key}:`, err.message));
}
const deleteStoredAttachment = (storage, url) => deleteByKey(storage, attachmentKeyFromUrl(url));
const deleteStoredAvatar = (storage, url) => deleteByKey(storage, avatarKeyFromUrl(url));

module.exports = { sweepOrphanUploads, deleteStoredAttachment, deleteStoredAvatar, attachmentKeyFromUrl, avatarKeyFromUrl };
