const { getStorage } = require('../storage');
const { newObjectName } = require('../storage/names');
const { processAvatar } = require('./imageProcessing');

// Validates, sanitises (EXIF/GPS stripped, resized when sharp is present) and
// stores an uploaded avatar; returns the URL to save on the user or chat. An
// invalid image throws an ImageError (HTTP 400) BEFORE anything is written.
async function storeAvatar(file, { storage = getStorage(), process = processAvatar } = {}) {
  const processed = await process(file.buffer, file.mimetype);
  const name = newObjectName(processed.ext);
  await storage.put(`avatars/${name}`, processed.buffer, { contentType: processed.contentType });
  return `/uploads/avatars/${name}`;
}

module.exports = { storeAvatar };
