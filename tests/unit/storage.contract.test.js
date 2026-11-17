// ONE contract, run against every driver: whatever the app relies on, memory,
// local disk and S3 must all do the same thing.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStorage } = require('../../server/storage/memoryDriver');
const { LocalStorage } = require('../../server/storage/localDriver');
const { S3Storage } = require('../../server/storage/s3Driver');
const { StorageKeyError } = require('../../server/storage/keys');
const { sweepOrphanUploads } = require('../../server/utils/uploadCleanup');
const { FakeS3, sdk } = require('../helpers/fakeS3');

const makers = {
  memory: async () => {
    const storage = new MemoryStorage();
    return { storage, age: (key, date) => storage.setLastModified(key, date), cleanup: async () => {} };
  },
  local: async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisontalk-store-'));
    const storage = new LocalStorage({ root });
    await storage.init();
    return { storage, age: (key, date) => fs.utimesSync(path.join(root, ...key.split('/')), date, date), cleanup: async () => fs.rmSync(root, { recursive: true, force: true }) };
  },
  s3: async () => {
    const fake = new FakeS3({ pageSize: 2 }); // tiny pages, so paging is always exercised
    const storage = new S3Storage({ client: fake, commands: sdk, bucket: 'bucket', prefix: 'pre/' });
    return { storage, age: (key, date) => fake.touch('bucket', `pre/${key}`, date), cleanup: async () => {} };
  },
};

const collect = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
const HOUR = 3_600_000;

for (const [driverName, make] of Object.entries(makers)) {
  describe(`storage contract: ${driverName}`, () => {
    let ctx;
    beforeEach(async () => { ctx = await make(); });
    afterEach(async () => { await ctx.cleanup(); });

    it('stores and returns bytes exactly (all 256 byte values), and overwrites', async () => {
      const { storage } = ctx;
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
      await storage.put('1-a.bin', bytes, { contentType: 'application/octet-stream' });
      assert.ok(bytes.equals(await storage.read('1-a.bin')));
      await storage.put('1-a.bin', Buffer.from('new'));
      assert.equal((await storage.read('1-a.bin')).toString(), 'new');
    });

    it('answers "not there" with null/false, never an error', async () => {
      const { storage } = ctx;
      assert.equal(await storage.read('nope.bin'), null);
      assert.equal(await storage.stream('nope.bin'), null);
      assert.equal(await storage.exists('nope.bin'), false);
      await assert.doesNotReject(storage.delete('nope.bin')); // deleting what is already gone is fine
    });

    it('streams the same bytes it stores, with a size', async () => {
      const { storage } = ctx;
      await storage.put('s.bin', Buffer.from('streamed content'));
      const { stream, size } = await storage.stream('s.bin');
      assert.equal(size, 16);
      assert.equal((await collect(stream)).toString(), 'streamed content');
    });

    it('exists() and delete()', async () => {
      const { storage } = ctx;
      await storage.put('d.bin', Buffer.from('x'));
      assert.equal(await storage.exists('d.bin'), true);
      await storage.delete('d.bin');
      assert.equal(await storage.exists('d.bin'), false);
      assert.equal(await storage.read('d.bin'), null);
    });

    it('lists direct children only: "" is attachments, "avatars/" is avatars', async () => {
      const { storage } = ctx;
      await storage.put('a.bin', Buffer.from('1'));
      await storage.put('b.bin', Buffer.from('2'));
      await storage.put('avatars/p.png', Buffer.from('3'));
      const top = await storage.list('');
      const avatars = await storage.list('avatars/');
      assert.deepEqual(top.map((e) => e.key).sort(), ['a.bin', 'b.bin']);
      assert.deepEqual(avatars.map((e) => [e.key, e.name]), [['avatars/p.png', 'p.png']]);
      assert.ok(top.every((e) => e.lastModified instanceof Date && !Number.isNaN(e.lastModified.getTime())));
      assert.deepEqual(await storage.list(''), top);
    });

    it('lists everything across pages and tolerates an empty store', async () => {
      const { storage } = ctx;
      assert.deepEqual(await storage.list(''), []);
      assert.deepEqual(await storage.list('avatars/'), []);
      for (let i = 0; i < 5; i += 1) await storage.put(`f${i}.bin`, Buffer.from('x'));
      assert.deepEqual((await storage.list('')).map((e) => e.name).sort(), ['f0.bin', 'f1.bin', 'f2.bin', 'f3.bin', 'f4.bin']);
    });

    it('rejects every key that is not exactly what the app generates', async () => {
      const { storage } = ctx;
      const bad = ['../x', 'a/b', 'avatars/../x', '', '.hidden', 'x'.repeat(121), 'avatars/', '/abs', 'a\\b', 'a b', 'a..b', null, 42, undefined];
      for (const key of bad) {
        for (const op of ['put', 'read', 'stream', 'exists', 'delete']) {
          await assert.rejects(() => storage[op](key, Buffer.from('x')), StorageKeyError, `${op}(${JSON.stringify(key)})`);
        }
      }
      for (const prefix of ['avatars', '../', 'x/', '/', null]) {
        await assert.rejects(() => storage.list(prefix), StorageKeyError, `list(${JSON.stringify(prefix)})`);
      }
    });

    it('accepts the keys the app does generate', async () => {
      const { storage } = ctx;
      for (const key of ['1789549675088-9a407e218d71a96bf0123456789abcde.bin', 'avatars/1789549675088-9a407e218d71a96bf0123456789abcde.png', 'a', 'x'.repeat(120)]) {
        await assert.doesNotReject(storage.put(key, Buffer.from('ok')));
      }
    });

    it('works with the orphan sweep: old unreferenced files go, young and referenced ones stay', async () => {
      const { storage, age } = ctx;
      for (const key of ['old-orphan.bin', 'old-used.bin', 'young.bin']) await storage.put(key, Buffer.from('x'));
      await storage.put('avatars/old-avatar.png', Buffer.from('x'));
      age('old-orphan.bin', new Date(Date.now() - 5 * HOUR));
      age('old-used.bin', new Date(Date.now() - 5 * HOUR));
      age('avatars/old-avatar.png', new Date(Date.now() - 5 * HOUR));

      const removed = await sweepOrphanUploads({ storage, prefix: '', olderThanMs: HOUR, isReferenced: (name) => name === 'old-used.bin' });
      assert.deepEqual(removed, ['old-orphan.bin']);
      assert.deepEqual((await storage.list('')).map((e) => e.name).sort(), ['old-used.bin', 'young.bin']);
      assert.equal(await storage.exists('avatars/old-avatar.png'), true, 'the attachments sweep must not touch avatars');
    });
  });
}

