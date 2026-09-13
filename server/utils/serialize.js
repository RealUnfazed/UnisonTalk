const User = require('../models/User');

function serializeUser(user) {
  if (!user) return null;
  return {
    id: user._id.toString(),
    username: user.username,
    isOnline: !!user.isOnline,
    lastSeen: user.lastSeen,
    avatarUrl: new User(user).avatarUrl(),
    // Public key material is, by definition, safe to hand to anyone —
    // clients need it to encrypt messages/keys to this user. It's the
    // *private* key that must never appear anywhere server-side.
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
    name: displayName,
    participants,
    admin: chat.admin ? chat.admin.toString() : null,
    lastMessage: chat.lastMessage ? serializeMessage(chat.lastMessage) : null,
    // Opaque to the server — just AES-GCM ciphertext of the group key,
    // once per member. Sent in full; a client can only ever unwrap the
    // single entry that matches its own user id and its own private key.
    groupKeyWraps: (chat.groupKeyWraps || []).map((w) => ({
      userId: (w.user._id || w.user).toString(),
      wrappedKey: w.wrappedKey,
      iv: w.iv,
      wrapperPublicKey: w.wrapperPublicKey,
    })),
    updatedAt: chat.updatedAt,
    createdAt: chat.createdAt,
  };
}

function serializeMessage(message) {
  return {
    id: message._id.toString(),
    chatId: message.chat._id ? message.chat._id.toString() : message.chat.toString(),
    sender: message.sender._id ? serializeUser(message.sender) : { id: message.sender.toString() },
    // Ciphertext + IV only. The server has never seen, and cannot produce,
    // the plaintext behind these fields.
    ciphertext: message.ciphertext || null,
    iv: message.iv || null,
    attachment: message.attachment && message.attachment.url ? message.attachment : null,
    createdAt: message.createdAt,
  };
}

module.exports = { serializeUser, serializeChat, serializeMessage };
