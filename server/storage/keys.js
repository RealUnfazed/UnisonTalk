// Storage keys are exactly what the app generates and nothing else:
//   "<name>"           chat attachments
//   "avatars/<name>"   profile and group pictures
// where <name> is 1-120 chars of [A-Za-z0-9._-] starting alphanumeric. Every
// driver validates every key, so even a bug elsewhere (or a hostile value
// that slipped through) can't turn into a path traversal or an arbitrary
// object key.
class StorageKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageKeyError';
  }
}

const NAME = '[A-Za-z0-9][A-Za-z0-9._-]{0,119}';
const KEY_RE = new RegExp(`^(avatars/)?${NAME}$`);
const PREFIXES = new Set(['', 'avatars/']);

function assertSafeKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.includes('..')) {
    throw new StorageKeyError(`invalid storage key: ${JSON.stringify(String(key).slice(0, 60))}`);
  }
  return key;
}

function assertSafePrefix(prefix) {
  if (!PREFIXES.has(prefix)) throw new StorageKeyError(`invalid storage prefix: ${JSON.stringify(String(prefix).slice(0, 60))}`);
  return prefix;
}

const nameOf = (key) => key.slice(key.lastIndexOf('/') + 1);

module.exports = { StorageKeyError, assertSafeKey, assertSafePrefix, nameOf, KEY_RE };
