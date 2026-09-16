const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Attachments arrive in one of two shapes, decided by the chat they
// belong to: opaque AES-GCM ciphertext for a Secret Chat, or a normal
// file for a Cloud Chat (see controllers/uploadController.js, which is
// where that branch actually happens — it needs the fully-parsed request
// body, which isn't reliably available yet inside a multer fileFilter).
// This middleware's only job is getting bytes onto disk safely.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname || '').slice(0, 10); // keep it short and sane
    cb(null, `${Date.now()}-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

module.exports = upload;
