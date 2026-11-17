const multer = require('multer');

// Avatars differ from chat attachments (middleware/upload.js): always plain,
// always publicly viewable, always genuinely images. Held in memory (5 MB
// cap) so the controller can authorise the request, then validate and
// sanitise the image (utils/imageProcessing.js), BEFORE anything is stored.
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

module.exports = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED.has(file.mimetype)) {
      const err = new Error('Avatars must be a PNG, JPEG, GIF, or WebP image.');
      err.status = 400; // shown to the client as-is (see the error handler in app.js)
      return cb(err);
    }
    cb(null, true);
  },
});
