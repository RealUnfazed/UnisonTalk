const Chat = require('../models/Chat');
const User = require('../models/User');

// "Everything up to `at` in this chat has been read by `userId`." Drives
// unread counts. `timestamps: false` matters: chats are sorted by
// updatedAt, and opening a chat must not bounce it to the top of the list.
async function setReadMarker(chatId, userId, at = new Date()) {
  const updated = await Chat.updateOne(
    { _id: chatId, 'reads.user': userId },
    { $set: { 'reads.$.at': at } },
    { timestamps: false }
  );
  if (updated.matchedCount === 0) {
    await Chat.updateOne(
      { _id: chatId, 'reads.user': { $ne: userId } },
      { $push: { reads: { user: userId, at } } },
      { timestamps: false }
    );
  }
}

// Marks a chat read for `userId` and — only if they allow read receipts —
// tells everyone in the chat's room. Someone who turned receipts off still
// gets correct unread counts (the marker is stored either way); others just
// never learn when they read.
async function markChatRead({ chatId, userId, io }) {
  const isMember = await Chat.exists({ _id: chatId, participants: userId });
  if (!isMember) return null;

  const at = new Date();
  await setReadMarker(chatId, userId, at);

  const user = await User.findById(userId).select('privacy.readReceipts').lean();
  if (io && user?.privacy?.readReceipts !== false) {
    io.to(String(chatId)).emit('chat-read', { chatId: String(chatId), userId: String(userId), at });
  }
  return at;
}

module.exports = { setReadMarker, markChatRead };
