const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deleteAttachmentFile } = require('../../server/utils/uploadCleanup');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('deleteAttachmentFile (deleting a message removes its file)', () => {
  it('removes exactly that file and nothing else', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unisontalk-att-'));
    try {
      fs.mkdirSync(path.join(root, 'avatars'));
      const target = path.join(root, '1-a.bin');
      const sibling = path.join(root, 'other.bin');
      const avatar = path.join(root, 'avatars', 'x.png');
      const outside = path.join(root, '..', `outside-${process.pid}.txt`);
      [target, sibling, avatar, outside].forEach((f) => fs.writeFileSync(f, 'x'));

      for (const bad of ['/uploads/../' + path.basename(outside), '/uploads/avatars/x.png', '/uploads/.hidden', '/uploads/..', '/uploads/', null, undefined, 42, 'https://evil.example/uploads/1-a.bin', '/etc/passwd']) {
        deleteAttachmentFile(bad, root);
      }
      await sleep(60);
      assert.ok([target, sibling, avatar, outside].every((f) => fs.existsSync(f)), 'guarded inputs must not delete anything');

      deleteAttachmentFile('/uploads/1-a.bin', root);
      await sleep(60);
      assert.ok(!fs.existsSync(target));
      assert.ok([sibling, avatar, outside].every((f) => fs.existsSync(f)));
      fs.rmSync(outside, { force: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
