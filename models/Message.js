const mongoose = require('mongoose');

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
    content: {
      type: String,
      trim: true,
      maxlength: 4000,
      default: '',
    },
    attachment: {
      url: String,
      filename: String,
      mimeType: String,
      isImage: Boolean,
    },
  },
  { timestamps: true }
);

// Message history for a chat is always fetched newest-first with a cursor,
// so this compound index keeps that query fast even as history grows.
messageSchema.index({ chat: 1, createdAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
