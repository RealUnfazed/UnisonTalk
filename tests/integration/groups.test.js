const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');
const { encryptField } = require('../../server/utils/fieldCrypto');

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin'];

describe('group management', () => {
  let ctx, docs, agents, groupId;
  const idOf = (name) => String(docs[name]._id);
  const to = (event, name) => ctx.emitted.find((e) => e.event === event && e.room === `user:${idOf(name)}`);

  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(async () => {
    await resetDb();
    docs = {};
    agents = {};
    for (const name of NAMES) docs[name] = await makeUser(name);
    for (const name of NAMES) agents[name] = await loginAs(ctx.app, name);
    groupId = (await agents.alice.post('/api/chats/group').send({ name: 'G', usernames: ['bob'] }).expect(201)).body.id;
    ctx.emitted.length = 0; // ignore the creation events
  });

  describe('adding members', () => {
    it('creator adds people: newcomers get chat-created, existing members chat-updated, everyone sees THEIR view', async () => {
      const e = encryptField('history before carol joined');
      await Message.create({ chat: groupId, sender: docs.alice._id, content: e.ciphertext, contentIv: e.iv });

      const res = await agents.alice.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol', 'ghost', 'bob'] }).expect(200);
      assert.deepEqual(res.body.added, ['carol']);
      assert.deepEqual(
        res.body.skipped.sort((a, b) => a.username.localeCompare(b.username)),
        [{ username: 'bob', reason: 'already_member' }, { username: 'ghost', reason: 'not_found' }]
      );
      assert.equal(res.body.chat.participants.length, 3);

      assert.equal(to('chat-created', 'carol').payload.name, 'G');
      assert.ok(to('chat-updated', 'bob'));
      assert.ok(!ctx.emitted.some((ev) => ev.room === `user:${idOf('alice')}`), 'the actor is answered by the HTTP response, not an event');

      // New members are "caught up": history is readable but isn't a pile of unread.
      const carolList = (await agents.carol.get('/api/chats').expect(200)).body;
      assert.equal(carolList[0].unreadCount, 0);
      assert.equal((await agents.carol.get(`/api/chats/${groupId}/messages`).expect(200)).body.length, 1);
    });

    it('skips people who blocked you, accept no invites, or whom you blocked — without revealing who blocked you', async () => {
      await User.updateOne({ _id: docs.carol._id }, { 'privacy.groupInvites': false });
      await User.updateOne({ _id: docs.dave._id }, { $addToSet: { blocked: docs.alice._id } });
      await User.updateOne({ _id: docs.alice._id }, { $addToSet: { blocked: docs.erin._id } });

      const res = await agents.alice.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol', 'dave', 'erin'] }).expect(400);
      const reason = (name) => res.body.skipped.find((s) => s.username === name).reason;
      assert.equal(reason('carol'), 'privacy');
      assert.equal(reason('dave'), 'privacy', '"dave blocked you" must look the same as "dave accepts no invites"');
      assert.equal(reason('erin'), 'blocked');
      assert.match(res.body.error, /No one could be added/);
      assert.equal((await Chat.findById(groupId)).participants.length, 2);
    });

    it('is creator-only, group-only, member-only, and validates its input', async () => {
      await agents.bob.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol'] }).expect(403);
      await agents.carol.post(`/api/chats/${groupId}/members`).send({ usernames: ['dave'] }).expect(404);
      for (const usernames of [undefined, [], 'carol', [{ $ne: 1 }], Array.from({ length: 51 }, (_, i) => `u${i}`)]) {
        await agents.alice.post(`/api/chats/${groupId}/members`).send({ usernames }).expect(400);
      }
      const dm = await Chat.create({ isGroup: false, participants: [docs.alice._id, docs.bob._id], admin: docs.alice._id });
      await agents.alice.post(`/api/chats/${dm._id}/members`).send({ usernames: ['carol'] }).expect(400);
      await agents.alice.post('/api/chats/not-an-id/members').send({ usernames: ['carol'] }).expect(400);
    });

    it('stops at 100 members', async () => {
      const crowd = Array.from({ length: 99 }, () => new mongoose.Types.ObjectId());
      await Chat.updateOne({ _id: groupId }, { participants: [docs.alice._id, ...crowd] });
      await agents.alice.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol'] }).expect(400);
    });
  });

  describe('removing members', () => {
    it('removes them everywhere: list, history access, read marker — and tells them', async () => {
      await agents.alice.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol'] }).expect(200);
      ctx.emitted.length = 0;

      const res = await agents.alice.delete(`/api/chats/${groupId}/members/${idOf('bob')}`).expect(200);
      assert.equal(res.body.chat.participants.length, 2);

      const stored = await Chat.findById(groupId).lean();
      assert.ok(!stored.participants.some((p) => String(p) === idOf('bob')));
      assert.ok(!(stored.reads || []).some((r) => String(r.user) === idOf('bob')));
      assert.equal(to('chat-removed', 'bob').payload.chatId, groupId);
      assert.ok(to('chat-updated', 'carol'));

      assert.equal((await agents.bob.get('/api/chats').expect(200)).body.length, 0);
      await agents.bob.get(`/api/chats/${groupId}/messages`).expect(404);
    });

    it('is creator-only and refuses nonsense targets', async () => {
      await agents.bob.delete(`/api/chats/${groupId}/members/${idOf('alice')}`).expect(403);
      await agents.alice.delete(`/api/chats/${groupId}/members/${idOf('alice')}`).expect(400); // use Leave instead
      await agents.alice.delete(`/api/chats/${groupId}/members/${idOf('carol')}`).expect(404); // not a member
      await agents.alice.delete(`/api/chats/${groupId}/members/not-an-id`).expect(400);
    });
  });

  describe('leaving', () => {
    it('lets any member go, and tells their other sessions', async () => {
      await agents.bob.post(`/api/chats/${groupId}/leave`).send({}).expect(200);
      assert.equal(to('chat-removed', 'bob').payload.chatId, groupId);
      assert.equal((await Chat.findById(groupId)).participants.length, 1);
      assert.equal((await agents.bob.get('/api/chats').expect(200)).body.length, 0);
    });

    it('passes ownership to the longest-standing member when the creator leaves, and deletes the group when the last one goes', async () => {
      await agents.alice.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol'] }).expect(200);
      await Message.create({ chat: groupId, sender: docs.bob._id, content: 'x' });

      await agents.alice.post(`/api/chats/${groupId}/leave`).send({}).expect(200);
      const after = await Chat.findById(groupId).lean();
      assert.deepEqual(after.participants.map(String), [idOf('bob'), idOf('carol')]);
      assert.equal(String(after.admin), idOf('bob'));
      assert.ok(to('chat-updated', 'bob'));

      await agents.carol.post(`/api/chats/${groupId}/leave`).send({}).expect(200);
      await agents.bob.post(`/api/chats/${groupId}/leave`).send({}).expect(200);
      assert.equal(await Chat.countDocuments(), 0);
      assert.equal(await Message.countDocuments(), 0);
    });

    it('is only for members of real groups', async () => {
      await agents.carol.post(`/api/chats/${groupId}/leave`).send({}).expect(404);
      const dm = await Chat.create({ isGroup: false, participants: [docs.alice._id, docs.bob._id], admin: docs.alice._id });
      await agents.alice.post(`/api/chats/${dm._id}/leave`).send({}).expect(400);
    });
  });

  describe('transferring ownership', () => {
    it('hands the group to another member, who gains — and the old owner loses — control', async () => {
      await agents.alice.post(`/api/chats/${groupId}/transfer`).send({ userId: idOf('bob') }).expect(200);
      assert.equal(String((await Chat.findById(groupId)).admin), idOf('bob'));
      assert.ok(to('chat-updated', 'bob'));
      await agents.alice.patch(`/api/chats/${groupId}`).send({ name: 'Mine still' }).expect(403);
      await agents.bob.patch(`/api/chats/${groupId}`).send({ name: 'Bob now' }).expect(200);
    });

    it('requires a creator, a real id, a different person, and a current member', async () => {
      await agents.bob.post(`/api/chats/${groupId}/transfer`).send({ userId: idOf('bob') }).expect(403);
      await agents.alice.post(`/api/chats/${groupId}/transfer`).send({ userId: idOf('alice') }).expect(400);
      await agents.alice.post(`/api/chats/${groupId}/transfer`).send({ userId: idOf('carol') }).expect(400);
      await agents.alice.post(`/api/chats/${groupId}/transfer`).send({ userId: 'nope' }).expect(400);
      await agents.alice.post(`/api/chats/${groupId}/transfer`).send({}).expect(400);
    });
  });
});
