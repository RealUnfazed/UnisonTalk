const fs = require('node:fs');
const path = require('node:path');

// Where uploads live. UPLOAD_DIR lets a container mount a volume anywhere
// (the Dockerfile uses /data/uploads); unset, it's server/uploads as before.
const UPLOADS_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(__dirname, '..', 'uploads');
const AVATARS_DIR = path.join(UPLOADS_DIR, 'avatars');

// A freshly mounted volume is empty, and multer will not create folders.
function ensureUploadDirs() {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

module.exports = { UPLOADS_DIR, AVATARS_DIR, ensureUploadDirs };
