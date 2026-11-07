const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');

describe('blocking & group-invite privacy', () => {
  let ctx, docs, agents;
  const idOf = (name) => String(docs[name]._id);
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(async () => {
    await resetDb();
    docs = {};
    agents = {};
    for (const name of ['alice', 'bob', 'carol', 'dave']) docs[name] = await makeUser(name);
    for (const name of ['alice', 'bob', 'carol', 'dave']) agents[name] = await loginAs(ctx.app, name);
  });

  describe('the block list', () => {
    it('blocks and unblocks, idempotently, and reports the list back', async () => {
      let res = await agents.alice.post(`/api/users/${idOf('bob')}/block`).send({}).expect(200);
      assert.deepEqual(res.body.user.blockedIds, [idOf('bob')]);
      res = await agents.alice.post(`/api/users/${idOf('bob')}/block`).send({}).expect(200);
      assert.deepEqual(res.body.user.blockedIds, [idOf('bob')], 'blocking twice must not duplicate');

      const list = (await agents.alice.get('/api/users/blocked').expect(200)).body;
      assert.deepEqual(list.map((u) => u.username), ['bob']);
      assert.ok(!('blockedIds' in list[0]) && !('email' in list[0]));

      res = await agents.alice.delete(`/api/users/${idOf('bob')}/block`).expect(200);
      assert.deepEqual(res.body.user.blockedIds, []);
      assert.deepEqual((await agents.alice.get('/api/users/blocked').expect(200)).body, []);
    });

    it('rejects blocking yourself, strangers and junk ids', async () => {
      await agents.alice.post(`/api/users/${idOf('alice')}/block`).send({}).expect(400);
      await agents.alice.post(`/api/users/${'0'.repeat(24)}/block`).send({}).expect(404);
      await agents.alice.post('/api/users/not-an-id/block').send({}).expect(400);
      await agents.alice.delete('/api/users/not-an-id/block').expect(400);
    });

    it('is private: the other person is never told, and cannot read your list', async () => {
      await agents.alice.post(`/api/users/${idOf('bob')}/block`).send({}).expect(200);
      const bobsView = (await agents.bob.get('/api/auth/me').expect(200)).body.user;
      assert.deepEqual(bobsView.blockedIds, []);
      assert.deepEqual((await agents.bob.get('/api/users/blocked').expect(200)).body, []);
    });
  });

  describe('effects', () => {
    it('hides people from search in both directions', async () => {
      await agents.alice.post(`/api/users/${idOf('bob')}/block`).send({}).expect(200);
      assert.deepEqual((await agents.alice.get('/api/users/search?q=bob').expect(200)).body, []);
      assert.deepEqual((await agents.bob.get('/api/users/search?q=alice').expect(200)).body, []);
      assert.equal((await agents.carol.get('/api/users/search?q=bob').expect(200)).body.length, 1, 'unrelated people are unaffected');
    });

    it('stops NEW private chats across a block, but leaves existing ones openable', async () => {
      const existing = await agents.alice.post('/api/chats/private').send({ username: 'bob' }).expect(201);
      await agents.alice.post(`/api/users/${idOf('bob')}/block`).send({}).expect(200);
      const reopened = await agents.alice.post('/api/chats/private').send({ username: 'bob' }).expect(200);
      assert.equal(reopened.body.id, existing.body.id, 'history stays reachable');

      await agents.alice.post(`/api/users/${idOf('carol')}/block`).send({}).expect(200);
      const mine = await agents.alice.post('/api/chats/private').send({ username: 'carol' }).expect(403);
      assert.match(mine.body.error, /You blocked/);

      await agents.dave.post(`/api/users/${idOf('alice')}/block`).send({}).expect(200);
      const theirs = await agents.alice.post('/api/chats/private').send({ username: 'dave' }).expect(403);
      assert.match(theirs.body.error, /can't message/);
      assert.equal(await Chat.countDocuments(), 1, 'no chat is created across a block');
    });

    it("hides online status from someone who blocked you", async () => {
      await User.updateMany({}, { isOnline: true });
      await Chat.create({ isGroup: false, participants: [docs.alice._id, docs.bob._id], admin: docs.alice._id });
      await Chat.create({ isGroup: false, participants: [docs.alice._id, docs.carol._id], admin: docs.alice._id });
      await agents.bob.post(`/api/users/${idOf('alice')}/block`).send({}).expect(200);

      const list = (await agents.alice.get('/api/chats').expect(200)).body;
      const presence = (name) => list.flatMap((c) => c.participants).find((p) => p.username === name);
      assert.equal(presence('bob').isOnline, false);
      assert.equal(presence('bob').lastSeen, null);
      assert.equal(presence('carol').isOnline, true, 'control: someone who did not block alice');
    });
  });

  describe('who can add me to groups', () => {
    it('is a self-only setting that persists and validates', async () => {
      const res = await agents.alice.patch('/api/users/me').send({ privacyGroupInvites: false }).expect(200);
      assert.equal(res.body.user.privacy.groupInvites, false);
      await agents.alice.patch('/api/users/me').send({ privacyGroupInvites: 'false' }).expect(400);
      assert.equal((await agents.alice.get('/api/auth/me').expect(200)).body.user.privacy.groupInvites, false);
    });

    it('group creation skips blocked / blocking / invite-refusing people and says why', async () => {
      await agents.alice.post(`/api/users/${idOf('bob')}/block`).send({}).expect(200);
      await User.updateOne({ _id: docs.carol._id }, { 'privacy.groupInvites': false });
      await agents.dave.post(`/api/users/${idOf('alice')}/block`).send({}).expect(200);
      await makeUser('erin');

      const res = await agents.alice.post('/api/chats/group').send({ name: 'Mixed', usernames: ['bob', 'carol', 'dave', 'erin'] }).expect(201);
      assert.deepEqual(res.body.participants.map((p) => p.username).sort(), ['alice', 'erin']);
      const reason = (n) => res.body.skipped.find((s) => s.username === n).reason;
      assert.equal(reason('bob'), 'blocked');
      assert.equal(reason('carol'), 'privacy');
      assert.equal(reason('dave'), 'privacy', 'indistinguishable from "accepts no invites"');

      const none = await agents.alice.post('/api/chats/group').send({ name: 'Nobody', usernames: ['bob', 'carol'] }).expect(400);
      assert.equal(none.body.skipped.length, 2);
    });
  });
});
