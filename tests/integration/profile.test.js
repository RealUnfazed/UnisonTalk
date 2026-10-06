const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const User = require('../../server/models/User');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const removeUpload = (urlPath) => fs.rmSync(path.join(__dirname, '../../server', urlPath), { force: true });

describe('profile, privacy & search', () => {
  let ctx, alice;
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(async () => {
    await resetDb();
    await makeUser('alice');
    alice = await loginAs(ctx.app, 'alice');
  });

  describe('PATCH /api/users/me', () => {
    it('sets, trims and clears the display name', async () => {
      let res = await alice.patch('/api/users/me').send({ displayName: '  Ally  ' }).expect(200);
      assert.equal(res.body.user.displayName, 'Ally');
      assert.equal(res.body.user.username, 'alice'); // identity is unchanged
      res = await alice.patch('/api/users/me').send({ displayName: '   ' }).expect(200);
      assert.equal(res.body.user.displayName, null);
    });

    it('validates inputs', async () => {
      await alice.patch('/api/users/me').send({ displayName: 'x'.repeat(41) }).expect(400);
      await alice.patch('/api/users/me').send({ autoDownloadLimitMb: 101 }).expect(400);
      await alice.patch('/api/users/me').send({ autoDownloadLimitMb: -1 }).expect(400);
      await alice.patch('/api/users/me').send({ autoDownloadLimitMb: 'lots' }).expect(400);
    });

    it('stores privacy and media settings and returns them to the owner', async () => {
      const res = await alice.patch('/api/users/me')
        .send({ privacyShowLastSeen: false, privacyDiscoverable: false, autoDownloadLimitMb: 0 }).expect(200);
      assert.deepEqual(res.body.user.privacy, { showLastSeen: false, discoverable: false });
      assert.equal(res.body.user.autoDownloadLimitMb, 0);
      const me = await alice.get('/api/auth/me').expect(200);
      assert.equal(me.body.user.privacy.showLastSeen, false);
    });
  });

  describe('avatars', () => {
    it('uploads, serves a path, and can be removed', async () => {
      const up = await alice.post('/api/users/me/avatar').attach('file', PNG, { filename: 'me.png', contentType: 'image/png' }).expect(200);
      const url = up.body.user.avatarUrl;
      try {
        assert.match(url, /^\/uploads\/avatars\//);
        assert.ok(fs.existsSync(path.join(__dirname, '../../server', url)));
      } finally {
        removeUpload(url);
      }
      const removed = await alice.delete('/api/users/me/avatar').expect(200);
      assert.match(removed.body.user.avatarUrl, /ui-avatars\.com/);
    });

    it('rejects non-images', async () => {
      const res = await alice.post('/api/users/me/avatar').attach('file', Buffer.from('nope'), { filename: 'x.txt', contentType: 'text/plain' }).expect(400);
      assert.match(res.body.error, /PNG, JPEG, GIF, or WebP/);
    });
  });

  describe('GET /api/users/search', () => {
    it('finds people by username, excluding yourself', async () => {
      await makeUser('bob');
      await makeUser('alicia');
      const res = await alice.get('/api/users/search?q=ali').expect(200);
      assert.deepEqual(res.body.map((u) => u.username), ['alicia']);
    });

    it('hides accounts that turned off "find me by username" — but exact lookups still work', async () => {
      await makeUser('bob');
      await makeUser('bobby', { privacy: { discoverable: false } });
      const res = await alice.get('/api/users/search?q=bob').expect(200);
      assert.deepEqual(res.body.map((u) => u.username), ['bob']);
      await alice.post('/api/chats/private').send({ username: 'bobby' }).expect(201);
    });

    it('shows display names in results', async () => {
      await makeUser('bob', { displayName: 'Bobby B' });
      const res = await alice.get('/api/users/search?q=bob').expect(200);
      assert.equal(res.body[0].displayName, 'Bobby B');
    });
  });

  describe('last seen privacy', () => {
    it('hides presence of people who opted out, shows everyone else', async () => {
      await makeUser('carol', { isOnline: true, privacy: { showLastSeen: false } });
      await makeUser('dave', { isOnline: true });

      const c = await alice.post('/api/chats/private').send({ username: 'carol' }).expect(201);
      const carol = c.body.participants.find((p) => p.username === 'carol');
      assert.equal(carol.isOnline, false);
      assert.equal(carol.lastSeen, null);

      const d = await alice.post('/api/chats/private').send({ username: 'dave' }).expect(201);
      const dave = d.body.participants.find((p) => p.username === 'dave');
      assert.equal(dave.isOnline, true);
    });
  });
});
