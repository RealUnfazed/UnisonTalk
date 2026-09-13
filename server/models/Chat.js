const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema(
  {
    isGroup: {
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
    // Group chats need one shared symmetric key so every member can read
    // every message, but the server must never see that key in the clear.
    // Instead, the chat creator encrypts ("wraps") a copy of the raw group
    // key individually for each member, using an ECDH-derived key shared
    // only between the creator and that member. The server just stores
    // these opaque, per-member wrapped copies — it cannot unwrap any of
    // them itself. Private (1:1) chats don't need this: both sides can
    // independently derive the same shared key on demand from each
    // other's public key, so nothing extra needs to be stored.
    groupKeyWraps: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        wrappedKey: { type: String, required: true }, // base64 AES-GCM ciphertext of the raw group key
        iv: { type: String, required: true }, // base64, unique per wrap
        wrapperPublicKey: { type: String, required: true }, // creator's public key at wrap time, so the member can re-derive the same ECDH secret
      },
    ],
  },
  { timestamps: true }
);

// Speeds up "find all chats a user belongs to, most recently active first".
chatSchema.index({ participants: 1, updatedAt: -1 });

module.exports = mongoose.model('Chat', chatSchema);
