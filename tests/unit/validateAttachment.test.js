const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAttachment, isInlineImageType } = require('../../server/utils/validateAttachment');

const OK_URL = '/uploads/1789549675088-9a407e218d71a96bf.bin';
const cloud = (over = {}) => sanitizeAttachment({ url: OK_URL, filename: 'a.pdf', mimeType: 'application/pdf', size: 10, ...over }, { isSecret: false });
const secret = (over = {}) => sanitizeAttachment({ url: OK_URL, fileIv: 'AAAAAAAAAAAAAAAA', metaIv: 'BBBBBBBBBBBBBBBB', metaCiphertext: 'Q2lwaGVydGV4dA==', ...over }, { isSecret: true });

describe('sanitizeAttachment — URL', () => {
  it('accepts exactly one path segment under /uploads/', () => {
    assert.ok(cloud().value);
  });

  it('rejects anything that could point a recipient browser elsewhere', () => {
    const bad = ['https://evil.example/pixel.png', '//evil.example/x', 'javascript:alert(1)', 'data:text/html,hi',
      '/uploads/../package.json', '/uploads/..', '/uploads/avatars/x.png', '/uploads/a/b.bin', '/etc/passwd',
      '/uploads/', '', '/uploads/x y.bin', 123, null, {}];
    for (const url of bad) assert.ok(cloud({ url }).error, `should reject ${JSON.stringify(url)}`);
    for (const url of bad) assert.ok(secret({ url }).error, `secret: should reject ${JSON.stringify(url)}`);
  });

  it('rejects non-object payloads', () => {
    for (const raw of [null, undefined, 'x', 5, [], [OK_URL]]) {
      assert.ok(sanitizeAttachment(raw, { isSecret: false }).error);
    }
  });
});

describe('sanitizeAttachment — Cloud', () => {
  it('rebuilds the object from validated fields only', () => {
    const { value } = cloud({ isImage: true, _id: 'x', evil: '<script>', filenameIv: 'z', fileIv: 'z' });
    assert.deepEqual(Object.keys(value).sort(), ['filename', 'isImage', 'mimeType', 'size', 'url']);
    assert.equal(value.isImage, false); // derived from the MIME type, not trusted from the client
  });

  it('strips path separators and control characters from filenames', () => {
    const { value } = cloud({ filename: '../../etc/pass\u0000wd\n' });
    assert.ok(!/[\u0000-\u001f/\\]/.test(value.filename));
    assert.ok(cloud({ filename: '   ' }).error);
    assert.equal(cloud({ filename: 'x'.repeat(500) }).value.filename.length, 255);
  });

  it('only treats safe raster types as inline images (never SVG/HTML)', () => {
    assert.equal(cloud({ mimeType: 'image/png' }).value.isImage, true);
    assert.equal(cloud({ mimeType: 'IMAGE/JPEG' }).value.isImage, true);
    assert.equal(cloud({ mimeType: 'image/svg+xml' }).value.isImage, false);
    assert.equal(cloud({ mimeType: 'text/html' }).value.isImage, false);
    assert.equal(isInlineImageType('image/webp'), true);
    assert.equal(isInlineImageType('image/svg+xml'), false);
  });

  it('falls back to octet-stream for malformed MIME types', () => {
    for (const mimeType of ['not a mime', '', 'x'.repeat(200), 5, '<b>/<i>']) {
      assert.equal(cloud({ mimeType }).value.mimeType, 'application/octet-stream');
    }
  });

  it('keeps sane sizes and drops nonsense', () => {
    assert.equal(cloud({ size: 12.7 }).value.size, 12);
    for (const size of [-1, 1e12, 'big', NaN, undefined]) assert.equal(cloud({ size }).value.size, undefined);
  });
});

describe('sanitizeAttachment — Secret', () => {
  it('keeps only the encrypted fields', () => {
    const { value } = secret({ filename: 'leak.pdf', mimeType: 'application/pdf', isImage: true });
    assert.deepEqual(Object.keys(value).sort(), ['fileIv', 'metaCiphertext', 'metaIv', 'url']);
  });

  it('requires well-formed, bounded base64', () => {
    assert.ok(secret({ fileIv: undefined }).error);
    assert.ok(secret({ metaIv: 'not base64!' }).error);
    assert.ok(secret({ fileIv: 'A'.repeat(64) }).error);
    assert.ok(secret({ metaCiphertext: 'A'.repeat(5000) }).error);
    assert.ok(secret({ metaCiphertext: '' }).error);
  });
});
