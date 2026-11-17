const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../fixtures/images');
const { MemoryStorage } = require('../../server/storage/memoryDriver');
const { storeAvatar } = require('../../server/utils/avatarStorage');
const { ImageError } = require('../../server/utils/imageProcessing');

describe('storeAvatar', () => {
  it('stores the PROCESSED image — not the upload — under avatars/, and returns its public URL', async () => {
    const storage = new MemoryStorage();
    const url = await storeAvatar(
      { buffer: Buffer.from('the raw upload'), mimetype: 'image/png' },
      { storage, process: async () => ({ buffer: Buffer.from('CLEAN'), contentType: 'image/webp', ext: '.webp' }) }
    );
    assert.match(url, /^\/uploads\/avatars\/\d{13}-[0-9a-f]{32}\.webp$/);
    const key = url.replace('/uploads/', '');
    assert.equal((await storage.read(key)).toString(), 'CLEAN');
    assert.equal(storage.objects.get(key).contentType, 'image/webp');
    assert.equal(storage.objects.size, 1);
  });

  it('writes NOTHING when the image is rejected, and the error is a 400', async () => {
    const storage = new MemoryStorage();
    await assert.rejects(
      storeAvatar({ buffer: Buffer.from('<html>'), mimetype: 'image/png' }, { storage }),
      (err) => err instanceof ImageError && err.status === 400
    );
    assert.equal(storage.objects.size, 0);
  });

  it('end to end with the real processor: a photo with GPS data is stored without it', { skip: !fx.jpegWithExif && 'no fixtures' }, async () => {
    const storage = new MemoryStorage();
    const processWithoutSharp = (buffer, type) => require('../../server/utils/imageProcessing').processAvatar(buffer, type, { sharp: null });
    const url = await storeAvatar({ buffer: fx.jpegWithExif, mimetype: 'image/jpeg' }, { storage, process: processWithoutSharp });
    const stored = await storage.read(url.replace('/uploads/', ''));
    assert.ok(!stored.includes(fx.MARKERS.jpeg) && !stored.includes('PrivacyPhone'));
    assert.match(url, /\.jpg$/);
  });
});
