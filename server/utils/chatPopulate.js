// Shared population spec for Chat queries — participants need enough
// fields for the client to render (username, presence) and, for Secret
// Chats, their public key; lastMessage needs its sender's username for
// list previews. Used by both controllers/chatController.js and
// sockets/index.js (the latter needs it to build a per-recipient chat
// view when a chat becomes visible on someone's first message — see the
// comment above the "first message" handling in sockets/index.js).
module.exports = [
  { path: 'participants', select: 'username isOnline lastSeen publicKey' },
  { path: 'lastMessage', populate: { path: 'sender', select: 'username' } },
];
