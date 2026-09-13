// By the time a file reaches here, it has already been encrypted in the
// browser (see client/src/crypto/webcrypto.js's encryptBytes) and uploaded
// as opaque bytes. This handler doesn't — and can't — know what the file
// actually is; it just persists ciphertext and hands back a URL plus
// whatever encrypted metadata (filename/type, also encrypted) the client
// sent alongside it.
function uploadAttachment(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  const { fileIv, metaCiphertext, metaIv } = req.body;
  if (!fileIv || !metaCiphertext || !metaIv) {
    return res.status(400).json({ error: 'fileIv, metaCiphertext, and metaIv are required' });
  }

  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    fileIv,
    metaCiphertext,
    metaIv,
  });
}

module.exports = { uploadAttachment };
