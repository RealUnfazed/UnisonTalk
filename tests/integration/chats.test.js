const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const removeUpload = (urlPath) => fs.rmSync(path.join(__dirname, '../../server', urlPath), { force: true });

describe('chats', () => {
  let ctx, alice, bob;
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(async () => {
    await resetDb();
    await makeUser('alice');
    await makeUser('bob');
    alice = await loginAs(ctx.app, 'alice');
    bob = await loginAs(ctx.app, 'bob');
  });

  describe('private chats', () => {
    it('stay hidden from the other person until the first message, then show THEIR view of the name', async () => {
      const created = await alice.post('/api/chats/private').send({ username: 'bob' }).expect(201);
      assert.equal(created.body.name, 'bob'); // creator sees the other person's name
      const chatId = created.body.id;

      assert.equal((await alice.get('/api/chats').expect(200)).body.length, 1); // creator can use it right away
      assert.equal((await bob.get('/api/chats').expect(200)).body.length, 0); // recipient can't see it yet

      // Simulate the first message (the socket handler sets lastMessage).
      const aliceDoc = await User.findOne({ username: 'alice' });
      const msg = await Message.create({ chat: chatId, sender: aliceDoc._id });
      await Chat.findByIdAndUpdate(chatId, { lastMessage: msg._id });

      const bobList = (await bob.get('/api/chats').expect(200)).body;
      assert.equal(bobList.length, 1);
      assert.equal(bobList[0].name, 'alice', 'bob must see alice — not his own name');
    });

    it('finds the existing chat instead of creating duplicates', async () => {
      const a = await alice.post('/api/chats/private').send({ username: 'bob' }).expect(201);
      const b = await alice.post('/api/chats/private').send({ username: 'bob' }).expect(200);
      assert.equal(a.body.id, b.body.id);
      assert.equal(await Chat.countDocuments(), 1);
    });

    it('rejects self-chats and unknown users', async () => {
      await alice.post('/api/chats/private').send({ username: 'alice' }).expect(400);
      await alice.post('/api/chats/private').send({ username: 'ghost' }).expect(404);
    });

    it('requires the other person to have a public key for a Secret Chat', async () => {
      await alice.post('/api/chats/private').send({ username: 'bob', isSecret: true }).expect(409);
      await User.updateOne({ username: 'bob' }, { publicKey: 'abc' });
      const res = await alice.post('/api/chats/private').send({ username: 'bob', isSecret: true }).expect(201);
      assert.equal(res.body.isSecret, true);
    });

    it("does not let non-participants read a chat's messages", async () => {
      await makeUser('mallory');
      const mallory = await loginAs(ctx.app, 'mallory');
      const { body } = await alice.post('/api/chats/private').send({ username: 'bob' }).expect(201);
      await mallory.get(`/api/chats/${body.id}/messages`).expect(404);
    });
  });

  describe('groups', () => {
    let groupId;
    beforeEach(async () => {
      const res = await alice.post('/api/chats/group').send({ name: 'Team', usernames: ['bob'] }).expect(201);
      groupId = res.body.id;
    });

    it('show up for members immediately, with the creator as admin', async () => {
      const list = (await bob.get('/api/chats').expect(200)).body;
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'Team');
      assert.equal(list[0].isGroup, true);
    });

    it('can be edited by the creator', async () => {
      const res = await alice.patch(`/api/chats/${groupId}`).send({ name: 'Renamed', description: 'About us' }).expect(200);
      assert.equal(res.body.name, 'Renamed');
      assert.equal(res.body.description, 'About us');
      const seenByBob = (await bob.get('/api/chats').expect(200)).body[0];
      assert.equal(seenByBob.name, 'Renamed');
    });

    it('cannot be edited by other members', async () => {
      await bob.patch(`/api/chats/${groupId}`).send({ name: 'Hijacked' }).expect(403);
      assert.equal((await Chat.findById(groupId)).name, 'Team');
    });

    it('validates name and description', async () => {
      await alice.patch(`/api/chats/${groupId}`).send({ name: '   ' }).expect(400);
      await alice.patch(`/api/chats/${groupId}`).send({ name: 'x'.repeat(41) }).expect(400);
      await alice.patch(`/api/chats/${groupId}`).send({ description: 'x'.repeat(201) }).expect(400);
    });

    it('cannot edit a private chat through the group endpoint', async () => {
      const { body } = await alice.post('/api/chats/private').send({ username: 'bob' }).expect(201);
      await alice.patch(`/api/chats/${body.id}`).send({ name: 'nope' }).expect(400);
    });

    it('accepts a group picture from the creator and rejects non-images', async () => {
      const ok = await alice.post(`/api/chats/${groupId}/avatar`).attach('file', PNG, { filename: 'g.png', contentType: 'image/png' }).expect(200);
      try {
        assert.match(ok.body.avatar, /^\/uploads\/avatars\//);
      } finally {
        removeUpload(ok.body.avatar);
      }
      const bad = await alice.post(`/api/chats/${groupId}/avatar`).attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
      assert.match(bad.body.error, /PNG, JPEG, GIF, or WebP/);
    });
  });
});
