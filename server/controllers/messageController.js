const path = require('path');
const mongoose = require('mongoose');
const Message = require('../models/Message');
const Chat = require('../models/Chat');
const { serializeMessage } = require('../utils/serialize');
const { encryptField } = require('../utils/fieldCrypto');
const { deleteAttachmentFile } = require('../utils/uploadCleanup');
const MESSAGE_POPULATE = require('../utils/messagePopulate');

const UPLOADS_ROOT = path.join(__dirname, '..', 'uploads');
const EDIT_WINDOW_MS = 48 * 60 * 60 * 1000; // same as Telegram

// Shared by edit and delete: the message must exist, not already be
// deleted, and the caller must be a member of its chat. "Doesn't exist"
// and "not your chat" both answer 404 so ids can't be probed.
async function loadForMember(req, res) {
  const { messageId } = req.params;
  if (!mongoose.isValidObjectId(messageId)) {
    res.status(400).json({ error: 'Invalid message id' });
    return null;
  }
  const message = await Message.findById(messageId);
  const chat = message && !message.deletedAt
    ? await Chat.findOne({ _id: message.chat, participants: req.session.userId })
    : null;
  if (!chat) {
    res.status(404).json({ error: 'Message not found' });
    return null;
  }
  return { message, chat };
}

// Cloud Chats: the new text arrives as plain `content` and is encrypted at
// rest exactly like a new message. Secret Chats: the browser sends fresh
// ciphertext + IV; the server never sees the text.
async function editMessage(req, res) {
  const loaded = await loadForMember(req, res);
  if (!loaded) return;
  const { message, chat } = loaded;

  if (message.sender.toString() !== req.session.userId) {
    return res.status(403).json({ error: 'You can only edit your own messages' });
  }
  if (Date.now() - message.createdAt.getTime() > EDIT_WINDOW_MS) {
    return res.status(400).json({ error: 'Messages can only be edited for 48 hours' });
  }

  if (chat.isSecret) {
    const { ciphertext, iv } = req.body;
    if (typeof ciphertext !== 'string' || !ciphertext || ciphertext.length > 16384 || typeof iv !== 'string' || !iv || iv.length > 32) {
      return res.status(400).json({ error: 'ciphertext and iv are required' });
    }
    message.ciphertext = ciphertext;
    message.iv = iv;
  } else {
    const { content } = req.body;
    if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'Message text is required' });
    if (content.trim().length > 4000) return res.status(400).json({ error: 'Message is too long (4000 characters max)' });
    const encrypted = encryptField(content.trim());
    message.content = encrypted.ciphertext;
    message.contentIv = encrypted.iv;
  }

  message.editedAt = new Date();
  await message.save();
  await message.populate(MESSAGE_POPULATE);

  const serialized = serializeMessage(message.toObject());
  req.app.get('io').to(String(chat._id)).emit('message-edited', serialized);
  res.json(serialized);
}

// Soft delete: the row stays (so reply quotes and ordering still make
// sense) but everything identifying its content is removed, and the
// attachment file is deleted from disk. The sender can delete their own
// messages; a group's creator can also remove other people's.
async function deleteMessage(req, res) {
  const loaded = await loadForMember(req, res);
  if (!loaded) return;
  const { message, chat } = loaded;

  const isSender = message.sender.toString() === req.session.userId;
  const isGroupAdmin = chat.isGroup && chat.admin && chat.admin.toString() === req.session.userId;
  if (!isSender && !isGroupAdmin) return res.status(403).json({ error: 'You can only delete your own messages' });

  const fileUrl = message.attachment && message.attachment.url;
  await Message.updateOne(
    { _id: message._id },
    {
      $set: { deletedAt: new Date() },
      $unset: { content: 1, contentIv: 1, ciphertext: 1, iv: 1, attachment: 1, editedAt: 1, replyTo: 1 },
    }
  );
  deleteAttachmentFile(fileUrl, UPLOADS_ROOT);

  const fresh = await Message.findById(message._id).populate(MESSAGE_POPULATE);
  const serialized = serializeMessage(fresh.toObject());
  req.app.get('io').to(String(chat._id)).emit('message-deleted', serialized);
  res.json(serialized);
}

module.exports = { editMessage, deleteMessage };
