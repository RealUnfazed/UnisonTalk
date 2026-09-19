const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { serializeChat, serializeMessage, serializeUser } = require('../utils/serialize');
const CHAT_POPULATE = require('../utils/chatPopulate');
const { visibleToMe } = require('../utils/chatVisibility');

async function listChats(req, res) {
  const chats = await Chat.find({ participants: req.session.userId, ...visibleToMe(req.session.userId) })
    .populate(CHAT_POPULATE)
    .sort({ updatedAt: -1 })
    .lean();
  res.json(chats.map((c) => serializeChat(c, req.session.userId)));
}

// Find-or-create a 1:1 chat with another user by username. `isSecret`
// picks which of the two conversation types this is:
//   false (default) -> a Cloud Chat: no key requirements at all, works
//                       immediately, syncs across every device on login.
//   true             -> a Secret Chat: genuinely end-to-end encrypted,
//                       requires the other person to have a Secret Chat
//                       public key on file already (they get one
//                       automatically the first time they open/start one).
//
// Note what this does NOT do: notify the other participant right away.
// They only find out once the first message is actually sent — see the
// "first message" handling in sockets/index.js's send-message handler,
// which is also what brings their socket into this chat's room. Until
// then, this chat exists in the database (so the creator can type into
// it right away) but is invisible to everyone else, including on refresh
// (see utils/chatVisibility.js).
async function createPrivateChat(req, res) {
  try {
    const { username, isSecret } = req.body;
    if (!username) return res.status(400).json({ error: 'username is required' });

    const other = await User.findOne({ username: username.trim() });
    if (!other) return res.status(404).json({ error: 'No user with that username' });
    if (other._id.toString() === req.session.userId) {
      return res.status(400).json({ error: "You can't start a chat with yourself" });
    }
    if (isSecret && !other.publicKey) {
      return res.status(409).json({
        error: `${other.username} hasn't opened a Secret Chat before — ask them to start one with you first, or send a Secret Chat request another way.`,
      });
    }

    let chat = await Chat.findOne({
      isGroup: false,
      isSecret: !!isSecret,
      participants: { $all: [req.session.userId, other._id], $size: 2 },
    }).populate(CHAT_POPULATE);

    let created = false;
    if (!chat) {
      chat = await Chat.create({
        isGroup: false,
        isSecret: !!isSecret,
        participants: [req.session.userId, other._id],
        admin: req.session.userId, // "who created this" — see utils/chatVisibility.js
      });
      chat = await chat.populate(CHAT_POPULATE);
      created = true;
    }

    // No socket notification to `other` here — see the function comment.
    const serialized = serializeChat(chat.toObject(), req.session.userId);
    res.status(created ? 201 : 200).json(serialized);
  } catch (err) {
    console.error('[chat] private chat failed:', err.message);
    res.status(500).json({ error: 'Could not start chat' });
  }
}

// Group chats are always Cloud Chats — there's no single "other party" to
// do a Diffie-Hellman exchange with, so real end-to-end-encrypted group
// messaging needs per-member key distribution (Signal's "sender keys," or
// similar). That's meaningfully more complex and out of scope here; see
// CONTRIBUTING.md's "good first issues" if you'd like to build it.
async function createGroupChat(req, res) {
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
      isSecret: false,
      name: name.trim(),
      participants: Array.from(participantSet),
      admin: req.session.userId,
    });
    chat = await chat.populate(CHAT_POPULATE);

    // Groups notify everyone immediately (unlike private chats — see
    // createPrivateChat above) — this is unaffected by that change since
    // serializeChat's name for a group is just chat.name, not
    // perspective-dependent, so the same serialized object is correct
    // for every recipient.
    const serialized = serializeChat(chat.toObject(), req.session.userId);
    const io = req.app.get('io');
    memberIds.forEach((id) => io.to(`user:${id}`).emit('chat-created', serialized));

    res.status(201).json(serialized);
  } catch (err) {
    console.error('[chat] group chat failed:', err.message);
    res.status(500).json({ error: 'Could not create group' });
  }
}

// Cursor-paginated history, newest page first, returned in chronological
// order. For Cloud Chats this is plain text; for Secret Chats it's
// ciphertext — see models/Message.js. Deliberately not gated by
// visibleToMe() — that's a "should this show in my list" rule, not an
// access-control one; being a real participant (checked below) is what
// actually authorizes reading a chat's messages.
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
