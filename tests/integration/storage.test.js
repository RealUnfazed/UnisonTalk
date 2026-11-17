// End to end, through the real app and the real local-disk driver: attachments
// are encrypted ON DISK, tampering is detected, and avatars lose their
// EXIF/GPS metadata before anyone can see them.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const { startTestApp, makeUser, loginAs, resetDb } = require('../helpers/testApp');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');
const fx = require('../fixtures/images');

const UPLOADS = path.join(__dirname, '../../server/uploads');
const AVATARS = path.join(UPLOADS, 'avatars');
const SECRET = `TOP-SECRET-PAYLOAD-${'x'.repeat(300)}`;
const NO_FIXTURES = fx.jpegWithExif ? false : 'Pillow fixtures were not generated';
const binary = (res, callback) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('file storage: encryption at rest, integrity, avatar hygiene', () => {
  let ctx, docs, alice, bob, mallory, chat;
  const created = [];
  before(async () => { ctx = await startTestApp(); });
  after(async () => {
    created.forEach((f) => fs.rmSync(f, { force: true }));
    await ctx.stop();
  });
  beforeEach(async () => {
    await resetDb();
    docs = { alice: await makeUser('alice'), bob: await makeUser('bob') };
    await makeUser('mallory');
    [alice, bob, mallory] = await Promise.all(['alice', 'bob', 'mallory'].map((n) => loginAs(ctx.app, n)));
    chat = await Chat.create({ isGroup: true, name: 'G', participants: [docs.alice._id, docs.bob._id], admin: docs.alice._id });
  });

  const diskPath = (name) => path.join(UPLOADS, name);
  async function upload(content = SECRET, fields = {}) {
    let req = alice.post('/api/upload').attach('file', Buffer.from(content), { filename: 'notes.txt', contentType: 'text/plain' });
    for (const [key, value] of Object.entries(fields)) req = req.field(key, value);
    const res = await req.expect(201);
    const name = res.body.url.replace('/uploads/', '');
    created.push(diskPath(name));
    return { body: res.body, name };
  }
  const attach = (name, extra = {}) =>
    Message.create({ chat: chat._id, sender: docs.alice._id, attachment: { url: `/uploads/${name}`, filename: 'x', mimeType: 'text/plain', ...extra } });
  const fetchFile = (agent, name) => agent.get(`/uploads/${name}`).buffer(true).parse(binary);
  const avatarFiles = () => fs.readdirSync(AVATARS).filter((n) => !n.startsWith('.'));

  describe('chat attachments', () => {
    it('are encrypted on disk, and served decrypted to members only', async () => {
      const { name } = await upload();
      const onDisk = fs.readFileSync(diskPath(name));
      assert.equal(onDisk.subarray(0, 4).toString(), 'UTE1', 'stored with the encryption header');
      assert.ok(!onDisk.includes('TOP-SECRET-PAYLOAD'), 'the plaintext must not be on disk');

      await attach(name);
      const res = await fetchFile(bob, name).expect(200);
      assert.equal(res.body.toString(), SECRET);
      assert.equal(res.headers['content-length'], String(SECRET.length), 'the plaintext size, not the stored size');
      assert.match(res.headers['content-disposition'], /attachment/);
      await fetchFile(mallory, name).expect(404);
    });

    it('round-trip Secret Chat ciphertext through the JSON endpoint too', async () => {
      const { name } = await upload('opaque client-side ciphertext bytes', { fileIv: 'AAAA', metaCiphertext: 'BBBB', metaIv: 'CCCC' });
      await attach(name, { fileIv: 'AAAA', metaCiphertext: 'BBBB', metaIv: 'CCCC' });
      const res = await bob.get(`/api/attachments/${name}`).expect(200);
      assert.equal(Buffer.from(res.body.data, 'base64').toString(), 'opaque client-side ciphertext bytes');
      await mallory.get(`/api/attachments/${name}`).expect(404);
    });

    it('refuse to serve a file that was tampered with — or swapped for another — instead of returning garbage', async () => {
      const a = await upload(SECRET);
      const b = await upload('a completely different file');
      await attach(a.name);
      await attach(b.name);

      const original = fs.readFileSync(diskPath(a.name));
      const tampered = Buffer.from(original);
      tampered[20] ^= 0xff;
      fs.writeFileSync(diskPath(a.name), tampered);
      const res = await bob.get(`/uploads/${a.name}`).expect(500);
      assert.equal(res.body.error, 'Something went wrong. Please try again.');
      assert.ok(res.body.requestId, 'a 500 carries the request id for the log');

      fs.writeFileSync(diskPath(a.name), fs.readFileSync(diskPath(b.name))); // another file's valid ciphertext in a's slot
      await bob.get(`/uploads/${a.name}`).expect(500);
      assert.equal((await fetchFile(bob, b.name).expect(200)).body.toString(), 'a completely different file');
    });

    it('legacy plaintext files (from before encryption) are still served', async () => {
      const name = `legacy-${Date.now()}.bin`;
      fs.writeFileSync(diskPath(name), 'plain old bytes');
      created.push(diskPath(name));
      await attach(name);
      assert.equal((await fetchFile(bob, name).expect(200)).body.toString(), 'plain old bytes');
    });

    it('write nothing when the request is malformed', async () => {
      const before = fs.readdirSync(UPLOADS).length;
      await alice.post('/api/upload').field('fileIv', 'AAAA').attach('file', Buffer.from('x'), { filename: 'a.bin', contentType: 'application/octet-stream' }).expect(400);
      assert.equal(fs.readdirSync(UPLOADS).length, before);
    });
  });

  describe('avatars', () => {
    it('lose their EXIF/GPS metadata on the way in, and are then served publicly with long-lived caching', { skip: NO_FIXTURES }, async () => {
      const res = await alice.post('/api/users/me/avatar').attach('file', fx.jpegWithExif, { filename: 'me.jpg', contentType: 'image/jpeg' }).expect(200);
      const url = res.body.user.avatarUrl;
      const file = path.join(UPLOADS, url.replace('/uploads/', ''));
      created.push(file);

      const stored = fs.readFileSync(file);
      assert.ok(!stored.includes(fx.MARKERS.jpeg) && !stored.includes('PrivacyPhone'), 'the stored avatar must carry none of the photo metadata');
      assert.ok(stored.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])));

      const publicFetch = await request(ctx.app).get(url).buffer(true).parse(binary).expect(200); // no login needed
      assert.match(publicFetch.headers['content-type'], /image\/jpeg/);
      assert.match(publicFetch.headers['cache-control'], /immutable/);
      assert.equal(publicFetch.headers['x-content-type-options'], 'nosniff');
      assert.ok(publicFetch.body.equals(stored));
    });

    it('must be the image type they claim: JPEG-as-PNG, HTML-as-PNG and garbage are all refused — and nothing is stored', async () => {
      const before = avatarFiles().length;
      const attempts = [
        [fx.jpegWithExif || Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/png'],
        [Buffer.from('<html><script>alert(1)</script></html>'), 'image/png'],
        [Buffer.from('definitely not an image'), 'image/jpeg'],
      ];
      for (const [bytes, claimed] of attempts) {
        const res = await alice.post('/api/users/me/avatar').attach('file', bytes, { filename: 'a.bin', contentType: claimed }).expect(400);
        assert.ok(res.body.error);
      }
      assert.equal(avatarFiles().length, before);
    });

    it('cannot be used to read attachments or traverse out of the avatar folder', async () => {
      const { name } = await upload();
      await attach(name);
      await request(ctx.app).get(`/uploads/avatars/${name}`).expect(404);
      await request(ctx.app).get('/uploads/avatars/..%2F..%2Fpackage.json').expect(404);
      await request(ctx.app).get('/uploads/avatars/missing.png').expect(404);
    });
  });
});
