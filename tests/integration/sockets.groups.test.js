// Live-socket behaviour of blocking and group membership.
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, makeUser, loginAs, loginCookie, resetDb } = require('../helpers/testApp');
const { connectSocket, nextEvent, noEvent, emitAck } = require('../helpers/sockets');
const User = require('../../server/models/User');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Socket.IO: blocking & membership', () => {
  let ctx;
  const open = [];
  before(async () => { ctx = await startTestApp({ sockets: true }); });
  after(async () => { await ctx.stop(); });
  beforeEach(resetDb);
  afterEach(() => open.splice(0).forEach((s) => s.disconnect()));

  async function connectAs(username, chatIds = []) {
    const socket = await connectSocket(ctx.url, await loginCookie(ctx.app, username));
    open.push(socket);
    for (const chatId of chatIds) await emitAck(socket, 'join-chat', { chatId });
    return socket;
  }

  it('refuses messages in a private chat across a block — in both directions — until it is lifted', async () => {
    const aliceDoc = await makeUser('alice');
    await makeUser('bob');
    const alice = await loginAs(ctx.app, 'alice');
    const bob = await loginAs(ctx.app, 'bob');
    const { body } = await alice.post('/api/chats/private').send({ username: 'bob' }).expect(201);
    const a = await connectAs('alice', [body.id]);
    const b = await connectAs('bob', [body.id]);

    assert.ok(!(await emitAck(a, 'send-message', { chatId: body.id, content: 'before the block' })).error);

    const bobDoc = await User.findOne({ username: 'bob' });
    await bob.post(`/api/users/${aliceDoc._id}/block`).send({}).expect(200);
    assert.match((await emitAck(a, 'send-message', { chatId: body.id, content: 'blocked' })).error, /can't message/);
    assert.ok((await emitAck(b, 'send-message', { chatId: body.id, content: 'I blocked you' })).error, 'the blocker cannot send either');

    await bob.delete(`/api/users/${aliceDoc._id}/block`).expect(200);
    const arrived = nextEvent(b, 'new-message');
    assert.ok(!(await emitAck(a, 'send-message', { chatId: body.id, content: 'unblocked' })).error);
    assert.equal((await arrived).content, 'unblocked');
    assert.ok(bobDoc);
  });

  it('delivers to newly added members at once, and stops delivering to removed ones', async () => {
    await makeUser('alice');
    await makeUser('bob');
    await makeUser('carol');
    const alice = await loginAs(ctx.app, 'alice');
    const groupId = (await alice.post('/api/chats/group').send({ name: 'G', usernames: ['bob'] }).expect(201)).body.id;

    const a = await connectAs('alice', [groupId]);
    const carol = await connectAs('carol'); // connected, but not in the group yet
    await sleep(100);

    const created = nextEvent(carol, 'chat-created');
    const carolDoc = await User.findOne({ username: 'carol' });
    await alice.post(`/api/chats/${groupId}/members`).send({ usernames: ['carol'] }).expect(200);
    assert.equal((await created).name, 'G');

    const live = nextEvent(carol, 'new-message'); // note: carol never called join-chat
    assert.ok(!(await emitAck(a, 'send-message', { chatId: groupId, content: 'welcome carol' })).error);
    assert.equal((await live).content, 'welcome carol');

    const removed = nextEvent(carol, 'chat-removed');
    await alice.delete(`/api/chats/${groupId}/members/${carolDoc._id}`).expect(200);
    assert.equal((await removed).chatId, groupId);

    const quiet = noEvent(carol, 'new-message', 400);
    assert.ok(!(await emitAck(a, 'send-message', { chatId: groupId, content: 'carol should not see this' })).error);
    await quiet;
  });

  it("does not announce presence into a private chat with someone who blocked you", async () => {
    const aliceDoc = await makeUser('alice');
    await makeUser('bob');
    const alice = await loginAs(ctx.app, 'alice');
    const bob = await loginAs(ctx.app, 'bob');
    // bob creates the chat, so it is visible to him (and his socket auto-joins its room).
    const { body } = await bob.post('/api/chats/private').send({ username: 'alice' }).expect(201);
    const a = await connectAs('alice', [body.id]);

    await bob.post(`/api/users/${aliceDoc._id}/block`).send({}).expect(200);
    const bobCookie = await loginCookie(ctx.app, 'bob');
    const quiet = noEvent(a, 'user-online', 500);
    const first = await connectSocket(ctx.url, bobCookie);
    await quiet;
    first.disconnect();
    await sleep(200);

    await bob.delete(`/api/users/${aliceDoc._id}/block`).expect(200);
    const announced = nextEvent(a, 'user-online');
    open.push(await connectSocket(ctx.url, bobCookie));
    assert.ok(await announced, 'once unblocked, presence flows again');
    assert.ok(alice);
  });
});
