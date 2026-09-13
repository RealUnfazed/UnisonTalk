const mongoose = require('mongoose');

// Every field here that could reveal what was actually said is
// ciphertext-only. The server (and MongoDB itself) never has the keys
// needed to read `ciphertext`, `attachment.metaCiphertext`, or the bytes
// stored on disk at `attachment.url` — those are all encrypted client-side
// before this document is ever created. See client/src/crypto/webcrypto.js
// for the encryption side and server/sockets/index.js for confirmation
// that the server only ever stores what it's given, untouched.
const messageSchema = new mongoose.Schema(
  {
    chat: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Chat',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Base64 AES-GCM ciphertext of the message text. Empty/omitted for a
    // message that's attachment-only.
    ciphertext: {
      type: String,
      default: null,
    },
    // Base64 IV used for `ciphertext`. A fresh random IV per message —
    // never reused with the same key.
    iv: {
      type: String,
      default: null,
    },
    attachment: {
      // Path to the *encrypted* file bytes on disk. The server stores
      // whatever ciphertext it's handed; it has no idea what's inside.
      url: String,
      // Base64 IV used to encrypt the file bytes.
      fileIv: String,
      // The real filename and MIME type are also encrypted (as a small
      // JSON blob) rather than stored in the clear — otherwise the server
      // would learn "this is a .pdf called payroll.pdf" even without
      // reading its contents.
      metaCiphertext: String,
      metaIv: String,
    },
  },
  { timestamps: true }
);

// Message history for a chat is always fetched newest-first with a cursor,
// so this compound index keeps that query fast even as history grows.
messageSchema.index({ chat: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
