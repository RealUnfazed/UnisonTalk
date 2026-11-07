const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { serializeMessage, serializeChat } = require('../utils/serialize');
const { encryptField } = require('../utils/fieldCrypto');
const { visibleToMe } = require('../utils/chatVisibility');
const CHAT_POPULATE = require('../utils/chatPopulate');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { sanitizeAttachment } = require('../utils/validateAttachment');
const MESSAGE_POPULATE = require('../utils/messagePopulate');
const { setReadMarker, markChatRead } = require('../utils/readState');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const isId = (v) => typeof v === 'string' && mongoose.isValidObjectId(v);
// Socket payloads are whatever the client sends — including null, numbers or
// arrays. Destructuring null in a handler's parameter list throws inside
// Socket.IO, which is an uncaught exception that takes the server down.
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Tracks how many open sockets/tabs each user currently has, so we only
// flip someone to "offline" once their very last connection drops.
const onlineSocketsByUser = new Map();

function initSockets(io, sessionMiddleware) {
  // Socket.IO doesn't know about Express sessions by default. Wrapping the
  // session middleware like this lets every socket read `socket.request.session`,
  // the same cookie-backed session the HTTP routes use — one login, shared
  // identity across both transports.
  const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);
  io.use(wrap(sessionMiddleware));

  // Reject the handshake outright if there's no logged-in user on the session.
  io.use((socket, next) => {
    if (socket.request.session && socket.request.session.userId) return next();
    next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => handleConnection(io, socket));
}

