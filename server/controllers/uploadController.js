const fs = require('fs');
const path = require('path');
const Message = require('../models/Message');
const Chat = require('../models/Chat');
const { isInlineImageType } = require('../utils/validateAttachment');
const { discardUploadedFile } = require('../utils/uploadCleanup');

const { UPLOADS_DIR: UPLOAD_DIR } = require('../config/paths');
const FILENAME_RE = /^[A-Za-z0-9._-]{1,120}$/;

// Two upload shapes land here, distinguished by whether the encrypted
// fields are present:
//   Secret Chat attachment: bytes are already AES-GCM ciphertext (see
//     client/src/crypto/webcrypto.js) with fileIv/metaCiphertext/metaIv
//     alongside. We can't tell what the file is and don't try to.
//   Cloud Chat attachment: a normal file; multer captured its name and type.
function uploadAttachment(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const { fileIv, metaCiphertext, metaIv } = req.body;
  const isSecretUpload = Boolean(fileIv || metaCiphertext || metaIv);

  if (isSecretUpload) {
    if (!fileIv || !metaCiphertext || !metaIv) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'fileIv, metaCiphertext, and metaIv are all required for a Secret Chat attachment' });
    }
    return res.status(201).json({ url: `/uploads/${req.file.filename}`, fileIv, metaCiphertext, metaIv });
  }

  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    isImage: isInlineImageType(req.file.mimetype),
    size: req.file.size,
  });
}

// A file is reachable only through a message that references it, by a
// member of that message's chat. Unknown file and "not your chat" both
// answer 404 so the response doesn't reveal which files exist.
async function findAccessibleAttachment(req, filename) {
  if (!FILENAME_RE.test(filename) || filename.includes('..')) return null;
  const message = await Message.findOne({ 'attachment.url': `/uploads/${filename}` }).select('chat attachment').lean();
  if (!message) return null;
  const isMember = await Chat.exists({ _id: message.chat, participants: req.session.userId });
  return isMember ? message : null;
}

// GET /uploads/:filename — Cloud Chat files (and Secret Chat ciphertext, if
// fetched directly). Safe raster images are shown inline; everything else
// (including anything claiming to be HTML or SVG) is forced to download as
// an opaque, sandboxed blob, so an uploaded file can never run as a page on
// our origin.
async function serveAttachment(req, res) {
  const message = await findAccessibleAttachment(req, req.params.filename);
  if (!message) return res.status(404).json({ error: 'Attachment not found' });

  const { mimeType, fileIv } = message.attachment;
  const inline = !fileIv && isInlineImageType(mimeType);
  res.set({
    'Content-Type': inline ? String(mimeType).toLowerCase() : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=3600',
  });
  res.sendFile(path.join(UPLOAD_DIR, req.params.filename), { dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Attachment not found' });
  });
}

// Secret Chat ciphertext as base64 inside JSON, rather than a file URL —
// download-manager extensions (IDM and friends) hijack anything that looks
// like a file before our JS can decrypt it. Same access rule as above.
async function getAttachmentBytes(req, res) {
  const message = await findAccessibleAttachment(req, req.params.filename);
  if (!message) return res.status(404).json({ error: 'Attachment not found' });

  fs.readFile(path.join(UPLOAD_DIR, req.params.filename), (err, data) => {
    if (err) return res.status(err.code === 'ENOENT' ? 404 : 500).json({ error: 'Attachment not found' });
    res.json({ data: data.toString('base64') });
  });
}

module.exports = { uploadAttachment, serveAttachment, getAttachmentBytes };
