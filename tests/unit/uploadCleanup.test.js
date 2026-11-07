const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sweepOrphanUploads, discardUploadedFile, deleteAvatarFile } = require('../../server/utils/uploadCleanup');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600_000;

describe('upload cleanup', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unisontalk-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const touch = (name, ageMs = 0) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(file, t, t);
    return file;
  };

  it('removes old unreferenced files only', async () => {
    touch('old-orphan.bin', 5 * HOUR);
    touch('old-used.bin', 5 * HOUR);
    touch('young-orphan.bin', 60_000); // its message may not have been sent yet
    touch('.gitkeep', 5 * HOUR);
    fs.mkdirSync(path.join(dir, 'avatars'));

    const removed = await sweepOrphanUploads({ dir, olderThanMs: HOUR, isReferenced: (n) => n === 'old-used.bin' });
    assert.deepEqual(removed, ['old-orphan.bin']);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.gitkeep', 'avatars', 'old-used.bin', 'young-orphan.bin']);
  });

  it('awaits async reference checks and tolerates a missing directory', async () => {
    touch('a.bin', 5 * HOUR);
    const removed = await sweepOrphanUploads({ dir, olderThanMs: HOUR, isReferenced: async () => true });
    assert.deepEqual(removed, []);
    assert.deepEqual(await sweepOrphanUploads({ dir: path.join(dir, 'nope'), olderThanMs: 0, isReferenced: () => false }), []);
  });

  it('discardUploadedFile removes the rejected upload and ignores missing input', async () => {
    const file = touch('rejected.bin');
    discardUploadedFile({ path: file });
    discardUploadedFile(undefined);
    discardUploadedFile({ path: path.join(dir, 'does-not-exist') });
    await sleep(50);
    assert.ok(!fs.existsSync(file));
  });

  it('deleteAvatarFile only ever touches files directly inside /uploads/avatars/', async () => {
    fs.mkdirSync(path.join(dir, 'avatars'));
    const avatar = path.join(dir, 'avatars', 'x.png');
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(avatar, 'x');
    fs.writeFileSync(outside, 'keep me');

    deleteAvatarFile('/uploads/avatars/../secret.txt', dir);
    deleteAvatarFile('/uploads/secret.txt', dir);
    deleteAvatarFile('/uploads/avatars/.hidden', dir);
    deleteAvatarFile('/uploads/avatars/..', dir);
    deleteAvatarFile(null, dir);
    deleteAvatarFile('https://evil.example/uploads/avatars/x.png', dir);
    await sleep(50);
    assert.ok(fs.existsSync(outside) && fs.existsSync(avatar));

    deleteAvatarFile('/uploads/avatars/x.png', dir);
    await sleep(50);
    assert.ok(!fs.existsSync(avatar));
    assert.ok(fs.existsSync(outside));
  });
});
