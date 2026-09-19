const User = require('../models/User');
const { decryptField } = require('./fieldCrypto');

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

// Cloud Chat text (message content, attachment filenames) is encrypted at
// rest (see utils/fieldCrypto.js) but the API always hands back plaintext
// — decryption happens here, once, on the way out. `iv` missing while
// `ciphertext` is present means this was written before encryption-at-rest
// existed; treat it as already-plaintext rather than failing to decrypt it.
function decryptCloudText(ciphertext, iv) {
  if (!ciphertext) return null;
  if (!iv) return ciphertext;
  try {
    return decryptField(ciphertext, iv);
  } catch (err) {
    console.error('[serialize] failed to decrypt a cloud field:', err.message);
    return '[This message could not be decrypted]';
  }
}

function serializeMessage(message) {
  const hasAttachment = message.attachment && message.attachment.url;
  let attachment = null;
  if (hasAttachment) {
    attachment = { ...message.attachment };
    if (attachment.filename) attachment.filename = decryptCloudText(attachment.filename, attachment.filenameIv);
    delete attachment.filenameIv;
  }

  return {
    id: message._id.toString(),
    chatId: message.chat._id ? message.chat._id.toString() : message.chat.toString(),
    sender: message.sender._id ? serializeUser(message.sender) : { id: message.sender.toString() },
    // Cloud chats populate `content` (encrypted at rest, decrypted here);
    // Secret chats populate `ciphertext`/`iv` instead, which the server
    // never decrypts — only the recipient's browser can. A given message
    // only ever has one pair populated, matching its chat's mode.
    content: decryptCloudText(message.content, message.contentIv),
    ciphertext: message.ciphertext || null,
    iv: message.iv || null,
    attachment,
    createdAt: message.createdAt,
  };
}

module.exports = { serializeUser, serializeChat, serializeMessage };
