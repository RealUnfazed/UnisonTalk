const { Readable } = require('node:stream');
const { assertSafeKey, assertSafePrefix, nameOf } = require('./keys');

// In-process storage: used by tests, handy for local experiments. Nothing
// survives a restart. Implements the same contract as the real drivers.
class MemoryStorage {
  constructor() {
    this.objects = new Map(); // key -> { buffer, lastModified, contentType }
  }

  async init() {}

  async ping() {}

  async put(key, buffer, { contentType } = {}) {
    assertSafeKey(key);
    this.objects.set(key, { buffer: Buffer.from(buffer), lastModified: new Date(), contentType });
  }

  async read(key) {
    assertSafeKey(key);
    const object = this.objects.get(key);
    return object ? Buffer.from(object.buffer) : null;
  }

  async stream(key) {
    const buffer = await this.read(key);
    return buffer ? { stream: Readable.from([buffer]), size: buffer.length } : null;
  }

  async exists(key) {
    assertSafeKey(key);
    return this.objects.has(key);
  }

  async delete(key) {
    assertSafeKey(key);
    this.objects.delete(key);
  }

  // Direct children of `prefix` only — "" lists attachments, not avatars/*.
  async list(prefix = '') {
    assertSafePrefix(prefix);
    const entries = [];
    for (const [key, object] of this.objects) {
      const rest = key.slice(prefix.length);
      if (key.startsWith(prefix) && rest && !rest.includes('/')) {
        entries.push({ key, name: nameOf(key), lastModified: object.lastModified });
      }
    }
    return entries;
  }

  // Test helper: pretend an object is older than it is.
  setLastModified(key, date) {
    this.objects.get(key).lastModified = date;
  }
}

module.exports = { MemoryStorage };
