// Needs `npm install` (the serializers construct a Mongoose model) but no database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CLOUD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const { serializeUser, serializeChat, serializeMessage } = require('../../server/utils/serialize');
const { encryptField } = require('../../server/utils/fieldCrypto');

const id = (s) => ({ toString: () => s });
const user = (over = {}) => ({ _id: id('u1'), username: 'bob', isOnline: true, lastSeen: new Date('2026-01-01'), ...over });

describe('serializeUser — privacy', () => {
  it('shows presence to other viewers by default', () => {
    const s = serializeUser(user(), 'someone-else');
    assert.equal(s.isOnline, true);
    assert.ok(s.lastSeen);
  });

  it('hides online status AND last seen when showLastSeen is off', () => {
    const s = serializeUser(user({ privacy: { showLastSeen: false } }), 'someone-else');
    assert.equal(s.isOnline, false);
    assert.equal(s.lastSeen, null);
  });

  it('never hides presence from the account owner', () => {
    const s = serializeUser(user({ privacy: { showLastSeen: false } }), 'u1');
    assert.equal(s.isOnline, true);
    assert.ok(s.lastSeen);
  });

  it('treats a missing privacy object (restricted query) as the visible default', () => {
    assert.equal(serializeUser(user({ privacy: undefined }), 'x').isOnline, true);
  });

  it('only sends settings back to their owner', () => {
    const u = user({ privacy: { showLastSeen: false, discoverable: false }, autoDownloadLimitMb: 12 });
    const mine = serializeUser(u, 'u1');
    assert.deepEqual(mine.privacy, { showLastSeen: false, discoverable: false });
    assert.equal(mine.autoDownloadLimitMb, 12);
    const theirs = serializeUser(u, 'u2');
    assert.ok(!('privacy' in theirs));
    assert.ok(!('autoDownloadLimitMb' in theirs));
  });

  it('never exposes password, email or the raw Phasetime ID', () => {
    const s = serializeUser(user({ password: 'hash', email: 'b@example.com', phasetimeId: 'pt_1' }), 'u1');
    assert.ok(!('password' in s) && !('email' in s) && !('phasetimeId' in s));
    assert.equal(s.hasPhasetimeLink, true);
    assert.equal(serializeUser(user(), 'u1').hasPhasetimeLink, false);
  });
});

describe('serializeUser — identity', () => {
  it('exposes displayName and uses it for the generated avatar', () => {
    const s = serializeUser(user({ displayName: 'Ally' }), 'x');
    assert.equal(s.displayName, 'Ally');
    assert.match(s.avatarUrl, /name=Ally/);
  });

  it('prefers an uploaded avatar over the generated one', () => {
    assert.equal(serializeUser(user({ avatar: '/uploads/avatars/x.png' }), 'x').avatarUrl, '/uploads/avatars/x.png');
  });
});

describe('serializeChat', () => {
  const alice = user({ _id: id('u1'), username: 'alice' });
  const bob = user({ _id: id('u2'), username: 'bob', displayName: 'Bobby' });
  const base = { _id: id('c1'), isSecret: false, lastMessage: null, createdAt: new Date(), updatedAt: new Date() };

  it('names a private chat after the OTHER person, per viewer (original bug report)', () => {
    const chat = { ...base, isGroup: false, participants: [alice, bob] };
    assert.equal(serializeChat(chat, 'u1').name, 'Bobby'); // alice sees bob's display name
    assert.equal(serializeChat(chat, 'u2').name, 'alice'); // bob sees alice, not himself
  });

  it('passes group name, description and picture through; private chats get none', () => {
    const group = { ...base, isGroup: true, name: 'Team', description: 'hi', avatar: '/uploads/avatars/g.png', participants: [alice, bob], admin: id('u1') };
    const s = serializeChat(group, 'u2');
    assert.deepEqual([s.name, s.description, s.avatar, s.admin], ['Team', 'hi', '/uploads/avatars/g.png', 'u1']);
    const priv = serializeChat({ ...base, isGroup: false, participants: [alice, bob] }, 'u1');
    assert.equal(priv.description, null);
    assert.equal(priv.avatar, null);
  });
});

describe('serializeMessage — Cloud vs Secret', () => {
  const msg = (over) => ({ _id: id('m1'), chat: id('c1'), sender: user(), createdAt: new Date(), ...over });

  it('decrypts Cloud content (encrypted at rest) for the API', () => {
    const enc = encryptField('hello from the cloud');
    assert.equal(serializeMessage(msg({ content: enc.ciphertext, contentIv: enc.iv })).content, 'hello from the cloud');
  });

  it('passes through legacy plaintext that predates encryption at rest', () => {
    assert.equal(serializeMessage(msg({ content: 'old message' })).content, 'old message');
  });

  it('degrades gracefully if the key no longer matches', (t) => {
    t.mock.method(console, 'error', () => {});
    const enc = encryptField('x');
    const original = process.env.CLOUD_ENCRYPTION_KEY;
    process.env.CLOUD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    try {
      assert.equal(serializeMessage(msg({ content: enc.ciphertext, contentIv: enc.iv })).content, '[This message could not be decrypted]');
    } finally {
      process.env.CLOUD_ENCRYPTION_KEY = original;
    }
  });

  it('decrypts attachment filenames and strips the IV from the response', () => {
    const name = encryptField('payroll.pdf');
    const out = serializeMessage(msg({ attachment: { url: '/uploads/a.pdf', filename: name.ciphertext, filenameIv: name.iv, size: 10 } }));
    assert.equal(out.attachment.filename, 'payroll.pdf');
    assert.ok(!('filenameIv' in out.attachment));
  });

  it('never touches Secret Chat ciphertext (the server has no key for it)', () => {
    const out = serializeMessage(msg({ ciphertext: 'opaque-b64', iv: 'iv-b64' }));
    assert.equal(out.ciphertext, 'opaque-b64');
    assert.equal(out.iv, 'iv-b64');
    assert.equal(out.content, null);
  });
});
