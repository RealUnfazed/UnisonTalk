const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');
const { encryptField } = require('../../server/utils/fieldCrypto');

const UPLOADS = path.join(__dirname, '../../server/uploads');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ago = (ms) => new Date(Date.now() - ms);
const enc = (text) => {
  const e = encryptField(text);
  return { content: e.ciphertext, contentIv: e.iv };
};

describe('messages: unread, read receipts, edit, delete, reply', () => {
  let ctx, alice, bob, aliceDoc, bobDoc, chat;
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(async () => {
    await resetDb();
    ctx.emitted.length = 0;
    aliceDoc = await makeUser('alice');
    bobDoc = await makeUser('bob');
    alice = await loginAs(ctx.app, 'alice');
    bob = await loginAs(ctx.app, 'bob');
    chat = await Chat.create({ isGroup: false, participants: [aliceDoc._id, bobDoc._id], admin: aliceDoc._id });
  });

  // A Cloud message stored the way the socket path stores it (encrypted at
  // rest), made the chat's last message so it's visible to both people.
  async function say(sender, text, extra = {}) {
    const m = await Message.create({ chat: chat._id, sender: sender._id, ...enc(text), ...extra });
    await Chat.updateOne({ _id: chat._id }, { lastMessage: m._id }, { timestamps: false });
    return m;
  }
  const chatsFor = async (agent) => (await agent.get('/api/chats').expect(200)).body;
  const read = (agent) => agent.post(`/api/chats/${chat._id}/read`);
  const history = async (agent) => (await agent.get(`/api/chats/${chat._id}/messages`).expect(200)).body;

  describe('unread counts', () => {
    it("count others' newer messages, ignoring my own and deleted ones", async () => {
      await say(aliceDoc, 'one');
      await say(aliceDoc, 'two');
      await say(aliceDoc, 'gone', { deletedAt: new Date() });
      await say(bobDoc, 'mine');
      assert.equal((await chatsFor(bob))[0].unreadCount, 2);
      assert.equal((await chatsFor(alice))[0].unreadCount, 1);
    });

    it('reading clears the badge without bumping the chat up the list', async () => {
      await say(aliceDoc, 'hi');
      const before = (await Chat.findById(chat._id)).updatedAt.getTime();
      await read(bob).expect(204);
      assert.equal((await chatsFor(bob))[0].unreadCount, 0);
      assert.equal((await Chat.findById(chat._id)).updatedAt.getTime(), before);
    });

    it('messages arriving after reading count again', async () => {
      await say(aliceDoc, 'old');
      await read(bob).expect(204);
      await sleep(25);
      await say(aliceDoc, 'new');
      assert.equal((await chatsFor(bob))[0].unreadCount, 1);
    });

    it('cannot be marked by outsiders or with bad ids', async () => {
      await makeUser('mallory');
      const mallory = await loginAs(ctx.app, 'mallory');
      await read(mallory).expect(404);
      await bob.post('/api/chats/not-an-id/read').expect(400);
    });
  });

  describe('read receipts', () => {
    it('tell the sender when the other person has read, and broadcast it to the chat', async () => {
      await say(aliceDoc, 'hi');
      await read(bob).expect(204);
      assert.ok((await chatsFor(alice))[0].readBy[String(bobDoc._id)]);
      const event = ctx.emitted.find((e) => e.event === 'chat-read');
      assert.equal(event.room, String(chat._id));
      assert.equal(event.payload.userId, String(bobDoc._id));
    });

    it('stay hidden when the reader turned them off — while their own unread count still works', async () => {
      await User.updateOne({ _id: bobDoc._id }, { 'privacy.readReceipts': false });
      await say(aliceDoc, 'hi');
      await read(bob).expect(204);
      assert.deepEqual((await chatsFor(alice))[0].readBy, {});
      assert.equal(ctx.emitted.filter((e) => e.event === 'chat-read').length, 0);
      assert.equal((await chatsFor(bob))[0].unreadCount, 0);
    });

    it('turning receipts off later also hides reads recorded earlier', async () => {
      await say(aliceDoc, 'hi');
      await read(bob).expect(204);
      await bob.patch('/api/users/me').send({ privacyReadReceipts: false }).expect(200);
      assert.deepEqual((await chatsFor(alice))[0].readBy, {});
    });
  });

  describe('editing', () => {
    it('updates a Cloud message, keeps it encrypted at rest, and tells the room', async () => {
      const m = await say(aliceDoc, 'typo here');
      const res = await alice.patch(`/api/messages/${m._id}`).send({ content: '  fixed text  ' }).expect(200);
      assert.equal(res.body.content, 'fixed text');
      assert.equal(res.body.deleted, false);
      assert.ok(res.body.editedAt);

      const raw = await Message.findById(m._id).lean();
      assert.ok(raw.contentIv);
      assert.ok(!JSON.stringify(raw).includes('fixed text'), 'must stay encrypted at rest');

      const event = ctx.emitted.find((e) => e.event === 'message-edited');
      assert.equal(event.room, String(chat._id));
      assert.equal(event.payload.id, String(m._id));
    });

    it('is limited to the author, to live messages, and to members of the chat', async () => {
      await makeUser('mallory');
      const mallory = await loginAs(ctx.app, 'mallory');
      const m = await say(aliceDoc, 'mine');
      await bob.patch(`/api/messages/${m._id}`).send({ content: 'hijack' }).expect(403);
      await mallory.patch(`/api/messages/${m._id}`).send({ content: 'hijack' }).expect(404);
      const gone = await say(aliceDoc, 'deleted', { deletedAt: new Date() });
      await alice.patch(`/api/messages/${gone._id}`).send({ content: 'zombie' }).expect(404);
      await alice.patch('/api/messages/not-an-id').send({ content: 'x' }).expect(400);
      assert.equal(ctx.emitted.filter((e) => e.event === 'message-edited').length, 0);
    });

    it('closes after 48 hours', async () => {
      const m = await say(aliceDoc, 'ancient', { createdAt: ago(49 * 3600_000) });
      await alice.patch(`/api/messages/${m._id}`).send({ content: 'too late' }).expect(400);
    });

    it('validates the new text', async () => {
      const m = await say(aliceDoc, 'original');
      for (const body of [{}, { content: '' }, { content: '   ' }, { content: { $ne: 1 } }, { content: 42 }, { content: 'x'.repeat(4001) }]) {
        await alice.patch(`/api/messages/${m._id}`).send(body).expect(400);
      }
    });

    it('takes fresh ciphertext — never plaintext — in a Secret Chat', async () => {
      const secret = await Chat.create({ isGroup: false, isSecret: true, participants: [aliceDoc._id, bobDoc._id], admin: aliceDoc._id });
      const m = await Message.create({ chat: secret._id, sender: aliceDoc._id, ciphertext: 'old', iv: 'oldiv' });
      await alice.patch(`/api/messages/${m._id}`).send({ content: 'plain text' }).expect(400);
      const res = await alice.patch(`/api/messages/${m._id}`).send({ ciphertext: 'newciphertext', iv: 'newiv' }).expect(200);
      assert.equal(res.body.ciphertext, 'newciphertext');
      const raw = await Message.findById(m._id).lean();
      assert.equal(raw.ciphertext, 'newciphertext');
      assert.ok(!raw.content);
    });
  });

  describe('deleting', () => {
    it('erases the content, keeps a placeholder, and tells the room', async () => {
      const m = await say(aliceDoc, 'delete me', { editedAt: new Date() });
      const res = await alice.delete(`/api/messages/${m._id}`).expect(200);
      assert.equal(res.body.deleted, true);

      const raw = await Message.findById(m._id).lean();
      assert.ok(raw.deletedAt);
      for (const field of ['content', 'contentIv', 'ciphertext', 'iv', 'attachment', 'replyTo', 'editedAt']) {
        assert.ok(!(field in raw), `${field} should be removed`);
      }

      const shown = (await history(bob))[0];
      assert.equal(shown.deleted, true);
      assert.equal(shown.content, null);
      const event = ctx.emitted.find((e) => e.event === 'message-deleted');
      assert.equal(event.room, String(chat._id));
      assert.equal(event.payload.deleted, true);
    });

    it('also removes the attachment file from disk', async () => {
      const name = `del-${crypto.randomBytes(6).toString('hex')}.bin`;
      const file = path.join(UPLOADS, name);
      fs.writeFileSync(file, 'x');
      try {
        const m = await say(aliceDoc, 'with file', { attachment: { url: `/uploads/${name}`, filename: 'a', mimeType: 'text/plain' } });
        await alice.delete(`/api/messages/${m._id}`).expect(200);
        await sleep(150);
        assert.ok(!fs.existsSync(file));
      } finally {
        fs.rmSync(file, { force: true });
      }
    });

    it('follows the rules: author always, others not (private), outsiders see nothing, once only', async () => {
      await makeUser('mallory');
      const mallory = await loginAs(ctx.app, 'mallory');
      const m = await say(aliceDoc, 'mine');
      await bob.delete(`/api/messages/${m._id}`).expect(403);
      await mallory.delete(`/api/messages/${m._id}`).expect(404);
      await alice.delete(`/api/messages/${m._id}`).expect(200);
      await alice.delete(`/api/messages/${m._id}`).expect(404);
    });

    it("lets a group's creator delete anyone's message, but not other members", async () => {
      const carolDoc = await makeUser('carol');
      const carol = await loginAs(ctx.app, 'carol');
      const group = await Chat.create({ isGroup: true, name: 'G', participants: [aliceDoc._id, bobDoc._id, carolDoc._id], admin: aliceDoc._id });
      const m = await Message.create({ chat: group._id, sender: bobDoc._id, ...enc('bob says') });
      await carol.delete(`/api/messages/${m._id}`).expect(403);
      await alice.delete(`/api/messages/${m._id}`).expect(200);
    });
  });

  describe('replies', () => {
    it('come back with a decrypted quote of the original', async () => {
      const original = await say(aliceDoc, 'What time is the meeting?');
      await say(bobDoc, '3pm', { replyTo: original._id });
      const reply = (await history(alice)).find((m) => m.replyTo);
      assert.equal(reply.replyTo.content, 'What time is the meeting?');
      assert.equal(reply.replyTo.sender.username, 'alice');
      assert.equal(reply.replyTo.deleted, false);
    });

    it('turn into a placeholder when the original is deleted', async () => {
      const original = await say(aliceDoc, 'sensitive question');
      await say(bobDoc, 'answer', { replyTo: original._id });
      await alice.delete(`/api/messages/${original._id}`).expect(200);
      const reply = (await history(bob)).find((m) => m.content === 'answer');
      assert.equal(reply.replyTo.deleted, true);
      assert.ok(!JSON.stringify(reply).includes('sensitive question'));
    });

    it('carry ciphertext for the browser to decrypt in a Secret Chat', async () => {
      const secret = await Chat.create({ isGroup: false, isSecret: true, participants: [aliceDoc._id, bobDoc._id], admin: aliceDoc._id });
      const original = await Message.create({ chat: secret._id, sender: aliceDoc._id, ciphertext: 'orig-ct', iv: 'orig-iv' });
      const reply = await Message.create({ chat: secret._id, sender: bobDoc._id, ciphertext: 'rep-ct', iv: 'rep-iv', replyTo: original._id });
      await Chat.updateOne({ _id: secret._id }, { lastMessage: reply._id }, { timestamps: false });
      const shown = (await bob.get(`/api/chats/${secret._id}/messages`).expect(200)).body.find((m) => m.replyTo);
      assert.equal(shown.replyTo.ciphertext, 'orig-ct');
      assert.equal(shown.replyTo.content, null);
    });
  });
});
