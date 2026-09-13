const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// The file that arrives here is already AES-GCM ciphertext produced in the
// browser (see client/src/crypto/webcrypto.js) — the client always sends it
// as opaque `application/octet-stream` bytes, regardless of what the
// original file was. So there's nothing meaningful to MIME-filter: every
// upload looks identical (indistinguishable random-looking bytes) to the
// server no matter what it originally was. We just cap the size and give
// it an unguessable name; the "real" filename and type live only inside
// the encrypted metadata blob the client stores alongside the message,
// which the server also can't read.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, _file, cb) => {
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, `${Date.now()}-${unique}.bin`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB (ciphertext is slightly larger than plaintext)
});

module.exports = upload;