describe('LocalStorage specifics', () => {
  let root, storage;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisontalk-local-'));
    storage = new LocalStorage({ root });
    await storage.init();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps the layout uploads have always had: <root>/<name> and <root>/avatars/<name>', async () => {
    await storage.put('1-a.bin', Buffer.from('att'));
    await storage.put('avatars/1-b.png', Buffer.from('avatar'));
    assert.equal(fs.readFileSync(path.join(root, '1-a.bin'), 'utf8'), 'att');
    assert.equal(fs.readFileSync(path.join(root, 'avatars', '1-b.png'), 'utf8'), 'avatar');
  });

  it('init() creates the folders of a freshly mounted, empty volume', async () => {
    const fresh = path.join(root, 'not', 'there', 'yet');
    await new LocalStorage({ root: fresh }).init();
    assert.ok(fs.statSync(path.join(fresh, 'avatars')).isDirectory());
  });

  it('writes atomically: no temp files on success, none left behind on failure', async () => {
    await storage.put('ok.bin', Buffer.from('x'));
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), []);
    await assert.rejects(storage.put('avatars', Buffer.from('x'))); // "avatars" is a directory: the final rename cannot succeed
    assert.deepEqual(fs.readdirSync(root).filter((n) => n.endsWith('.tmp')), []);
  });

  it('does not treat dotfiles (.gitkeep) as uploads', async () => {
    fs.writeFileSync(path.join(root, '.gitkeep'), '');
    await storage.put('real.bin', Buffer.from('x'));
    assert.deepEqual((await storage.list('')).map((e) => e.name), ['real.bin']);
  });

  it('ping() fails when the storage location is gone', async () => {
    await assert.doesNotReject(storage.ping());
    await assert.rejects(new LocalStorage({ root: path.join(root, 'missing') }).ping());
  });
});