async function handleConnection(io, socket) {
  const userId = socket.request.session.userId;

  // A private room just for this user, used to push events (like "a new
  // group chat was created") to every tab they have open.
  socket.join(`user:${userId}`);

  const myChats = await Chat.find({ participants: userId, ...visibleToMe(userId) }).select('_id');
  myChats.forEach((chat) => socket.join(chat._id.toString()));

  const sockets = onlineSocketsByUser.get(userId) || new Set();
  const wasOffline = sockets.size === 0;
  sockets.add(socket.id);
  onlineSocketsByUser.set(userId, sockets);

  if (wasOffline) {
    const updatedUser = await User.findByIdAndUpdate(userId, { isOnline: true }, { new: true }).select(
      'privacy.showLastSeen'
    );
    if (updatedUser?.privacy?.showLastSeen !== false) {
      broadcastPresence(io, presenceRooms(socket), 'user-online', { userId });
    }
  }

  // Called when the client opens a chat that was created after this socket
  // connected (e.g. a brand-new group), so the socket starts receiving its events.
  socket.on('join-chat', async (payload, ack) => {
    const { chatId } = asObject(payload);
    // Everything here is client-supplied. An unvalidated id used to throw a
    // CastError inside an async handler — an unhandled rejection that took
    // the whole server down.
    try {
      if (!isId(chatId)) return ack?.({ error: 'chatId is required' });
      const chat = await Chat.findOne({ _id: chatId, participants: userId }).select('_id');
      if (!chat) return ack?.({ error: 'Not a participant of that chat' });
      socket.join(chatId);
      ack?.({ ok: true });
    } catch (err) {
      console.error('[socket] join-chat failed:', err.message);
      ack?.({ error: 'Could not join chat' });
    }
  });

  // Typing events are only relayed into rooms this socket has actually
  // joined — otherwise anyone who knew a chat id could inject events into it.
  socket.on('typing', (payload) => {
    const { chatId } = asObject(payload);
    if (isId(chatId) && socket.rooms.has(chatId)) socket.to(chatId).emit('typing', { chatId, userId });
  });

  socket.on('stop-typing', (payload) => {
    const { chatId } = asObject(payload);
    if (isId(chatId) && socket.rooms.has(chatId)) socket.to(chatId).emit('stop-typing', { chatId, userId });
  });

  // "I've read this chat up to now" — sent when a chat is opened/viewed.
  socket.on('mark-read', async (payload, ack) => {
    const { chatId } = asObject(payload);
    try {
      if (!isId(chatId) || !socket.rooms.has(chatId)) return ack?.({ error: 'Invalid chat' });
      await markChatRead({ chatId, userId, io });
      ack?.({ ok: true });
    } catch (err) {
      console.error('[socket] mark-read failed:', err.message);
      ack?.({ error: 'Could not mark as read' });
    }
  });

  // For a Cloud Chat, `content` is plain text as far as the app logic is
  // concerned — but it's encrypted at rest before it touches MongoDB (see
  // utils/fieldCrypto.js), transparently to everyone but this function and
  // serializeMessage, which decrypts it again on the way out. For a Secret
  // Chat, `ciphertext`/`iv` (and the attachment's `metaCiphertext`) arrive
  // already encrypted from the browser and are stored exactly as received
  // — this handler never has the key for those at all.
  socket.on('send-message', async (payload, ack) => {
    const { chatId, content, ciphertext, iv, attachment, replyTo } = asObject(payload);
    try {
      if (!isId(chatId)) return ack?.({ error: 'Invalid chat' });
      const chat = await Chat.findOne({ _id: chatId, participants: userId });
      if (!chat) return ack?.({ error: 'Not a participant of that chat' });

      if (content != null && typeof content !== 'string') return ack?.({ error: 'Invalid message' });
      if (ciphertext != null && (typeof ciphertext !== 'string' || ciphertext.length > 16384)) return ack?.({ error: 'Invalid message' });
      if (iv != null && (typeof iv !== 'string' || iv.length > 32)) return ack?.({ error: 'Invalid message' });

      const trimmedContent = (content || '').trim();
      const hasPayload = chat.isSecret ? ciphertext || attachment : trimmedContent || attachment;
      if (!chatId || !hasPayload) {
        return ack?.({ error: 'Message needs text or an attachment' });
      }
      if (!chat.isSecret && trimmedContent.length > 4000) {
        return ack?.({ error: 'Message is too long (4000 characters max)' });
      }

      // A brand-new private chat has no lastMessage yet, and (per
      // chatController.createPrivateChat) is only visible to whoever
      // created it — everyone else doesn't know it exists. This message
      // is what changes that.
      const isFirstMessageInPrivateChat = !chat.isGroup && !chat.lastMessage;

      const messageData = {
        chat: chatId,
        sender: userId,
        ciphertext: chat.isSecret && ciphertext ? ciphertext : undefined,
        iv: chat.isSecret && ciphertext ? iv : undefined,
      };

      if (!chat.isSecret && trimmedContent) {
        const encryptedContent = encryptField(trimmedContent);
        messageData.content = encryptedContent.ciphertext;
        messageData.contentIv = encryptedContent.iv;
      }

      if (attachment) {
        // Rebuilt from validated fields only — never store client-supplied
        // URLs or metadata as-is (see utils/validateAttachment.js).
        const checked = sanitizeAttachment(attachment, { isSecret: chat.isSecret });
        if (checked.error) return ack?.({ error: checked.error });
        if (!fs.existsSync(path.join(UPLOAD_DIR, path.basename(checked.value.url)))) {
          return ack?.({ error: 'Attachment not found' });
        }
        if (!chat.isSecret) {
          const encryptedName = encryptField(checked.value.filename);
          messageData.attachment = { ...checked.value, filename: encryptedName.ciphertext, filenameIv: encryptedName.iv };
        } else {
          messageData.attachment = checked.value;
        }
      }

      if (replyTo !== undefined && replyTo !== null) {
        // Must be a live message in THIS chat — can't quote across chats.
        if (!isId(replyTo) || !(await Message.exists({ _id: replyTo, chat: chatId, deletedAt: null }))) {
          return ack?.({ error: 'Invalid reply' });
        }
        messageData.replyTo = replyTo;
      }

      let message = await Message.create(messageData);
      message = await message.populate(MESSAGE_POPULATE);

      // Bumps `updatedAt` via timestamps, which is what chat list sorting relies on.
      chat.lastMessage = message._id;
      await chat.save();
      await setReadMarker(chatId, userId, message.createdAt); // sending implies you've read everything before it

      if (isFirstMessageInPrivateChat) {
        await chat.populate(CHAT_POPULATE);
        const chatObj = chat.toObject();
        chat.participants
          .filter((p) => p._id.toString() !== userId)
          .forEach((p) => {
            const recipientId = p._id.toString();
            // Bring their already-connected sockets (any open tab) into
            // this room now, server-side, so the new-message broadcast
            // just below actually reaches them — their sockets never
            // joined it at connection time, since the chat wasn't
            // visible to them yet (see the room-join filter above).
            io.in(`user:${recipientId}`).socketsJoin(chatId);
            // Serialized per-recipient, not reused from the sender's own
            // view — "the other participant's name" means something
            // different depending on who's looking. Sending the same
            // object to both sides was the original bug report here.
            io.to(`user:${recipientId}`).emit('chat-created', serializeChat(chatObj, recipientId));
          });
      }

      const serialized = serializeMessage(message.toObject());
      // Broadcast to everyone in the room, including the sender's own other
      // tabs — the UI always renders from this server-confirmed event rather
      // than an optimistic local echo, so every client stays in sync.
      io.to(chatId).emit('new-message', serialized);
      ack?.({ ok: true, message: serialized });
    } catch (err) {
      console.error('[socket] send-message failed:', err.message);
      ack?.({ error: 'Could not send message' });
    }
  });

  // "disconnecting" (not "disconnect") fires while the socket still knows
  // which rooms it was in, which is exactly what we need to notify the
  // right chats that this user went offline.
  socket.on('disconnecting', () => {
    const sockets = onlineSocketsByUser.get(userId);
    if (!sockets) return;
    sockets.delete(socket.id);

    if (sockets.size === 0) {
      onlineSocketsByUser.delete(userId);
      const lastSeen = new Date();
      // Captured now, synchronously — socket.rooms is only guaranteed
      // populated up to this point, and the privacy check below is async.
      const rooms = presenceRooms(socket);

      User.findByIdAndUpdate(userId, { isOnline: false, lastSeen }, { new: true })
        .select('privacy.showLastSeen')
        .then((updatedUser) => {
          if (updatedUser?.privacy?.showLastSeen !== false) {
            broadcastPresence(io, rooms, 'user-offline', { userId, lastSeen });
          }
        })
        .catch((err) => console.error('[socket] failed to mark offline:', err.message));
    }
  });
}

// The chat rooms (not the socket's own id room or its personal
// user:<id> notification room) this socket currently belongs to — used
// to decide who to notify about a presence change.
function presenceRooms(socket) {
  return Array.from(socket.rooms).filter((room) => room !== socket.id && !room.startsWith('user:'));
}

function broadcastPresence(io, rooms, event, payload) {
  rooms.forEach((room) => io.to(room).emit(event, payload));
}

module.exports = initSockets;
