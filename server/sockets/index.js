const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { serializeMessage } = require('../utils/serialize');

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

  const myChats = await Chat.find({ participants: userId }).select('_id');
  myChats.forEach((chat) => socket.join(chat._id.toString()));

  const sockets = onlineSocketsByUser.get(userId) || new Set();
  const wasOffline = sockets.size === 0;
  sockets.add(socket.id);
  onlineSocketsByUser.set(userId, sockets);

  if (wasOffline) {
    await User.findByIdAndUpdate(userId, { isOnline: true });
    broadcastPresence(io, socket, 'user-online', { userId });
  }

  // Called when the client opens a chat that was created after this socket
  // connected (e.g. a brand-new group), so the socket starts receiving its events.
  socket.on('join-chat', async ({ chatId } = {}, ack) => {
    if (!chatId) return ack?.({ error: 'chatId is required' });
    const chat = await Chat.findOne({ _id: chatId, participants: userId }).select('_id');
    if (!chat) return ack?.({ error: 'Not a participant of that chat' });
    socket.join(chatId);
    ack?.({ ok: true });
  });

  socket.on('typing', ({ chatId } = {}) => {
    if (chatId) socket.to(chatId).emit('typing', { chatId, userId });
  });

  socket.on('stop-typing', ({ chatId } = {}) => {
    if (chatId) socket.to(chatId).emit('stop-typing', { chatId, userId });
  });

  // Note what this handler does NOT do: it never looks at, validates, or
  // logs the actual message text. `ciphertext`/`iv` (and the attachment's
  // `metaCiphertext`) arrive already encrypted from the browser and are
  // stored exactly as received. The server's only job is routing bytes to
  // the right room — the diagram in the README is literally this function.
  socket.on('send-message', async ({ chatId, ciphertext, iv, attachment } = {}, ack) => {
    try {
      if (!chatId || (!ciphertext && !attachment)) {
        return ack?.({ error: 'Message needs text or an attachment' });
      }

      const chat = await Chat.findOne({ _id: chatId, participants: userId });
      if (!chat) return ack?.({ error: 'Not a participant of that chat' });

      let message = await Message.create({
        chat: chatId,
        sender: userId,
        ciphertext: ciphertext || undefined,
        iv: ciphertext ? iv : undefined,
        attachment: attachment || undefined,
      });
      message = await message.populate('sender', 'username');

      // Bumps `updatedAt` via timestamps, which is what chat list sorting relies on.
      chat.lastMessage = message._id;
      await chat.save();

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
      User.findByIdAndUpdate(userId, { isOnline: false, lastSeen }).catch((err) =>
        console.error('[socket] failed to mark offline:', err.message)
      );
      broadcastPresence(io, socket, 'user-offline', { userId, lastSeen });
    }
  });
}

// Emits a presence event to every chat room this socket belongs to
// (skipping its own per-user notification room).
function broadcastPresence(io, socket, event, payload) {
  const rooms = Array.from(socket.rooms).filter(
    (room) => room !== socket.id && !room.startsWith('user:')
  );
  rooms.forEach((room) => io.to(room).emit(event, payload));
}

module.exports = initSockets;
