const User = require('../models/User');
const { decryptField } = require('./fieldCrypto');

// `viewerId` decides what this person is allowed to see of `user`'s
// presence — see User.privacy.showLastSeen. Deliberately simple and
// one-directional: hiding your own last seen doesn't also hide others'
// from you (unlike Telegram's reciprocal rule), and there's no "My
// Contacts" middle tier, since this app has no contacts list to key one
// off. Always pass the real viewer when there is one; omitting it (or
// passing a falsy value) is only correct for "no specific viewer" cases
// like search results, where the caller passes it explicitly anyway.
function serializeUser(user, viewerId) {
  if (!user) return null;
  const isSelf = Boolean(viewerId) && user._id.toString() === viewerId;
  // Someone who has blocked the viewer never sees their presence either.
  const blockedViewer = Boolean(viewerId) && !isSelf && (user.blocked || []).some((b) => b.toString() === viewerId);
  const showPresence = isSelf || (user.privacy?.showLastSeen !== false && !blockedViewer);

  return {
    id: user._id.toString(),
    username: user.username,
    displayName: user.displayName || null,
    isOnline: showPresence ? !!user.isOnline : false,
    lastSeen: showPresence ? user.lastSeen : null,
    avatarUrl: new User(user).avatarUrl(),
    // Only meaningful for Secret Chats — null for anyone who's never
    // started one. Safe to expose: it's the public half of a key pair.
    publicKey: user.publicKey || null,
    // Whether this account is linked to a Phasetime SSO identity — just
    // a boolean, never the actual phasetimeId. Only really meaningful for
    // "my own" account data (queries that select a restricted field set,
    // like chat participants, won't have `phasetimeId` loaded at all, so
    // this will read as false for other users regardless of reality —
    // that's fine, nothing currently displays this for anyone but "me").
    hasPhasetimeLink: !!user.phasetimeId,
    // Settings are only ever sent back to their own owner.
    ...(isSelf
      ? {
          privacy: {
            showLastSeen: user.privacy?.showLastSeen !== false,
            discoverable: user.privacy?.discoverable !== false,
            readReceipts: user.privacy?.readReceipts !== false,
            groupInvites: user.privacy?.groupInvites !== false,
          },
          autoDownloadLimitMb: user.autoDownloadLimitMb ?? 5,
          blockedIds: (user.blocked || []).map((b) => b.toString()),
        }
      : {}),
  };
}

// Shapes a Chat document (with participants + lastMessage populated) into
// exactly what the client needs, including a computed display name for
// private chats (there's no group "name" field to fall back on) and, for
// groups, their own editable name/description/avatar.
// When each OTHER participant last read this chat — omitting anyone who
// has read receipts turned off. (Your own marker never appears here.)
function readByOthers(chat, currentUserId) {
  const readBy = {};
  for (const r of chat.reads || []) {
    const uid = r.user.toString();
    if (uid === currentUserId) continue;
    const participant = chat.participants.find((p) => p._id.toString() === uid);
    if (participant && participant.privacy?.readReceipts !== false) readBy[uid] = r.at;
  }
  return readBy;
}

function serializeChat(chat, currentUserId, unreadCount = 0) {
  const participants = chat.participants.map((p) => serializeUser(p, currentUserId));
  let displayName = chat.name;

  if (!chat.isGroup) {
    const other = chat.participants.find((p) => p._id.toString() !== currentUserId);
    displayName = other ? other.displayName || other.username : 'Unknown user';
  }

  return {
    id: chat._id.toString(),
    isGroup: chat.isGroup,
    isSecret: !!chat.isSecret,
    name: displayName,
    // Only groups have their own identity to customize — a private
    // chat's "avatar" is just whichever participant isn't you, computed
    // client-side from `participants` the same way it already was.
    description: chat.isGroup ? chat.description || '' : null,
    avatar: chat.isGroup ? chat.avatar || null : null,
    participants,
    unreadCount,
    readBy: readByOthers(chat, currentUserId),
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

// A quote of the message being replied to. Only a populated target (with
// its sender) can be previewed — a bare ObjectId means "not loaded".
function replyPreview(reply) {
  if (!reply || typeof reply !== 'object' || !reply.sender || typeof reply.sender !== 'object' || !reply.sender.username) {
    return null;
  }
  const sender = serializeUser(reply.sender);
  if (reply.deletedAt) return { id: reply._id.toString(), sender, deleted: true };

  const text = decryptCloudText(reply.content, reply.contentIv);
  return {
    id: reply._id.toString(),
    sender,
    deleted: false,
    content: text && text.length > 140 ? `${text.slice(0, 140)}…` : text,
    // Secret Chats: ciphertext the recipient's browser decrypts (we can't).
    ciphertext: reply.ciphertext || null,
    iv: reply.iv || null,
    hasAttachment: Boolean(reply.attachment && reply.attachment.url),
  };
}

function serializeMessage(message) {
  const base = {
    id: message._id.toString(),
    chatId: message.chat._id ? message.chat._id.toString() : message.chat.toString(),
    // No viewer context passed here deliberately — nothing in the client
    // renders a message sender's presence, only their name/avatar, so the
    // privacy branch in serializeUser is moot for this call site.
    sender: message.sender._id ? serializeUser(message.sender) : { id: message.sender.toString() },
    createdAt: message.createdAt,
  };

  // Deleted: nothing about the original survives into the response, even
  // if some field were left behind in the database.
  if (message.deletedAt) {
    return { ...base, deleted: true, deletedAt: message.deletedAt, content: null, ciphertext: null, iv: null, attachment: null, replyTo: null, editedAt: null };
  }

  const hasAttachment = message.attachment && message.attachment.url;
  let attachment = null;
  if (hasAttachment) {
    attachment = { ...message.attachment };
    if (attachment.filename) attachment.filename = decryptCloudText(attachment.filename, attachment.filenameIv);
    delete attachment.filenameIv;
  }

  return {
    ...base,
    deleted: false,
    // Cloud chats populate `content` (encrypted at rest, decrypted here);
    // Secret chats populate `ciphertext`/`iv` instead, which the server
    // never decrypts — only the recipient's browser can. A given message
    // only ever has one pair populated, matching its chat's mode.
    content: decryptCloudText(message.content, message.contentIv),
    ciphertext: message.ciphertext || null,
    iv: message.iv || null,
    attachment,
    replyTo: replyPreview(message.replyTo),
    editedAt: message.editedAt || null,
  };
}

module.exports = { serializeUser, serializeChat, serializeMessage };
