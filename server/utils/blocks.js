const User = require('../models/User');

// Who has blocked whom between two accounts. Blocking is one-directional
// (you block them), but for MESSAGING either direction stops delivery.
async function blockStatus(userId, otherId) {
  const [iBlocked, theyBlocked] = await Promise.all([
    User.exists({ _id: userId, blocked: otherId }),
    User.exists({ _id: otherId, blocked: userId }),
  ]);
  return { iBlocked: Boolean(iBlocked), theyBlocked: Boolean(theyBlocked) };
}

async function blockedBetween(userId, otherId) {
  const { iBlocked, theyBlocked } = await blockStatus(userId, otherId);
  return iBlocked || theyBlocked;
}

// Of these chat rooms, drop the private chats whose other participant has a
// block with `userId` in either direction — so presence ("online") isn't
// broadcast into a conversation with someone who's blocked (or blocked by)
// this person. Group rooms are kept: one room can't hide an event from a
// single member, so blocked people in a shared group still see presence.
async function presentableRooms(userId, rooms, Chat) {
  if (!rooms.length) return rooms;
  const privateChats = await Chat.find({ _id: { $in: rooms }, isGroup: false }).select('participants').lean();
  const otherByRoom = new Map();
  for (const chat of privateChats) {
    const other = chat.participants.find((p) => p.toString() !== String(userId));
    if (other) otherByRoom.set(String(chat._id), other);
  }
  if (!otherByRoom.size) return rooms;

  const involved = await User.find({ _id: { $in: [userId, ...otherByRoom.values()] } }).select('blocked').lean();
  const blockedBy = new Map(involved.map((u) => [String(u._id), new Set((u.blocked || []).map(String))]));
  const mine = blockedBy.get(String(userId)) || new Set();

  return rooms.filter((room) => {
    const other = otherByRoom.get(room);
    if (!other) return true;
    const theirs = blockedBy.get(String(other)) || new Set();
    return !mine.has(String(other)) && !theirs.has(String(userId));
  });
}

module.exports = { blockStatus, blockedBetween, presentableRooms };
