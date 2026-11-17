const crypto = require('node:crypto');

// "<ms-timestamp>-<128 random bits><ext>": unguessable, unique, sortable by
// age. The extension comes from a validated image type or is empty — never
// from anything the client named the file.
function newObjectName(ext = '') {
  if (ext !== '' && !/^\.[a-z0-9]{1,5}$/.test(ext)) throw new Error(`invalid extension: ${ext}`);
  return `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${ext}`;
}

module.exports = { newObjectName };
