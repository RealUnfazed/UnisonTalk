const mongoose = require('mongoose');

// A message belongs to exactly one chat, and that chat's `isSecret` flag
// decides which of the two shapes below gets used:
//
//   Cloud chat message:  `content` holds AES-256-GCM ciphertext, encrypted
//                         at rest with a server-held key (see
//                         utils/fieldCrypto.js) — the server decrypts it
//                         on every read, so this is invisible to the API
//                         and the client (they always see plain text).
//                         What it protects against is a raw database dump
//                         or stolen backup: without CLOUD_ENCRYPTION_KEY
//                         (deliberately kept out of the database, in the
//                         environment only), `content` is unreadable.
//                         attachment.filename gets the same treatment.
//
//   Secret chat message: content is null; ciphertext+iv hold AES-GCM
//                         ciphertext of the text, encrypted entirely
//                         client-side — the server never has the key for
//                         these at all, not even in memory. See
//                         client/src/crypto/webcrypto.js.
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

    // --- Cloud chat fields (encrypted at rest, decrypted server-side) ---
    content: {
      type: String,
      default: null,
    },
    contentIv: {
      type: String,
      default: null,
    },

    // --- Secret chat fields (encrypted client-side; server never decrypts) ---
    ciphertext: {
      type: String,
      default: null,
    },
    iv: {
      type: String,
      default: null,
    },

    attachment: {
      url: String,
      // Cloud chat attachment metadata — filename is encrypted at rest
      // the same way `content` is; mimeType/isImage/size are left plain
      // since they're low-sensitivity and useful for quick filtering.
      filename: String,
      filenameIv: String,
      mimeType: String,
      isImage: Boolean,
      size: Number,
      // Secret chat attachment metadata (encrypted client-side):
      fileIv: String,
      metaCiphertext: String,
      metaIv: String,
      _id: false,
    },
  },
  { timestamps: true }
);

// Message history for a chat is always fetched newest-first with a cursor,
// so this compound index keeps that query fast even as history grows.
messageSchema.index({ chat: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
