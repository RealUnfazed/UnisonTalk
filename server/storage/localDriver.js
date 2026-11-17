const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertSafeKey, assertSafePrefix, nameOf } = require('./keys');

// Files on a local disk (or a mounted volume), laid out exactly as they
// always have been: <root>/<name> and <root>/avatars/<name> — so switching
// to this layer didn't move or rename anything already uploaded.
class LocalStorage {
  constructor({ root }) {
    this.root = root;
  }

  filePath(key) {
    return path.join(this.root, ...assertSafeKey(key).split('/'));
  }

  // A freshly mounted volume is empty, and nothing else creates folders.
  async init() {
    await fs.mkdir(path.join(this.root, 'avatars'), { recursive: true });
  }

  async ping() {
    await fs.access(this.root, require('node:fs').constants.W_OK);
  }

  // Write to a temp file and rename: readers never see a half-written upload.
  async put(key, buffer) {
    const target = this.filePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temp, buffer, { mode: 0o640 });
      await fs.rename(temp, target);
    } catch (err) {
      await fs.unlink(temp).catch(() => {});
      throw err;
    }
  }

  async read(key) {
    try {
      return await fs.readFile(this.filePath(key));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async stream(key) {
    const file = this.filePath(key);
    try {
      const stat = await fs.stat(file);
      return { stream: createReadStream(file), size: stat.size };
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async exists(key) {
    const file = this.filePath(key);
    try {
      await fs.access(file);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  async delete(key) {
    const file = this.filePath(key);
    try {
      await fs.unlink(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // already gone is fine
    }
  }

  // Files directly inside `prefix` (no subfolders); dotfiles like .gitkeep are not uploads.
  async list(prefix = '') {
    assertSafePrefix(prefix);
    let dirents;
    try {
      dirents = await fs.readdir(path.join(this.root, prefix), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const entries = [];
    for (const dirent of dirents) {
      if (!dirent.isFile() || dirent.name.startsWith('.')) continue;
      const key = `${prefix}${dirent.name}`;
      const stat = await fs.stat(path.join(this.root, prefix, dirent.name));
      entries.push({ key, name: nameOf(key), lastModified: stat.mtime });
    }
    return entries;
  }
}

module.exports = { LocalStorage };
