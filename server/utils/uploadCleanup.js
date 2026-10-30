const fs = require('node:fs');
const path = require('node:path');

// Files that were uploaded but never attached to a message (abandoned
// compose, failed send, rejected request) would otherwise sit on disk
// forever. `isReferenced` is injected so this stays testable without a DB.
async function sweepOrphanUploads({ dir, olderThanMs, isReferenced, now = Date.now() }) {
  const removed = [];
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const stat = await fs.promises.stat(full);
    if (now - stat.mtimeMs < olderThanMs) continue; // young: its message may not have been sent yet
    if (await isReferenced(entry.name)) continue;
    await fs.promises.unlink(full);
    removed.push(entry.name);
  }
  return removed;
}

// Remove a file multer already wrote for a request we then rejected.
function discardUploadedFile(file) {
  if (file && file.path) fs.promises.unlink(file.path).catch(() => {});
}

// Remove a replaced/removed avatar. Only ever touches /uploads/avatars/<name>
// (no subfolders, no leading dot, so no "..").
const AVATAR_URL_RE = /^\/uploads\/avatars\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
function deleteAvatarFile(url, uploadsRoot) {
  if (typeof url !== 'string' || !AVATAR_URL_RE.test(url)) return;
  fs.promises.unlink(path.join(uploadsRoot, url.replace('/uploads/', ''))).catch(() => {});
}

module.exports = { sweepOrphanUploads, discardUploadedFile, deleteAvatarFile };
