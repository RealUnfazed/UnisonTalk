// How a Message is loaded for the API: who sent it, and — if it's a reply —
// a preview of what it replies to (sender + enough of the original for the
// client to render a quote; for Secret Chats that's ciphertext the client
// decrypts, since the server can't).
module.exports = [
  { path: 'sender', select: 'username displayName avatar' },
  {
    path: 'replyTo',
    select: 'sender content contentIv ciphertext iv attachment deletedAt',
    populate: { path: 'sender', select: 'username displayName avatar' },
  },
];
