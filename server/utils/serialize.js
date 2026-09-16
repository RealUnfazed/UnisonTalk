const User = require('../models/User');

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user._id.toString(),
    username: user.username,
    isOnline: !!user.isOnline,
    lastSeen: user.lastSeen,
    avatarUrl: new User(user).avatarUrl(),
    // Only meaningful for Secret Chats — null for anyone who's never
    // started one. Safe to expose: it's the public half of a key pair.
    publicKey: user.publicKey || null,
  };
}

// Shapes a Chat document (with participants + lastMessage populated) into
// exactly what the client needs, including a computed display name for
// private chats (there's no group "name" field to fall back on).
function serializeChat(chat, currentUserId) {
  const participants = chat.participants.map(serializeUser);
  let displayName = chat.name;

  if (!chat.isGroup) {
    const other = chat.participants.find((p) => p._id.toString() !== currentUserId);
    displayName = other ? other.username : 'Unknown user';
  }

  return {
    id: chat._id.toString(),
    isGroup: chat.isGroup,
    isSecret: !!chat.isSecret,
    name: displayName,
    participants,
    admin: chat.admin ? chat.admin.toString() : null,
    lastMessage: chat.lastMessage ? serializeMessage(chat.lastMessage) : null,
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
  };
}

function serializeMessage(message) {
  return {
    id: message._id.toString(),
    chatId: message.chat._id ? message.chat._id.toString() : message.chat.toString(),
    sender: message.sender._id ? serializeUser(message.sender) : { id: message.sender.toString() },
    // Cloud chats populate `content`; Secret chats populate
    // `ciphertext`/`iv` instead. A given message only ever has one pair
    // populated, matching its chat's mode.
    content: message.content || null,
    ciphertext: message.ciphertext || null,
    iv: message.iv || null,
    attachment: message.attachment && message.attachment.url ? message.attachment : null,
    createdAt: message.createdAt,
  };
}

module.exports = { serializeUser, serializeChat, serializeMessage };
