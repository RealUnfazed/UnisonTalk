const { UPLOADS_DIR } = require('../config/paths');
const { LocalStorage } = require('./localDriver');
const { createS3FromEnv } = require('./s3Driver');
const { EncryptedStorage } = require('./encryptedStorage');

// STORAGE_DRIVER=local (default) | s3. The returned storage always encrypts
// chat attachments with CLOUD_ENCRYPTION_KEY, whichever driver is underneath.
function createDriver(env = process.env, deps = {}) {
  const driver = (env.STORAGE_DRIVER || 'local').toLowerCase();
  if (driver === 'local') return new LocalStorage({ root: deps.root || UPLOADS_DIR });
  if (driver === 's3') return createS3FromEnv(env, deps);
  throw new Error(`Unknown STORAGE_DRIVER "${env.STORAGE_DRIVER}" (expected "local" or "s3")`);
}

function createStorage(env = process.env, deps = {}) {
  return new EncryptedStorage({ inner: createDriver(env, deps), masterKeyHex: env.CLOUD_ENCRYPTION_KEY });
}

// Controllers look the storage up per call (not at import time) so server.js
// can configure it once env is loaded, and tests can swap it.
let current = null;
const getStorage = () => current || (current = createStorage());
const setStorage = (storage) => { current = storage; };

module.exports = { createStorage, createDriver, getStorage, setStorage };
