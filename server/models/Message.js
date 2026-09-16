const mongoose = require('mongoose');

// A message belongs to exactly one chat, and that chat's `isSecret` flag
// decides which of the two shapes below gets used:
//
//   Cloud chat message:  content is plain text, attachment has a real
//                         filename/mimeType. Stored and readable server-side,
//                         same as any normal chat app (Slack, Discord, etc).
//
//   Secret chat message: content is null; ciphertext+iv hold AES-GCM
//                         ciphertext of the text, encrypted entirely
//                         client-side. attachment.metaCiphertext holds the
//                         (also encrypted) real filename/mimeType. The
//                         server stores these fields but has no way to
//                         read them — see client/src/crypto/webcrypto.js.
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

    // --- Cloud chat fields ---
    content: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: null,
    },

    // --- Secret chat fields ---
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
      // Cloud chat attachment metadata (plain):
      filename: String,
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
