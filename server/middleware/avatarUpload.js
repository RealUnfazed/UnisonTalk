const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Avatars are a different kind of upload from chat attachments
// (middleware/upload.js): always plain (there's no "Secret" profile
// picture), always meant to be publicly viewable, and always actually
// images — unlike a chat attachment, which for a Secret Chat is opaque
// ciphertext the server can't and shouldn't try to validate.
const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const unique = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname || '').slice(0, 10);
    cb(null, `${Date.now()}-${unique}${ext}`);
  },
});

const avatarUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — plenty for a profile picture
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(new Error('Avatars must be a PNG, JPEG, GIF, or WebP image.'));
    }
    cb(null, true);
  },
});

module.exports = avatarUpload;
