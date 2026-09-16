const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    isGroup: {
      type: Boolean,
      default: false,
    },
    // Two distinct kinds of conversation, deliberately — this is the
    // Telegram-style split: a Cloud Chat is stored server-side like a
    // normal chat app (instant multi-device access, no key management,
    // no way to lose history by losing a device), while a Secret Chat is
    // genuinely end-to-end encrypted (the server only ever sees
    // ciphertext) at the cost of being tied to the device(s) that were
    // present when it was used. Secret Chats are always 1:1 — real
    // Telegram doesn't offer secret groups either, since there's no
    // single "other party" to Diffie-Hellman with.
    isSecret: {
      type: Boolean,
      default: false,
    },
    // Only used for group chats. Private chats are labelled client-side
    // using "the other participant's" username instead.
    name: {
      type: String,
      trim: true,
      maxlength: 40,
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
      },
    ],
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message',
    },
  },
  { timestamps: true }
);

// Speeds up "find all chats a user belongs to, most recently active first".
chatSchema.index({ participants: 1, updatedAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);
