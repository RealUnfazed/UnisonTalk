const User = require('../models/User');
const Chat = require('../models/Chat');
const { serializeUser } = require('../utils/serialize');

// A single flexible endpoint for the whole "Settings" panel rather than
// one route per field — the client only ever sends the fields that
// actually changed (see client/src/controllers/SettingsController.js).
async function updateProfile(req, res) {
  const { displayName, privacyShowLastSeen, privacyDiscoverable, autoDownloadLimitMb } = req.body;
  const update = {};

  if (displayName !== undefined) {
    const trimmed = String(displayName).trim();
    if (trimmed.length > 40) return res.status(400).json({ error: 'Display name is too long (40 characters max)' });
    update.displayName = trimmed || null; // empty clears it, falling back to the username everywhere
  }
  if (privacyShowLastSeen !== undefined) update['privacy.showLastSeen'] = Boolean(privacyShowLastSeen);
  if (privacyDiscoverable !== undefined) update['privacy.discoverable'] = Boolean(privacyDiscoverable);
  if (autoDownloadLimitMb !== undefined) {
    const mb = Number(autoDownloadLimitMb);
    if (!Number.isFinite(mb) || mb < 0 || mb > 100) {
      return res.status(400).json({ error: 'Auto-download limit must be between 0 and 100 MB' });
    }
    update.autoDownloadLimitMb = mb;
  }

  const user = await User.findByIdAndUpdate(req.session.userId, update, { new: true }).select('-password');
  await broadcastUserUpdate(req, user);
  res.json({ user: serializeUser(user, req.session.userId) });
}

async function uploadAvatar(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No image received' });
  const user = await User.findByIdAndUpdate(
    req.session.userId,
    { avatar: `/uploads/avatars/${req.file.filename}` },
    { new: true }
  ).select('-password');
  await broadcastUserUpdate(req, user);
  res.json({ user: serializeUser(user, req.session.userId) });
}

async function removeAvatar(req, res) {
  const user = await User.findByIdAndUpdate(req.session.userId, { avatar: null }, { new: true }).select('-password');
  await broadcastUserUpdate(req, user);
  res.json({ user: serializeUser(user, req.session.userId) });
}

// Tells everyone this person already shares a chat with that something
// about their profile changed — otherwise a new display name or avatar
// wouldn't show up for anyone else until they happened to refresh.
async function broadcastUserUpdate(req, updatedUser) {
  const io = req.app.get('io');
  if (!io) return;

  const chats = await Chat.find({ participants: updatedUser._id }).select('participants');
  const recipientIds = new Set();
  chats.forEach((chat) =>
    chat.participants.forEach((p) => {
      const id = p.toString();
      if (id !== updatedUser._id.toString()) recipientIds.add(id);
    })
  );

  recipientIds.forEach((id) => {
    io.to(`user:${id}`).emit('user-updated', serializeUser(updatedUser, id));
  });
}

module.exports = { updateProfile, uploadAvatar, removeAvatar };
