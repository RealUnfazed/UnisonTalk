const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE = require.resolve('../../server/config/paths');
function loadWith(uploadDir) {
  const saved = process.env.UPLOAD_DIR;
  if (uploadDir === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = uploadDir;
  delete require.cache[MODULE]; // the constant is computed at import time
  try {
    return require(MODULE);
  } finally {
    if (saved === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = saved;
    delete require.cache[MODULE];
  }
}

describe('upload paths', () => {
  it('default to server/uploads, exactly where files have always lived', () => {
    const paths = loadWith(undefined);
    assert.equal(paths.UPLOADS_DIR, path.join(__dirname, '../../server/uploads'));
    assert.equal(paths.AVATARS_DIR, path.join(paths.UPLOADS_DIR, 'avatars'));
  });

  it('honour UPLOAD_DIR (a mounted volume), resolved to an absolute path', () => {
    const paths = loadWith('/data/uploads');
    assert.equal(paths.UPLOADS_DIR, path.resolve('/data/uploads'));
    assert.equal(paths.AVATARS_DIR, path.join(path.resolve('/data/uploads'), 'avatars'));
  });

  it('ensureUploadDirs creates a freshly mounted, empty volume (multer will not)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisontalk-vol-'));
    try {
      const target = path.join(root, 'not', 'yet', 'there');
      const paths = loadWith(target);
      assert.ok(!fs.existsSync(target));
      paths.ensureUploadDirs();
      assert.ok(fs.statSync(path.join(target, 'avatars')).isDirectory());
      assert.doesNotThrow(() => paths.ensureUploadDirs(), 'idempotent');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
