const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');

// Two upload shapes land here, distinguished by whether the encrypted
// fields are present:
//
//   Secret Chat attachment: the file bytes are already AES-GCM ciphertext
//     (encrypted client-side — see client/src/crypto/webcrypto.js), and
//     fileIv/metaCiphertext/metaIv (also from the client) travel alongside
//     it. This handler can't tell what the file is and doesn't try to.
//
//   Cloud Chat attachment: a normal file, uploaded as-is. Multer already
//     captured its real name and MIME type.
function uploadAttachment(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const { fileIv, metaCiphertext, metaIv } = req.body;
  const isSecretUpload = Boolean(fileIv || metaCiphertext || metaIv);

  if (isSecretUpload) {
    if (!fileIv || !metaCiphertext || !metaIv) {
      return res
        .status(400)
        .json({ error: 'fileIv, metaCiphertext, and metaIv are all required for a Secret Chat attachment' });
    }
    // Secret Chat bytes are fetched through getAttachmentBytes below (a
    // JSON API response), not the static /uploads/ path — see that
    // function's comment for why. `url` here is just an internal
    // reference the client uses to build that API call, never fetched
    // directly as a file.
    return res.status(201).json({
      url: `/uploads/${req.file.filename}`,
      fileIv,
      metaCiphertext,
      metaIv,
    });
  }

  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    isImage: req.file.mimetype.startsWith('image/'),
    size: req.file.size,
  });
}

// Serves a Secret Chat attachment's encrypted bytes as base64 inside a
// JSON response, instead of as a static file. This is deliberate: a
// plain file URL (especially one serving `application/octet-stream` with
// a generic extension, exactly what encrypted attachments look like) is
// exactly the pattern download-manager browser extensions (IDM and
// similar) watch for and hijack — they intercept the request before the
// page's own JavaScript ever sees the response, which breaks the
// fetch-then-decrypt flow entirely. A JSON API response doesn't look like
// a downloadable file to anything, so there's nothing for a download
// manager to grab. Cloud Chat attachments intentionally keep using plain
// /uploads/ URLs — those are real, useful files, and a normal browser or
// download-manager download is exactly the correct behavior for them.
function getAttachmentBytes(req, res) {
  const filename = path.basename(req.params.filename); // strip any path traversal attempt
  const filePath = path.join(UPLOAD_DIR, filename);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'Attachment not found' });
      console.error('[upload] failed to read attachment:', err.message);
      return res.status(500).json({ error: 'Could not read attachment' });
    }
    res.json({ data: data.toString('base64') });
  });
}

module.exports = { uploadAttachment, getAttachmentBytes };
