// Moving existing uploads between stores. Both functions work on RAW bytes,
// so a file that is already encrypted is copied as-is (its storage key — and
// therefore the authenticated data bound into it — doesn't change).
const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

function guessContentType(key) {
  if (!key.startsWith('avatars/')) return 'application/octet-stream';
  return AVATAR_TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

// source / destination: raw drivers (no encryption layer). Skips objects the
// destination already has, so an interrupted copy can simply be re-run.
async function copyObjects({ source, destination, onProgress }) {
  const result = { copied: 0, skipped: 0 };
  for (const prefix of ['', 'avatars/']) {
    for (const entry of await source.list(prefix)) {
      if (await destination.exists(entry.key)) {
        result.skipped += 1;
        continue;
      }
      const bytes = await source.read(entry.key);
      if (!bytes) continue; // vanished mid-copy
      await destination.put(entry.key, bytes, { contentType: guessContentType(entry.key) });
      result.copied += 1;
      if (onProgress) onProgress(entry.key);
    }
  }
  return result;
}

module.exports = { copyObjects, guessContentType };
