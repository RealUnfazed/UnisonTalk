const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Attachments arrive in one of two shapes, decided by the chat they
// belong to: opaque AES-GCM ciphertext for a Secret Chat, or a normal
// file for a Cloud Chat (controllers/uploadController.js branches on it).
// Every file is stored as `<time>-<random>.bin` regardless of what it was
// called: the client's extension is never trusted, so nothing on disk can
// be coaxed into being served as HTML/SVG/script. How a file is served
// (inline image vs. sandboxed download) is decided from the validated
// message record at request time — see serveAttachment.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}.bin`),
});

module.exports = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB
