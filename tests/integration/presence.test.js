// Presence lives in MongoDB (an atomic online flag) plus a cluster-wide
// socket count — never in process memory — with a grace period before
// "offline". The grace is 400ms here (production: 3000).
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp, makeUser, loginAs, loginCookie, resetDb } = require('../helpers/testApp');
const { connectSocket, nextEvent, noEvent, emitAck } = require('../helpers/sockets');
const User = require('../../server/models/User');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('presence across tabs and reconnects', () => {
  let ctx, chatId, aliceSocket, bobCookie, bobId;
  const open = [];
  before(async () => { ctx = await startTestApp({ sockets: true, presenceGraceMs: 400 }); });
  after(async () => { await ctx.stop(); });
  beforeEach(async () => {
    await resetDb();
    await makeUser('alice');
    bobId = String((await makeUser('bob'))._id);
    const alice = await loginAs(ctx.app, 'alice');
    chatId = (await alice.post('/api/chats/group').send({ name: 'G', usernames: ['bob'] }).expect(201)).body.id;
    aliceSocket = await connectSocket(ctx.url, await loginCookie(ctx.app, 'alice'));
    open.push(aliceSocket);
    await emitAck(aliceSocket, 'join-chat', { chatId });
    bobCookie = await loginCookie(ctx.app, 'bob');
  });
  afterEach(() => open.splice(0).forEach((s) => s.disconnect()));

  const bobTab = async () => {
    const socket = await connectSocket(ctx.url, bobCookie);
    open.push(socket);
    return socket;
  };

  it('announces online ONCE for several tabs, and offline only after the LAST one closes (plus the grace period)', async () => {
    const online = nextEvent(aliceSocket, 'user-online');
    const tab1 = await bobTab();
    assert.equal((await online).userId, bobId);

    const noDuplicate = noEvent(aliceSocket, 'user-online', 300);
    const tab2 = await bobTab();
    await noDuplicate;

    const stillOnline = noEvent(aliceSocket, 'user-offline', 800); // well past the 400ms grace
    tab1.disconnect();
    await stillOnline;
    assert.equal((await User.findById(bobId)).isOnline, true, 'a second tab keeps them online');

    const offline = nextEvent(aliceSocket, 'user-offline', 2500);
    tab2.disconnect();
    const event = await offline;
    assert.equal(event.userId, bobId);
    assert.ok(event.lastSeen);
    assert.equal((await User.findById(bobId)).isOnline, false);
  });

  it('a quick reconnect (page refresh) never flickers offline, and is not announced twice', async () => {
    const online = nextEvent(aliceSocket, 'user-online');
    const first = await bobTab();
    await online;

    const noFlicker = Promise.all([noEvent(aliceSocket, 'user-offline', 900), noEvent(aliceSocket, 'user-online', 900)]);
    first.disconnect();
    await sleep(100); // back well within the 400ms grace
    await bobTab();
    await noFlicker;
    assert.equal((await User.findById(bobId)).isOnline, true);
  });
});
