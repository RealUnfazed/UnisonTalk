// Needs `npm install` (the serializers construct a Mongoose model) but no database.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.CLOUD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
const { serializeUser, serializeChat, serializeMessage } = require('../../server/utils/serialize');
const { encryptField } = require('../../server/utils/fieldCrypto');

const id = (s) => ({ toString: () => s });
const user = (over = {}) => ({ _id: id('u1'), username: 'bob', ...over });
const msg = (over = {}) => ({ _id: id('m1'), chat: id('c1'), sender: user(), createdAt: new Date('2026-01-01'), ...over });
const original = (over = {}) => ({ _id: id('m0'), sender: { _id: id('u2'), username: 'alice', displayName: 'Ally' }, ...over });

describe('serializeMessage — edit & delete', () => {
  it('a deleted message exposes nothing about the original, even if fields linger in the database', () => {
    const enc = encryptField('very secret text');
    const out = serializeMessage(msg({
      deletedAt: new Date(), content: enc.ciphertext, contentIv: enc.iv, ciphertext: 'ct', iv: 'iv',
      attachment: { url: '/uploads/a.bin', filename: 'x', filenameIv: 'y' }, editedAt: new Date(), replyTo: original(),
    }));
    assert.equal(out.deleted, true);
    for (const field of ['content', 'ciphertext', 'iv', 'attachment', 'replyTo', 'editedAt']) assert.equal(out[field], null, field);
    assert.ok(!JSON.stringify(out).includes('very secret text'));
    assert.ok(out.deletedAt);
  });

  it('a live message reports edits and is not marked deleted', () => {
    const enc = encryptField('hello');
    const out = serializeMessage(msg({ content: enc.ciphertext, contentIv: enc.iv, editedAt: new Date('2026-02-02') }));
    assert.equal(out.deleted, false);
    assert.equal(out.content, 'hello');
    assert.deepEqual(out.editedAt, new Date('2026-02-02'));
    assert.equal(serializeMessage(msg({ content: enc.ciphertext, contentIv: enc.iv })).editedAt, null);
  });
});

describe('serializeMessage — replies', () => {
  it('quotes a Cloud message with decrypted text, truncated for long originals', () => {
    const short = encryptField('What time is the meeting?');
    let out = serializeMessage(msg({ replyTo: original({ content: short.ciphertext, contentIv: short.iv }) }));
    assert.equal(out.replyTo.content, 'What time is the meeting?');
    assert.equal(out.replyTo.sender.displayName, 'Ally');
    assert.equal(out.replyTo.deleted, false);
    assert.equal(out.replyTo.hasAttachment, false);

    const long = encryptField('x'.repeat(300));
    out = serializeMessage(msg({ replyTo: original({ content: long.ciphertext, contentIv: long.iv }) }));
    assert.equal(out.replyTo.content.length, 141); // 140 characters + ellipsis
  });

  it('flags attachment-only originals', () => {
    const out = serializeMessage(msg({ replyTo: original({ attachment: { url: '/uploads/a.bin' } }) }));
    assert.equal(out.replyTo.hasAttachment, true);
    assert.equal(out.replyTo.content, null);
  });

  it('passes Secret Chat ciphertext through for the browser to decrypt', () => {
    const out = serializeMessage(msg({ replyTo: original({ ciphertext: 'ct', iv: 'iv' }) }));
    assert.equal(out.replyTo.ciphertext, 'ct');
    assert.equal(out.replyTo.iv, 'iv');
    assert.equal(out.replyTo.content, null);
  });

  it('shows a deleted original as a bare placeholder', () => {
    const enc = encryptField('should not leak');
    const out = serializeMessage(msg({ replyTo: original({ deletedAt: new Date(), content: enc.ciphertext, contentIv: enc.iv }) }));
    assert.equal(out.replyTo.deleted, true);
    assert.ok(!('content' in out.replyTo));
    assert.ok(!JSON.stringify(out.replyTo).includes('should not leak'));
  });

  it('returns null when the target was not loaded (an id is not a preview)', () => {
    for (const replyTo of [null, undefined, id('m0'), { _id: id('m0') }, { _id: id('m0'), sender: id('u2') }]) {
      assert.equal(serializeMessage(msg({ replyTo })).replyTo, null);
    }
  });
});

describe('serializeChat — read state', () => {
  const alice = user({ _id: id('u1'), username: 'alice' });
  const bob = user({ _id: id('u2'), username: 'bob' });
  const carol = user({ _id: id('u3'), username: 'carol', privacy: { readReceipts: false } });
  const chat = {
    _id: id('c1'), isGroup: true, name: 'G', description: '', isSecret: false, lastMessage: null,
    createdAt: new Date(), updatedAt: new Date(), admin: id('u1'), participants: [alice, bob, carol],
    reads: [
      { user: id('u1'), at: new Date('2026-01-01T10:00:00Z') },
      { user: id('u2'), at: new Date('2026-01-01T11:00:00Z') },
      { user: id('u3'), at: new Date('2026-01-01T12:00:00Z') },
    ],
  };

  it("exposes when OTHERS read — never your own marker, never people with receipts off", () => {
    const { readBy } = serializeChat(chat, 'u1');
    assert.deepEqual(Object.keys(readBy), ['u2']);
    assert.deepEqual(readBy.u2, new Date('2026-01-01T11:00:00Z'));
  });

  it('is empty without markers, and carries the unread count', () => {
    assert.deepEqual(serializeChat({ ...chat, reads: undefined }, 'u1').readBy, {});
    assert.equal(serializeChat(chat, 'u1').unreadCount, 0);
    assert.equal(serializeChat(chat, 'u1', 7).unreadCount, 7);
  });

  it("includes the account's own readReceipts setting only for its owner", () => {
    const u = user({ privacy: { readReceipts: false } });
    assert.equal(serializeUser(u, 'u1').privacy.readReceipts, false);
    assert.equal(serializeUser(user(), 'u1').privacy.readReceipts, true);
    assert.ok(!('privacy' in serializeUser(u, 'someone-else')));
  });
});
