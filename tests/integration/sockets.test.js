// Drives the LIVE message path with real socket.io-client connections — the
// part of the app no REST test can reach.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startTestApp, makeUser, loginAs, loginCookie, resetDb } = require('../helpers/testApp');
const { connectSocket, nextEvent, noEvent, emitAck } = require('../helpers/sockets');
const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');

const UPLOADS = path.join(__dirname, '../../server/uploads');

describe('Socket.IO message path', () => {
  let ctx;
  const open = [];
  before(async () => { ctx = await startTestApp({ sockets: true }); });
  after(async () => { await ctx.stop(); });
  beforeEach(resetDb);
  afterEach(() => open.splice(0).forEach((s) => s.disconnect()));

  // Joining via the ack guarantees the server has finished attaching the
  // socket to the chat's room, so tests don't race the connection handler.
  async function connectAs(username, chatIds = []) {
    const socket = await connectSocket(ctx.url, await loginCookie(ctx.app, username));
    open.push(socket);
    for (const chatId of chatIds) await emitAck(socket, 'join-chat', { chatId });
    return socket;
  }

  async function makeGroup(members = ['bob']) {
    await makeUser('alice');
    for (const name of members) await makeUser(name);
    const alice = await loginAs(ctx.app, 'alice');
    return (await alice.post('/api/chats/group').send({ name: 'G', usernames: members }).expect(201)).body.id;
  }

  it('stores Cloud messages encrypted at rest but delivers plaintext', async () => {
    const chatId = await makeGroup();
    const a = await connectAs('alice', [chatId]);
    const b = await connectAs('bob', [chatId]);
    const arrived = nextEvent(b, 'new-message');
    const ack = await emitAck(a, 'send-message', { chatId, content: 'hello bob' });
    assert.ok(!ack?.error, JSON.stringify(ack));

    const msg = await arrived;
    assert.equal(msg.content, 'hello bob');
    const raw = await Message.findById(msg.id).lean();
    assert.ok(raw.contentIv);
    assert.ok(!JSON.stringify(raw).includes('hello bob'), 'plaintext must not be in the database');

    const aliceDoc = await User.findOne({ username: 'alice' });
    const { reads } = await Chat.findById(chatId).lean();
    assert.ok(reads.some((r) => String(r.user) === String(aliceDoc._id)), "sending marks the sender's own read marker");
  });

  it('reveals a new private chat to the recipient on the first message, named from THEIR side', async () => {
    await makeUser('alice');
    await makeUser('bob');
    const aliceAgent = await loginAs(ctx.app, 'alice');
    const bobAgent = await loginAs(ctx.app, 'bob');
    const { body } = await aliceAgent.post('/api/chats/private').send({ username: 'bob' }).expect(201);
    assert.equal((await bobAgent.get('/api/chats').expect(200)).body.length, 0);

    const a = await connectAs('alice', [body.id]);
    const b = await connectAs('bob');
    const created = nextEvent(b, 'chat-created');
    const arrived = nextEvent(b, 'new-message');
    const ack = await emitAck(a, 'send-message', { chatId: body.id, content: 'hi' });
    assert.ok(!ack?.error, JSON.stringify(ack));

    assert.equal((await created).name, 'alice', 'bob must see alice — not his own name');
    assert.equal((await arrived).content, 'hi');
    const list = (await bobAgent.get('/api/chats').expect(200)).body;
    assert.equal(list.length, 1);
    assert.equal(list[0].unreadCount, 1);
  });

  describe('attachments', () => {
    it('refuses URLs that point outside the uploads folder', async () => {
      const chatId = await makeGroup();
      const a = await connectAs('alice', [chatId]);
      for (const url of ['https://evil.example/pixel.png', '/uploads/../package.json', '//evil.example/x', '/uploads/avatars/x.png']) {
        const ack = await emitAck(a, 'send-message', { chatId, attachment: { url, filename: 'x.png', mimeType: 'image/png' } });
        assert.ok(ack?.error, `should refuse ${url}`);
      }
      const missing = await emitAck(a, 'send-message', { chatId, attachment: { url: '/uploads/nope-does-not-exist.bin', filename: 'x.png', mimeType: 'image/png' } });
      assert.ok(missing?.error);
      assert.equal(await Message.countDocuments(), 0);
    });

    it('stores a valid one from validated fields only, with its filename encrypted', async () => {
      const chatId = await makeGroup();
      const a = await connectAs('alice', [chatId]);
      const b = await connectAs('bob', [chatId]);
      const name = `sock-${crypto.randomBytes(6).toString('hex')}.bin`;
      const file = path.join(UPLOADS, name);
      fs.writeFileSync(file, 'x');
      try {
        const arrived = nextEvent(b, 'new-message');
        const ack = await emitAck(a, 'send-message', { chatId, attachment: { url: `/uploads/${name}`, filename: 'x.png', mimeType: 'image/png', size: 1, isImage: false, evil: '<script>' } });
        assert.ok(!ack?.error, JSON.stringify(ack));

        const msg = await arrived;
        assert.equal(msg.attachment.filename, 'x.png');
        assert.equal(msg.attachment.isImage, true, 'derived from the MIME type, not trusted from the client');
        assert.ok(!('evil' in msg.attachment));
        const raw = await Message.findById(msg.id).lean();
        assert.notEqual(raw.attachment.filename, 'x.png');
        assert.ok(raw.attachment.filenameIv);
        assert.ok(!('evil' in raw.attachment));
      } finally {
        fs.rmSync(file, { force: true });
      }
    });
  });

  it('accepts replies only to live messages in the same chat', async () => {
    const chatId = await makeGroup();
    const aliceAgent = await loginAs(ctx.app, 'alice');
    const otherId = (await aliceAgent.post('/api/chats/group').send({ name: 'Other', usernames: ['bob'] }).expect(201)).body.id;
    const a = await connectAs('alice', [chatId, otherId]);
    const b = await connectAs('bob', [chatId, otherId]);

    const first = nextEvent(b, 'new-message');
    await emitAck(a, 'send-message', { chatId, content: 'question?' });
    const original = await first;

    assert.ok((await emitAck(a, 'send-message', { chatId: otherId, content: 'x', replyTo: original.id })).error, 'cross-chat reply');
    assert.ok((await emitAck(a, 'send-message', { chatId, content: 'x', replyTo: 'nope' })).error, 'junk id');

    const gotReply = nextEvent(a, 'new-message');
    const ack = await emitAck(b, 'send-message', { chatId, content: 'answer', replyTo: original.id });
    assert.ok(!ack?.error, JSON.stringify(ack));
    const reply = await gotReply;
    assert.equal(reply.replyTo.content, 'question?');
    assert.equal(reply.replyTo.sender.username, 'alice');
  });

  it('survives junk payloads of every kind and keeps serving', async () => {
    const chatId = await makeGroup();
    const a = await connectAs('alice', [chatId]);
    const noAck = new Promise((resolve) => setTimeout(() => resolve('no-ack'), 120));
    for (const event of ['join-chat', 'typing', 'stop-typing', 'mark-read', 'send-message']) {
      for (const payload of [null, 42, 'str', [], { chatId: { $ne: 1 } }, { chatId: 'nope' }]) {
        const result = await Promise.race([emitAck(a, event, payload), noAck.then(() => 'no-ack')]);
        assert.ok(result === 'no-ack' || result?.error, `${event} ${JSON.stringify(payload)} -> ${JSON.stringify(result)}`);
      }
    }
    const ack = await emitAck(a, 'send-message', { chatId, content: 'still alive' });
    assert.ok(!ack?.error, 'the server must still be handling messages');
  });

  it('relays typing only within rooms the sender has actually joined', async () => {
    const chatId = await makeGroup();
    await makeUser('mallory');
    const b = await connectAs('bob', [chatId]);
    const mallory = await connectAs('mallory');
    assert.ok((await emitAck(mallory, 'join-chat', { chatId })).error, 'outsiders cannot join');

    const quiet = noEvent(b, 'typing', 400);
    mallory.emit('typing', { chatId });
    await quiet;

    const a = await connectAs('alice', [chatId]);
    const heard = nextEvent(b, 'typing');
    a.emit('typing', { chatId });
    assert.equal((await heard).chatId, chatId);
  });

  it('mark-read stores the marker and notifies the chat — unless the reader turned receipts off', async () => {
    const chatId = await makeGroup();
    const a = await connectAs('alice', [chatId]);
    const b = await connectAs('bob', [chatId]);
    const bobDoc = await User.findOne({ username: 'bob' });

    const told = nextEvent(a, 'chat-read');
    assert.ok(!(await emitAck(b, 'mark-read', { chatId })).error);
    assert.equal((await told).userId, String(bobDoc._id));
    assert.ok((await Chat.findById(chatId).lean()).reads.some((r) => String(r.user) === String(bobDoc._id)));

    await User.updateOne({ _id: bobDoc._id }, { 'privacy.readReceipts': false });
    const quiet = noEvent(a, 'chat-read', 400);
    assert.ok(!(await emitAck(b, 'mark-read', { chatId })).error);
    await quiet;
  });

  it('does not announce presence for people who turned last-seen off', async () => {
    const chatId = await makeGroup(['bob', 'carol', 'dave']);
    await User.updateOne({ username: 'carol' }, { 'privacy.showLastSeen': false });
    const a = await connectAs('alice', [chatId]);
    const carolCookie = await loginCookie(ctx.app, 'carol'); // log in first so the quiet window covers only the connect

    const quiet = noEvent(a, 'user-online', 500);
    open.push(await connectSocket(ctx.url, carolCookie));
    await quiet;

    const announced = nextEvent(a, 'user-online');
    await connectAs('dave');
    assert.equal((await announced).userId, String((await User.findOne({ username: 'dave' }))._id));
  });
});
