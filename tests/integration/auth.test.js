const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { startTestApp, makeUser, resetDb, PASSWORD } = require('../helpers/testApp');
const User = require('../../server/models/User');
const { migratePhasetimeIndex } = require('../../server/config/db');

describe('accounts & registration', () => {
  let ctx;
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(resetDb);

  const register = (name, extra = {}) =>
    request(ctx.app).post('/api/auth/register').send({ username: name, email: `${name}@example.com`, password: PASSWORD, ...extra });

  it('registers several accounts without a Phasetime link (regression: issue #14)', async () => {
    for (const n of ['one', 'two', 'three']) await register(n).expect(201);
    assert.equal(await User.countDocuments(), 3);
    const stored = await User.find().lean();
    assert.ok(stored.every((u) => u.phasetimeId === undefined), 'no phasetimeId should be stored');
  });

  it('still enforces uniqueness for real Phasetime IDs', async () => {
    await makeUser('a', { phasetimeId: 'pt_1' });
    await assert.rejects(makeUser('b', { phasetimeId: 'pt_1' }), /E11000/);
    await makeUser('c', { phasetimeId: 'pt_2' }); // different ID is fine
  });

  it('upgrades a database that still has the legacy sparse index (issue #14 migration)', async () => {
    await User.collection.dropIndex('phasetimeId_unique_partial');
    await User.collection.createIndex({ phasetimeId: 1 }, { name: 'phasetimeId_1', unique: true, sparse: true });
    await User.collection.insertOne({ username: 'legacy1', email: 'l1@example.com', phasetimeId: null });
    await assert.rejects(
      User.collection.insertOne({ username: 'legacy2', email: 'l2@example.com', phasetimeId: null }),
      /E11000/,
      'sanity check: the legacy index really does cause the bug'
    );

    await migratePhasetimeIndex();

    const names = (await User.collection.indexes()).map((i) => i.name);
    assert.ok(!names.includes('phasetimeId_1'), 'legacy index dropped');
    assert.ok(names.includes('phasetimeId_unique_partial'), 'replacement index present');
    await register('afterupgrade').expect(201);
    assert.equal(await User.countDocuments(), 2); // legacy1 untouched + the new account
  });

  it('rejects duplicate usernames/emails, short passwords, missing fields', async () => {
    await register('dup').expect(201);
    await register('dup').expect(409);
    await register('other', { email: 'dup@example.com' }).expect(409);
    await register('shorty', { password: '123' }).expect(400);
    await request(ctx.app).post('/api/auth/register').send({ username: 'x' }).expect(400);
  });

  it('logs in, reports the session, and logs out — without leaking secrets', async () => {
    await makeUser('alice');
    const agent = request.agent(ctx.app);
    await agent.post('/api/auth/login').send({ username: 'alice', password: PASSWORD }).expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    assert.equal(me.body.user.username, 'alice');
    assert.ok(!('password' in me.body.user) && !('email' in me.body.user));
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/auth/me').expect(401);
  });

  it('rejects a wrong password with a generic error', async () => {
    await makeUser('alice');
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'nope' }).expect(401);
    assert.match(res.body.error, /Invalid username or password/);
  });

  it('never lets a password-less (SSO-only) account sign in with a password', async () => {
    await makeUser('ssoguy', { password: null, phasetimeId: 'pt_9' });
    for (const password of ['', 'anything', 'null']) {
      await request(ctx.app).post('/api/auth/login').send({ username: 'ssoguy', password }).expect(401);
    }
  });

  it('protects authenticated routes', async () => {
    await request(ctx.app).get('/api/chats').expect(401);
    await request(ctx.app).patch('/api/users/me').send({ displayName: 'x' }).expect(401);
  });
});
