const express = require('express');
const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { serializeChat, serializeMessage, serializeUser } = require('../utils/serialize');

const router = express.Router();

const CHAT_POPULATE = [
  { path: 'participants', select: 'username isOnline lastSeen' },
  { path: 'lastMessage', populate: { path: 'sender', select: 'username' } },
];

// ---- Page ---------------------------------------------------------------

router.get('/chat', requireAuth, async (req, res) => {
  const chats = await Chat.find({ participants: req.session.userId })
    .populate(CHAT_POPULATE)
    .sort({ updatedAt: -1 })
    .lean();

  const serialized = chats.map((c) => serializeChat(c, req.session.userId));
  res.render('chat/index', { initialChats: serialized });
});

// ---- Chats ----------------------------------------------------------------

router.get('/api/chats', requireAuth, async (req, res) => {
  const chats = await Chat.find({ participants: req.session.userId })
    .populate(CHAT_POPULATE)
    .sort({ updatedAt: -1 })
    .lean();
  res.json(chats.map((c) => serializeChat(c, req.session.userId)));
});

// Find-or-create a 1:1 chat with another user by username.
router.post('/api/chats/private', requireAuth, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const other = await User.findOne({ username: username.trim() });
    if (!other) return res.status(404).json({ error: 'No user with that username' });
    if (other._id.toString() === req.session.userId) {
      return res.status(400).json({ error: "You can't start a chat with yourself" });
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
});

// Create a group chat with a name and a list of member usernames.
router.post('/api/chats/group', requireAuth, async (req, res) => {
  try {
    const { name, usernames } = req.body;
    if (!name || !Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: 'name and at least one member are required' });
    }

    const members = await User.find({ username: { $in: usernames } });
    const memberIds = members.map((m) => m._id);
    const participantSet = new Set([req.session.userId, ...memberIds.map((id) => id.toString())]);

    if (participantSet.size < 2) {
      return res.status(400).json({ error: 'Add at least one other valid member' });
    }

    let chat = await Chat.create({
      isGroup: true,
      name: name.trim(),
      participants: Array.from(participantSet),
      admin: req.session.userId,
    });
    chat = await chat.populate(CHAT_POPULATE);
    const serialized = serializeChat(chat.toObject(), req.session.userId);

    const io = req.app.get('io');
    memberIds.forEach((id) => io.to(`user:${id}`).emit('chat-created', serialized));

    res.status(201).json(serialized);
  } catch (err) {
    console.error('[chat] group chat failed:', err.message);
    res.status(500).json({ error: 'Could not create group' });
  }
});

// ---- Messages ---------------------------------------------------------------

// Cursor-paginated history, newest page first, returned in chronological order.
router.get('/api/chats/:chatId/messages', requireAuth, async (req, res) => {
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
});

// ---- Users ---------------------------------------------------------------

router.get('/api/users/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const users = await User.find({
    username: { $regex: q, $options: 'i' },
    _id: { $ne: req.session.userId },
  })
    .limit(10)
    .lean();

  res.json(users.map(serializeUser));
});

// ---- Uploads ---------------------------------------------------------------

router.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });

  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimeType: req.file.mimetype,
    isImage: req.file.mimetype.startsWith('image/'),
  });
});

module.exports = router;
