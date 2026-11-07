const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const request = require('supertest');
const { startTestApp, makeUser, loginAs, resetDb, PASSWORD } = require('../helpers/testApp');
const User = require('../../server/models/User');
const Chat = require('../../server/models/Chat');
const Message = require('../../server/models/Message');

const UPLOADS = path.join(__dirname, '../../server/uploads');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const sid = (res) => res.headers['set-cookie'].find((c) => c.startsWith('connect.sid')).split(';')[0];

describe('security hardening', () => {
  let ctx;
  before(async () => { ctx = await startTestApp(); });
  after(async () => { await ctx.stop(); });
  beforeEach(resetDb);

  describe('response headers', () => {
    it('sets hardening headers and does not advertise Express', async () => {
      const res = await request(ctx.app).get('/api/auth/sso/status').expect(200);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['x-frame-options'], 'DENY');
      assert.ok(!('x-powered-by' in res.headers));
      assert.ok(res.headers['content-security-policy-report-only']);
    });

    it('enforces the CSP when CSP_MODE=enforce', async () => {
      process.env.CSP_MODE = 'enforce';
      try {
        const res = await request(ctx.app).get('/login.html').expect(200);
        assert.match(res.headers['content-security-policy'], /default-src 'self'/);
      } finally {
        delete process.env.CSP_MODE;
      }
    });

    it('serves pages without inline scripts, so the CSP can forbid them', async () => {
      for (const page of ['/', '/login.html', '/register.html']) {
        const html = (await request(ctx.app).get(page).expect(200)).text;
        assert.ok(!/<script>/i.test(html), `${page} still has an inline <script>`);
      }
      await request(ctx.app).get('/tailwind-config.js').expect(200);
    });
  });

  describe('malformed or hostile input never crashes the server', () => {
    it('answers malformed JSON with a generic 400', async () => {
      const res = await request(ctx.app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"username":').expect(400);
      assert.equal(res.body.error, 'Invalid request body.');
    });

    it('rejects operator-injection style values instead of executing them', async () => {
      await makeUser('alice');
      const alice = await loginAs(ctx.app, 'alice');
      await request(ctx.app).post('/api/auth/login').send({ username: { $ne: null }, password: { $ne: null } }).expect(400);
      await request(ctx.app).post('/api/auth/register').send({ username: { a: 1 }, email: 'x@example.com', password: PASSWORD }).expect(400);
      await alice.post('/api/chats/private').send({ username: { $ne: 'x' } }).expect(400);
      await alice.post('/api/chats/group').send({ name: 'G', usernames: [{ $ne: null }] }).expect(400);
      await alice.patch('/api/users/me').send({ privacyShowLastSeen: 'false' }).expect(400);
    });

    it('treats search input as literal text (no regex injection, no object queries)', async () => {
      await makeUser('alice');
      await makeUser('alicia');
      const alice = await loginAs(ctx.app, 'alice');
      assert.deepEqual((await alice.get('/api/users/search').query('q[$ne]=zzz').expect(200)).body, []);
      assert.deepEqual((await alice.get('/api/users/search').query({ q: 'ali.*' }).expect(200)).body, []); // literal, not a pattern
      await alice.get('/api/users/search').query({ q: '(a+)+$' }).expect(200);
      assert.deepEqual((await alice.get('/api/users/search?q=alic').expect(200)).body.map((u) => u.username), ['alicia']);
    });

    it('rejects registration input the schema would otherwise 500 on', async () => {
      const reg = (body) => request(ctx.app).post('/api/auth/register').send({ username: 'okname', email: 'ok@example.com', password: PASSWORD, ...body });
      await reg({ username: 'a b' }).expect(400);
      await reg({ username: 'ab' }).expect(400);
      await reg({ email: 'not-an-email' }).expect(400);
      await reg({ password: 'x'.repeat(129) }).expect(400);
    });
  });

  describe('sessions & login', () => {
    it('issues a new session ID on every login (no session fixation)', async () => {
      await makeUser('alice');
      const agent = request.agent(ctx.app);
      const first = await agent.post('/api/auth/login').send({ username: 'alice', password: PASSWORD }).expect(200);
      const second = await agent.post('/api/auth/login').send({ username: 'alice', password: PASSWORD }).expect(200);
      assert.notEqual(sid(first), sid(second));
      await agent.get('/api/auth/me').expect(200);
    });

    it('answers unknown users and wrong passwords identically', async () => {
      await makeUser('alice');
      const a = await request(ctx.app).post('/api/auth/login').send({ username: 'alice', password: 'wrong' }).expect(401);
      const b = await request(ctx.app).post('/api/auth/login').send({ username: 'nobody', password: 'wrong' }).expect(401);
      assert.deepEqual(a.body, b.body);
    });
  });

  describe('rate limiting', () => {
    it('throttles repeated failed logins for one account, with Retry-After', async () => {
      process.env.RATE_LIMIT_DISABLED = 'false';
      try {
        let last;
        for (let i = 0; i < 10; i += 1) {
          last = await request(ctx.app).post('/api/auth/login').send({ username: 'victim', password: `bad${i}` });
        }
        assert.equal(last.status, 429);
        assert.ok(last.headers['retry-after']);
      } finally {
        process.env.RATE_LIMIT_DISABLED = 'true';
      }
    });
  });

  describe('attachment access', () => {
    const created = [];
    after(() => created.forEach((f) => fs.rmSync(f, { force: true })));

    let alice, bob, mallory;
    beforeEach(async () => {
      await makeUser('alice'); await makeUser('bob'); await makeUser('mallory');
      [alice, bob, mallory] = await Promise.all(['alice', 'bob', 'mallory'].map((n) => loginAs(ctx.app, n)));
    });

    async function seed(attachment) {
      const [a, b] = await Promise.all([User.findOne({ username: 'alice' }), User.findOne({ username: 'bob' })]);
      const chat = await Chat.create({ isGroup: true, name: 'G', participants: [a._id, b._id], admin: a._id });
      const name = `test-${crypto.randomBytes(8).toString('hex')}.bin`;
      const file = path.join(UPLOADS, name);
      fs.writeFileSync(file, PNG);
      created.push(file);
      await Message.create({ chat: chat._id, sender: a._id, attachment: { url: `/uploads/${name}`, ...attachment } });
      return name;
    }

    it('serves a file only to logged-in members of the chat that contains it', async () => {
      const name = await seed({ filename: 'x.png', mimeType: 'image/png', isImage: true, size: PNG.length });
      await alice.get(`/uploads/${name}`).expect(200);
      await bob.get(`/uploads/${name}`).expect(200);
      await mallory.get(`/uploads/${name}`).expect(404);
      await request(ctx.app).get(`/uploads/${name}`).expect(401);
    });

    it('shows safe images inline and forces everything else to a sandboxed download', async () => {
      const png = await seed({ filename: 'x.png', mimeType: 'image/png', isImage: true });
      const html = await seed({ filename: 'x.html', mimeType: 'text/html' });
      const svg = await seed({ filename: 'x.svg', mimeType: 'image/svg+xml' });

      const img = await alice.get(`/uploads/${png}`).expect(200);
      assert.equal(img.headers['content-type'], 'image/png');
      assert.match(img.headers['content-security-policy'], /sandbox/);
      assert.equal(img.headers['x-content-type-options'], 'nosniff');

      for (const name of [html, svg]) {
        const res = await alice.get(`/uploads/${name}`).expect(200);
        assert.equal(res.headers['content-type'], 'application/octet-stream');
        assert.match(res.headers['content-disposition'], /attachment/);
      }
    });

    it('applies the same membership rule to Secret Chat ciphertext fetched via the JSON API', async () => {
      const name = await seed({ fileIv: 'AAAA', metaCiphertext: 'BBBB', metaIv: 'CCCC' });
      const ok = await bob.get(`/api/attachments/${name}`).expect(200);
      assert.equal(typeof ok.body.data, 'string');
      await mallory.get(`/api/attachments/${name}`).expect(404);
    });

    it('does not serve unreferenced files or path-traversal attempts', async () => {
      const orphan = path.join(UPLOADS, `orphan-${crypto.randomBytes(4).toString('hex')}.bin`);
      fs.writeFileSync(orphan, PNG);
      created.push(orphan);
      await alice.get(`/uploads/${path.basename(orphan)}`).expect(404);
      const res = await alice.get('/uploads/..%2F..%2Fpackage.json');
      assert.ok([400, 404].includes(res.status), `got ${res.status}`);
    });
  });

  describe('uploads on disk', () => {
    const avatars = path.join(UPLOADS, 'avatars');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rm = (url) => fs.rmSync(path.join(__dirname, '../../server', url), { force: true });

    it('derives avatar extensions from the validated type, never the filename', async () => {
      await makeUser('alice');
      const alice = await loginAs(ctx.app, 'alice');
      const res = await alice.post('/api/users/me/avatar').attach('file', PNG, { filename: 'evil.html', contentType: 'image/png' }).expect(200);
      try { assert.match(res.body.user.avatarUrl, /\.png$/); } finally { rm(res.body.user.avatarUrl); }
    });

    it('does not leave a file behind when a non-admin tries to set a group picture', async () => {
      await makeUser('alice'); await makeUser('bob');
      const alice = await loginAs(ctx.app, 'alice');
      const bob = await loginAs(ctx.app, 'bob');
      const { body } = await alice.post('/api/chats/group').send({ name: 'G', usernames: ['bob'] }).expect(201);
      const before = fs.readdirSync(avatars).length;
      await bob.post(`/api/chats/${body.id}/avatar`).attach('file', PNG, { filename: 'x.png', contentType: 'image/png' }).expect(403);
      await sleep(150);
      assert.equal(fs.readdirSync(avatars).length, before);
    });

    it('deletes the previous avatar file when it is replaced', async () => {
      await makeUser('alice');
      const alice = await loginAs(ctx.app, 'alice');
      const up = () => alice.post('/api/users/me/avatar').attach('file', PNG, { filename: 'a.png', contentType: 'image/png' }).expect(200);
      const first = (await up()).body.user.avatarUrl;
      const second = (await up()).body.user.avatarUrl;
      try {
        await sleep(150);
        assert.ok(!fs.existsSync(path.join(__dirname, '../../server', first)), 'old avatar should be gone');
        assert.ok(fs.existsSync(path.join(__dirname, '../../server', second)));
      } finally { rm(first); rm(second); }
    });
  });
});
