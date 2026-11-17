const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStorage } = require('../../server/storage/memoryDriver');
const { sweepOrphanUploads, deleteStoredAttachment, deleteStoredAvatar, attachmentKeyFromUrl, avatarKeyFromUrl } = require('../../server/utils/uploadCleanup');

const HOUR = 3_600_000;
const longAgo = () => new Date(Date.now() - 5 * HOUR);

describe('upload URL <-> storage key', () => {
  it('maps exactly the URL shapes the app produces', () => {
    assert.equal(attachmentKeyFromUrl('/uploads/1-a.bin'), '1-a.bin');
    assert.equal(avatarKeyFromUrl('/uploads/avatars/1-a.png'), 'avatars/1-a.png');
  });

  it('refuses everything else — other prefixes, traversal, dotfiles, foreign hosts, non-strings', () => {
    const notAttachments = ['/uploads/avatars/x.png', '/uploads/../x', '/uploads/..', '/uploads/a..b', '/uploads/.hidden', '/uploads/', '/uploads/a/b', 'https://evil.example/uploads/x.bin', '/uploads/x y', `/uploads/${'x'.repeat(121)}`, '', null, undefined, 42, {}];
    for (const url of notAttachments) assert.equal(attachmentKeyFromUrl(url), null, String(url));
    const notAvatars = ['/uploads/x.png', '/uploads/avatars/../x', '/uploads/avatars/.hidden', '/uploads/avatars/', '/uploads/avatars/a/b', '/uploads/avatars/a..b', null, undefined, 42];
    for (const url of notAvatars) assert.equal(avatarKeyFromUrl(url), null, String(url));
  });
});

describe('sweepOrphanUploads', () => {
  it('removes old unreferenced files only, per prefix', async () => {
    const storage = new MemoryStorage();
    for (const key of ['old-orphan.bin', 'old-used.bin', 'young.bin', 'avatars/old-avatar.png', 'avatars/used-avatar.png']) await storage.put(key, Buffer.from('x'));
    for (const key of ['old-orphan.bin', 'old-used.bin', 'avatars/old-avatar.png', 'avatars/used-avatar.png']) storage.setLastModified(key, longAgo());

    const attachments = await sweepOrphanUploads({ storage, prefix: '', olderThanMs: HOUR, isReferenced: async (name) => name === 'old-used.bin' });
    const avatars = await sweepOrphanUploads({ storage, prefix: 'avatars/', olderThanMs: HOUR, isReferenced: async (name) => name === 'used-avatar.png' });
    assert.deepEqual(attachments, ['old-orphan.bin']);
    assert.deepEqual(avatars, ['old-avatar.png']);
    assert.deepEqual((await storage.list('')).map((e) => e.name).sort(), ['old-used.bin', 'young.bin']);
    assert.deepEqual((await storage.list('avatars/')).map((e) => e.name), ['used-avatar.png']);
  });

  it("lets a storage failure surface (so the scheduler logs it) instead of pretending nothing was wrong", async () => {
    const storage = { list: async () => { throw new Error('S3 is down'); } };
    await assert.rejects(sweepOrphanUploads({ storage, prefix: '', olderThanMs: HOUR, isReferenced: () => false }), /S3 is down/);
  });
});

describe('deleting a message\'s or avatar\'s stored file', () => {
  before(() => { process.env.LOG_LEVEL = 'silent'; });
  after(() => { delete process.env.LOG_LEVEL; });

  it('deletes exactly the file the URL names, and nothing for URLs that do not parse', async () => {
    const storage = new MemoryStorage();
    for (const key of ['1-a.bin', '2-b.bin', 'avatars/3-c.png']) await storage.put(key, Buffer.from('x'));
    await deleteStoredAttachment(storage, '/uploads/1-a.bin');
    await deleteStoredAvatar(storage, '/uploads/avatars/3-c.png');
    for (const url of ['/uploads/avatars/3-c.png', '/uploads/../2-b.bin', null, undefined, 'https://evil.example/uploads/2-b.bin']) await deleteStoredAttachment(storage, url);
    for (const url of ['/uploads/2-b.bin', '/uploads/avatars/../2-b.bin', null]) await deleteStoredAvatar(storage, url);
    assert.deepEqual((await storage.list('')).map((e) => e.name), ['2-b.bin']);
    assert.deepEqual(await storage.list('avatars/'), []);
  });

  it('swallows a failing delete (the orphan sweep will retry) rather than failing the request', async () => {
    const storage = { delete: async () => { throw new Error('network'); } };
    await assert.doesNotReject(deleteStoredAttachment(storage, '/uploads/1-a.bin'));
    await assert.doesNotReject(deleteStoredAvatar(storage, '/uploads/avatars/1-a.png'));
  });
});
