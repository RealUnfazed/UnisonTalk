const mongoose = require('mongoose');
const Chat = require('../models/Chat');
const Message = require('../models/Message');
const User = require('../models/User');
const { serializeChat } = require('../utils/serialize');
const { setReadMarker } = require('../utils/readState');
const CHAT_POPULATE = require('../utils/chatPopulate');

const MAX_MEMBERS = 100;

// Loads a group the caller belongs to (404 otherwise, so ids can't be
// probed), optionally requiring them to be its creator.
async function loadGroup(req, res, { adminOnly }) {
  const { chatId } = req.params;
  if (!mongoose.isValidObjectId(chatId)) {
    res.status(400).json({ error: 'Invalid chat id' });
    return null;
  }
  const chat = await Chat.findOne({ _id: chatId, participants: req.session.userId });
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return null;
  }
  if (!chat.isGroup) {
    res.status(400).json({ error: 'Only groups have members to manage' });
    return null;
  }
  if (adminOnly && (!chat.admin || chat.admin.toString() !== req.session.userId)) {
    res.status(403).json({ error: 'Only the group creator can do that' });
    return null;
  }
  return chat;
}

// Reload (so `reads` is current), populate, and tell everyone but the
// caller. `eventFor(userId)` picks the event per recipient: newly added
// members get 'chat-created' (the client adds the chat); existing ones get
// 'chat-updated'. Each recipient gets THEIR OWN serialization.
async function broadcast(req, chatId, eventFor) {
  const fresh = await Chat.findById(chatId);
  await fresh.populate(CHAT_POPULATE);
  const chatObj = fresh.toObject();
  const io = req.app.get('io');
  for (const p of fresh.participants) {
    const id = p._id.toString();
    if (id === req.session.userId) continue;
    io.to(`user:${id}`).emit(eventFor(id), serializeChat(chatObj, id));
  }
  return serializeChat(chatObj, req.session.userId);
}

async function addMembers(req, res) {
  const chat = await loadGroup(req, res, { adminOnly: true });
  if (!chat) return;

  const { usernames } = req.body;
  if (!Array.isArray(usernames) || usernames.length === 0 || usernames.length > 50 || !usernames.every((u) => typeof u === 'string')) {
    return res.status(400).json({ error: 'usernames must be a non-empty list of names' });
  }
  const names = [...new Set(usernames.map((u) => u.trim()).filter(Boolean))];

  const [users, me] = await Promise.all([
    User.find({ username: { $in: names } }).select('username blocked privacy.groupInvites'),
    User.findById(req.session.userId).select('blocked').lean(),
  ]);
  const iBlocked = new Set(((me && me.blocked) || []).map(String));
  const members = new Set(chat.participants.map(String));
  const known = new Set(users.map((u) => u.username));

  const added = [];
  const skipped = names.filter((n) => !known.has(n)).map((username) => ({ username, reason: 'not_found' }));
  for (const u of users) {
    const id = u._id.toString();
    if (members.has(id)) skipped.push({ username: u.username, reason: 'already_member' });
    else if (iBlocked.has(id)) skipped.push({ username: u.username, reason: 'blocked' });
    // "They blocked you" and "they don't accept group invites" share one
    // reason, so this response can't be used to find out who blocked you.
    else if (u.privacy?.groupInvites === false || (u.blocked || []).some((b) => b.toString() === req.session.userId)) {
      skipped.push({ username: u.username, reason: 'privacy' });
    } else added.push(u);
  }

  if (chat.participants.length + added.length > MAX_MEMBERS) {
    return res.status(400).json({ error: `Groups are limited to ${MAX_MEMBERS} members` });
  }
  if (added.length === 0) {
    const why = { not_found: 'no such user', already_member: 'already in the group', blocked: 'you blocked them', privacy: 'their privacy settings' };
    return res.status(400).json({ error: `No one could be added — ${skipped.map((s) => `${s.username} (${why[s.reason]})`).join(', ')}`, skipped });
  }

  chat.participants.push(...added.map((u) => u._id));
  await chat.save();
  // New members start "caught up": history is readable, but only messages
  // from now on count as unread.
  const now = new Date();
  await Promise.all(added.map((u) => setReadMarker(chat._id, u._id, now)));

  const io = req.app.get('io');
  const addedIds = new Set(added.map((u) => u._id.toString()));
  addedIds.forEach((id) => io.in(`user:${id}`).socketsJoin(String(chat._id))); // live messages start immediately
  const serialized = await broadcast(req, chat._id, (id) => (addedIds.has(id) ? 'chat-created' : 'chat-updated'));
  res.json({ chat: serialized, added: added.map((u) => u.username), skipped });
}

async function removeMember(req, res) {
  const chat = await loadGroup(req, res, { adminOnly: true });
  if (!chat) return;

  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (userId === req.session.userId) return res.status(400).json({ error: 'Use "Leave group" to leave a group you created' });
  if (!chat.participants.some((p) => p.toString() === userId)) {
    return res.status(404).json({ error: 'That person is not in this group' });
  }

  chat.participants = chat.participants.filter((p) => p.toString() !== userId);
  chat.reads = (chat.reads || []).filter((r) => r.user.toString() !== userId);
  await chat.save();

  const io = req.app.get('io');
  io.in(`user:${userId}`).socketsLeave(String(chat._id)); // stop their live messages at once
  io.to(`user:${userId}`).emit('chat-removed', { chatId: String(chat._id) });
  const serialized = await broadcast(req, chat._id, () => 'chat-updated');
  res.json({ chat: serialized });
}

// Anyone can leave. If the creator leaves, the longest-standing remaining
// member inherits the group; if nobody is left, the group is deleted.
async function leaveGroup(req, res) {
  const chat = await loadGroup(req, res, { adminOnly: false });
  if (!chat) return;

  const me = req.session.userId;
  const remaining = chat.participants.filter((p) => p.toString() !== me);
  const io = req.app.get('io');
  io.in(`user:${me}`).socketsLeave(String(chat._id));
  io.to(`user:${me}`).emit('chat-removed', { chatId: String(chat._id) }); // other sessions of mine drop it too

  if (remaining.length === 0) {
    await Message.deleteMany({ chat: chat._id }); // attachment files are swept up as orphans
    await Chat.deleteOne({ _id: chat._id });
    return res.json({ ok: true });
  }

  chat.participants = remaining;
  chat.reads = (chat.reads || []).filter((r) => r.user.toString() !== me);
  if (chat.admin && chat.admin.toString() === me) chat.admin = remaining[0];
  await chat.save();
  await broadcast(req, chat._id, () => 'chat-updated');
  res.json({ ok: true });
}

async function transferOwnership(req, res) {
  const chat = await loadGroup(req, res, { adminOnly: true });
  if (!chat) return;

  const { userId } = req.body;
  if (typeof userId !== 'string' || !mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'userId is required' });
  if (userId === req.session.userId) return res.status(400).json({ error: 'You already own this group' });
  if (!chat.participants.some((p) => p.toString() === userId)) {
    return res.status(400).json({ error: 'The new owner must be a member of the group' });
  }

  chat.admin = userId;
  await chat.save();
  const serialized = await broadcast(req, chat._id, () => 'chat-updated');
  res.json({ chat: serialized });
}

module.exports = { addMembers, removeMember, leaveGroup, transferOwnership };
