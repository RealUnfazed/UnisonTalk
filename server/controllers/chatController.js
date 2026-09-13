const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { serializeChat, serializeMessage, serializeUser } = require('../utils/serialize');

const CHAT_POPULATE = [
  { path: 'participants', select: 'username isOnline lastSeen publicKey' },
  { path: 'groupKeyWraps.user', select: '_id' },
  { path: 'lastMessage', populate: { path: 'sender', select: 'username' } },
];

async function listChats(req, res) {
  const chats = await Chat.find({ participants: req.session.userId })
    .populate(CHAT_POPULATE)
    .sort({ updatedAt: -1 })
    .lean();
  res.json(chats.map((c) => serializeChat(c, req.session.userId)));
}

// Find-or-create a 1:1 chat with another user by username. No key
// wrapping needed here — both sides can independently derive the same
// ECDH shared key from each other's public key whenever they open the
// chat, so there's nothing extra for the server to store.
async function createPrivateChat(req, res) {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const other = await User.findOne({ username: username.trim() });
    if (!other) return res.status(404).json({ error: 'No user with that username' });
    if (other._id.toString() === req.session.userId) {
      return res.status(400).json({ error: "You can't start a chat with yourself" });
    }
    if (!other.publicKey) {
      return res.status(409).json({
        error: `${other.username} hasn't set up encryption yet — ask them to log in once first.`,
      });
    }

    let chat = await Chat.findOne({
      isGroup: false,
      participants: { $all: [req.session.userId, other._id], $size: 2 },
    }).populate(CHAT_POPULATE);

    let created = false;
    if (!chat) {
      chat = await Chat.create({ isGroup: false, participants: [req.session.userId, other._id] });
      chat = await chat.populate(CHAT_POPULATE);
      created = true;
    }

    const serialized = serializeChat(chat.toObject(), req.session.userId);

    if (created) {
      const io = req.app.get('io');
      io.to(`user:${other._id}`).emit('chat-created', serialized);
    }

    res.status(created ? 201 : 200).json(serialized);
  } catch (err) {
    console.error('[chat] private chat failed:', err.message);
    res.status(500).json({ error: 'Could not start chat' });
  }
}

// Create a group chat. The client has already generated a random AES-GCM
// group key and wrapped (encrypted) a copy of it for every member —
// including itself — using an ECDH-derived key shared with each member.
// This endpoint just resolves usernames to accounts and stores those
// opaque wrapped copies; it never sees the raw group key.
async function createGroupChat(req, res) {
  try {
    const { name, wrapperPublicKey, keyWraps } = req.body;

    if (!name || !wrapperPublicKey || !Array.isArray(keyWraps) || keyWraps.length < 2) {
      return res.status(400).json({
        error: 'name, wrapperPublicKey, and keyWraps for at least yourself + one member are required',
      });
    }

    const usernames = keyWraps.map((w) => w.username);
    const users = await User.find({ username: { $in: usernames } });
    const userByUsername = new Map(users.map((u) => [u.username, u]));

    const missing = usernames.filter((u) => !userByUsername.has(u));
    if (missing.length > 0) {
      return res.status(404).json({ error: `Unknown username(s): ${missing.join(', ')}` });
    }

    const selfIncluded = users.some((u) => u._id.toString() === req.session.userId);
    if (!selfIncluded) {
      return res.status(400).json({
        error: 'Your own wrapped copy of the group key is missing — include yourself in keyWraps.',
      });
    }

    const groupKeyWraps = keyWraps.map((w) => ({
      user: userByUsername.get(w.username)._id,
      wrappedKey: w.wrappedKey,
      iv: w.iv,
      wrapperPublicKey,
    }));

    let chat = await Chat.create({
      isGroup: true,
      name: name.trim(),
      participants: groupKeyWraps.map((w) => w.user),
      admin: req.session.userId,
      groupKeyWraps,
    });
    chat = await chat.populate(CHAT_POPULATE);
    const serialized = serializeChat(chat.toObject(), req.session.userId);

    const io = req.app.get('io');
    users
      .filter((u) => u._id.toString() !== req.session.userId)
      .forEach((u) => io.to(`user:${u._id}`).emit('chat-created', serialized));

    res.status(201).json(serialized);
  } catch (err) {
    console.error('[chat] group chat failed:', err.message);
    res.status(500).json({ error: 'Could not create group' });
  }
}

// Cursor-paginated history, newest page first, returned in chronological
// order. Every message comes back as ciphertext + IV (plus encrypted
// attachment metadata, if any) — decryption happens entirely client-side.
async function getMessages(req, res) {
  const { chatId } = req.params;
  const { before, limit = 30 } = req.query;

  if (!mongoose.isValidObjectId(chatId)) {
    return res.status(400).json({ error: 'Invalid chat id' });
  }

  const chat = await Chat.findOne({ _id: chatId, participants: req.session.userId });
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const query = { chat: chatId };
  if (before && mongoose.isValidObjectId(before)) {
    const beforeMsg = await Message.findById(before).select('createdAt');
    if (beforeMsg) query.createdAt = { $lt: beforeMsg.createdAt };
  }

  const messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 30, 100))
    .populate('sender', 'username')
    .lean();

  res.json(messages.reverse().map(serializeMessage));
}

async function searchUsers(req, res) {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const users = await User.find({
    username: { $regex: q, $options: 'i' },
    _id: { $ne: req.session.userId },
  })
    .limit(10)
    .lean();

  res.json(users.map(serializeUser));
}

module.exports = { listChats, createPrivateChat, createGroupChat, getMessages, searchUsers };
