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

module.exports = { uploadAttachment };
