const mongoose = require('mongoose');
const User = require('../models/User');
const { serializeUser } = require('../utils/serialize');

// People I've blocked, for the Settings list.
async function listBlocked(req, res) {
  const me = await User.findById(req.session.userId).select('blocked').lean();
  const users = await User.find({ _id: { $in: (me && me.blocked) || [] } }).lean();
  res.json(users.map((u) => serializeUser(u, req.session.userId)));
}

// What blocking someone does (see README "Blocking"): they can't start a
// chat with you or message you, you don't appear in each other's search,
// and each stops seeing the other's online status in private chats.
// Existing chats and history stay — blocking isn't deleting.
async function block(req, res) {
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'Invalid user id' });
  if (userId === req.session.userId) return res.status(400).json({ error: "You can't block yourself" });
  if (!(await User.exists({ _id: userId }))) return res.status(404).json({ error: 'User not found' });

  const me = await User.findByIdAndUpdate(req.session.userId, { $addToSet: { blocked: userId } }, { new: true }).select('-password');
  res.json({ user: serializeUser(me, req.session.userId) });
}

async function unblock(req, res) {
  const { userId } = req.params;
  if (!mongoose.isValidObjectId(userId)) return res.status(400).json({ error: 'Invalid user id' });
  const me = await User.findByIdAndUpdate(req.session.userId, { $pull: { blocked: userId } }, { new: true }).select('-password');
  res.json({ user: serializeUser(me, req.session.userId) });
}

module.exports = { listBlocked, block, unblock };
