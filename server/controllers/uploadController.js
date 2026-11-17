const { pipeline } = require('node:stream');
const Message = require('../models/Message');
const Chat = require('../models/Chat');
const logger = require('../utils/logger');
const { isInlineImageType } = require('../utils/validateAttachment');
const { attachmentKeyFromUrl, avatarKeyFromUrl } = require('../utils/uploadCleanup');
const { getStorage } = require('../storage');
const { newObjectName } = require('../storage/names');

// Streams a stored object to the client. Headers are set first, so a failure
// part-way through (a dropped S3 connection) closes the response rather than
// sending a corrupt 200 that looks complete.
function sendStream(res, { stream, size }, headers) {
  res.set(headers);
  if (size != null) res.set('Content-Length', String(size));
  pipeline(stream, res, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') logger.warn('[storage] streaming a file failed:', err.message);
  });
}

// Two upload shapes land here, distinguished by whether the encrypted
// fields are present:
//   Secret Chat attachment: bytes are already AES-GCM ciphertext (see
//     client/src/crypto/webcrypto.js) with fileIv/metaCiphertext/metaIv
//     alongside. We can't tell what the file is and don't try to.
//   Cloud Chat attachment: a normal file; multer captured its name and type.
// Either way the storage layer encrypts the bytes again at rest (Cloud Chat
// files are otherwise plaintext) — see storage/encryptedStorage.js.
async function uploadAttachment(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const { fileIv, metaCiphertext, metaIv } = req.body;
  const isSecretUpload = Boolean(fileIv || metaCiphertext || metaIv);
  if (isSecretUpload && (!fileIv || !metaCiphertext || !metaIv)) {
    // Checked BEFORE anything is stored, so a bad request leaves nothing behind.
    return res.status(400).json({ error: 'fileIv, metaCiphertext, and metaIv are all required for a Secret Chat attachment' });
  }

  const name = newObjectName('.bin'); // random; never derived from what the client called the file
  await getStorage().put(name, req.file.buffer, { contentType: 'application/octet-stream' });
  const url = `/uploads/${name}`;

  if (isSecretUpload) return res.status(201).json({ url, fileIv, metaCiphertext, metaIv });
  res.status(201).json({
    url,
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
  if (!attachmentKeyFromUrl(`/uploads/${filename}`)) return null;
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

  const found = await getStorage().stream(attachmentKeyFromUrl(`/uploads/${req.params.filename}`));
  if (!found) return res.status(404).json({ error: 'Attachment not found' });

  const { mimeType, fileIv } = message.attachment;
  const inline = !fileIv && isInlineImageType(mimeType);
  sendStream(res, found, {
    'Content-Type': inline ? String(mimeType).toLowerCase() : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, max-age=3600',
  });
}

const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// GET /uploads/avatars/:name — public: avatars are shown to other people
// (and are never encrypted). Names are unique and never rewritten, so they
// can be cached for good.
async function serveAvatar(req, res) {
  const key = avatarKeyFromUrl(`/uploads/avatars/${req.params.name}`);
  const found = key && (await getStorage().stream(key));
  if (!found) return res.status(404).json({ error: 'Not found' });
  sendStream(res, found, {
    'Content-Type': AVATAR_TYPES[key.split('.').pop().toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'public, max-age=86400, immutable',
  });
}

// Secret Chat ciphertext as base64 inside JSON, rather than a file URL —
// download-manager extensions (IDM and friends) hijack anything that looks
// like a file before our JS can decrypt it. Same access rule as above.
async function getAttachmentBytes(req, res) {
  const message = await findAccessibleAttachment(req, req.params.filename);
  if (!message) return res.status(404).json({ error: 'Attachment not found' });

  const data = await getStorage().read(attachmentKeyFromUrl(`/uploads/${req.params.filename}`));
  if (!data) return res.status(404).json({ error: 'Attachment not found' });
  res.json({ data: data.toString('base64') });
}

module.exports = { uploadAttachment, serveAttachment, serveAvatar, getAttachmentBytes };
