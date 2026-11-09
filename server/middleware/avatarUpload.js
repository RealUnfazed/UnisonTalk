const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Avatars differ from chat attachments (middleware/upload.js): always
// plain, always publicly viewable, always genuinely images.
const { AVATARS_DIR: AVATAR_DIR } = require('../config/paths');

// The stored extension comes from the validated MIME type, NEVER from the
// uploaded filename — otherwise "evil.html" declared as image/png would be
// saved as .html and served as a web page from our own origin (stored XSS).
const EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}${EXTENSIONS[file.mimetype]}`),
});

module.exports = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!EXTENSIONS[file.mimetype]) {
      const err = new Error('Avatars must be a PNG, JPEG, GIF, or WebP image.');
      err.status = 400; // shown to the client as-is (see the error handler in app.js)
      return cb(err);
    }
    cb(null, true);
  },
});
