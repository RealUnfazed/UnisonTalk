const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../fixtures/images');
const { processAvatar, sniffImageType, stripMetadata, readExifOrientation, ImageError } = require('../../server/utils/imageProcessing');

const NO_FIXTURES = fx.jpegWithExif ? false : 'Pillow fixtures were not generated';
const isImageError = (err) => err instanceof ImageError && err.status === 400;

// ------------------------- builders for hand-made images -------------------------
const seg = (marker, payload) => {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
};
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
const SCAN = Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]); // includes a stuffed FF00
const EOI = Buffer.from([0xff, 0xd9]);
const jpeg = (segments, { trailing = Buffer.alloc(0) } = {}) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, SOS, SCAN, EOI, trailing]);
function jpegSegments(buf) {
  const segments = [];
  let pos = 2;
  while (pos < buf.length) {
    const marker = buf[pos + 1];
    if (marker === 0xda) { segments.push({ marker, scanStart: pos }); break; }
    if (marker === 0xd9) break;
    const length = buf.readUInt16BE(pos + 2);
    segments.push({ marker, data: buf.subarray(pos + 4, pos + 2 + length) });
    pos += 2 + length;
  }
  return segments;
}
const markersOf = (buf) => jpegSegments(buf).map((s) => s.marker.toString(16));
function tiff(order, orientation, description) {
  const le = order === 'II';
  const w16 = (n) => { const b = Buffer.alloc(2); if (le) b.writeUInt16LE(n); else b.writeUInt16BE(n); return b; };
  const w32 = (n) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(n); else b.writeUInt32BE(n); return b; };
  const desc = Buffer.from(`${description}\0`, 'latin1');
  const header = Buffer.concat([Buffer.from(order, 'latin1'), w16(42), w32(8)]);
  const ifd = Buffer.concat([
    w16(2),
    w16(0x010e), w16(2), w32(desc.length), w32(8 + 2 + 2 * 12 + 4), // ImageDescription -> text after the IFD
    w16(0x0112), w16(3), w32(1), Buffer.concat([w16(orientation), Buffer.alloc(2)]), // Orientation (SHORT)
    w32(0),
  ]);
  return Buffer.concat([header, ifd, desc]);
}
const exifSegment = (order, orientation, description) => seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff(order, orientation, description)]));
const JFIF = seg(0xe0, Buffer.from('JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00', 'latin1'));
const orientationIn = (out) => {
  const app1 = jpegSegments(out).find((s) => s.marker === 0xe1);
  return app1 ? readExifOrientation(app1.data.subarray(6)) : null;
};

const CRC = (() => { const t = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngChunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const png = (...chunks) => Buffer.concat([PNG_SIG, ...chunks]);
const pngTypes = (buf) => { const types = []; let pos = 8; while (pos + 12 <= buf.length) { types.push(buf.subarray(pos + 4, pos + 8).toString('latin1')); pos += 12 + buf.readUInt32BE(pos); } return types; };
const IHDR = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]));
const IDAT1 = pngChunk('IDAT', Buffer.from('compressed-1'));
const IDAT2 = pngChunk('IDAT', Buffer.from('compressed-2'));
const IEND = pngChunk('IEND');

const riff = (...chunks) => { const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]); const h = Buffer.alloc(8); h.write('RIFF'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
const webpChunk = (type, data) => { const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32LE(data.length, 4); return Buffer.concat([h, data, data.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]); };
const webpTypes = (buf) => { const types = []; let pos = 12; while (pos + 8 <= buf.length) { const size = buf.readUInt32LE(pos + 4); types.push(buf.subarray(pos, pos + 4).toString('latin1')); pos += 8 + size + (size % 2); } return types; };

const sub = (...parts) => Buffer.concat([...parts.map((p) => Buffer.concat([Buffer.from([p.length]), p])), Buffer.from([0])]);
const gifExt = (label, ...blocks) => Buffer.concat([Buffer.from([0x21, label]), sub(...blocks)]);
const GIF_HEAD = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), Buffer.from([0, 0, 0, 255, 255, 255])]);
const GIF_IMAGE = Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02]), sub(Buffer.from([0x4c, 0x01]))]);
const GIF_GCE = gifExt(0xf9, Buffer.from([0, 10, 0, 0]));
const GIF_LOOP = gifExt(0xff, Buffer.from('NETSCAPE2.0'), Buffer.from([1, 0, 0]));

describe('sniffImageType', () => {
  it('identifies the four supported formats by their magic bytes', () => {
    assert.equal(sniffImageType(PNG_SIG), 'image/png');
    assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffImageType(Buffer.from('GIF87a....')), 'image/gif');
    assert.equal(sniffImageType(Buffer.from('GIF89a....')), 'image/gif');
    assert.equal(sniffImageType(riff(webpChunk('VP8L', Buffer.from('x')))), 'image/webp');
  });

  it('refuses everything else — HTML, SVG, other RIFF files, scraps, non-buffers', () => {
    for (const bad of ['<!doctype html><script>alert(1)</script>', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'GIF', 'RIFF\0\0\0\0WAVEfmt ', '', 'just text']) {
      assert.equal(sniffImageType(Buffer.from(bad)), null, bad);
    }
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
    for (const notBuffer of [null, undefined, 'PNG', 42, {}]) assert.equal(sniffImageType(notBuffer), null);
  });
});

describe('readExifOrientation', () => {
  it('reads orientation in both byte orders', () => {
    for (const order of ['II', 'MM']) for (const value of [1, 3, 6, 8]) assert.equal(readExifOrientation(tiff(order, value, 'x')), value, `${order} ${value}`);
  });

  it('returns null — never throws — for out-of-range, truncated or malformed data', () => {
    assert.equal(readExifOrientation(tiff('MM', 9, 'x')), null);
    assert.equal(readExifOrientation(tiff('MM', 0, 'x')), null);
    assert.equal(readExifOrientation(tiff('II', 6, 'x').subarray(0, 12)), null);
    assert.equal(readExifOrientation(Buffer.from('XX*\0\x08\0\0\0')), null);
    assert.equal(readExifOrientation(Buffer.from('MM\x00\x2b\0\0\0\x08')), null);
    assert.equal(readExifOrientation(Buffer.alloc(3)), null);
  });
});

describe('JPEG metadata stripping', () => {
  it('removes EXIF, XMP, comments, Photoshop and other app data — keeps what decoding needs — leaves the pixels alone', () => {
    const input = jpeg([
      JFIF,
      exifSegment('II', 6, 'LEAK-1'),
      seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x>LEAK-2</x>', 'latin1')),
      seg(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(20)])),
      seg(0xe2, Buffer.from('MPF\0xxxxxxxx', 'latin1')),
      seg(0xed, Buffer.from('Photoshop 3.0\0LEAK-3', 'latin1')),
      seg(0xfe, Buffer.from('LEAK-4')),
      seg(0xee, Buffer.from('Adobe\0\x64\x80\x00\x00\x00\x00', 'latin1')),
      seg(0xdb, Buffer.alloc(65, 1)),
      seg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    ]);
    const out = stripMetadata(input, 'image/jpeg');
    assert.deepEqual(markersOf(out), ['e0', 'e1', 'e2', 'ee', 'db', 'c0', 'da']); // JFIF, new orientation-only EXIF, ICC, Adobe, tables, frame, scan
    assert.ok(!out.toString('latin1').includes('LEAK'));
    assert.equal(orientationIn(out), 6, 'portrait photos must not come out sideways');
    assert.ok(out.subarray(jpegSegments(out).at(-1).scanStart).equals(Buffer.concat([SOS, SCAN, EOI])), 'entropy-coded image data is byte-identical');
  });

  it('keeps only the orientation of the original EXIF — nothing else survives inside the new block', () => {
    const out = stripMetadata(jpeg([JFIF, exifSegment('MM', 3, 'GPS-AND-DEVICE-DETAILS')]), 'image/jpeg');
    const app1 = jpegSegments(out).find((s) => s.marker === 0xe1);
    assert.equal(app1.data.length, 6 + 26); // "Exif\0\0" + the minimal 26-byte TIFF
    assert.equal(readExifOrientation(app1.data.subarray(6)), 3);
  });

  it('does not add an EXIF block when orientation is normal (1) or absent', () => {
    assert.deepEqual(markersOf(stripMetadata(jpeg([JFIF, exifSegment('MM', 1, 'x')]), 'image/jpeg')), ['e0', 'da']);
    assert.deepEqual(markersOf(stripMetadata(jpeg([JFIF, seg(0xfe, Buffer.from('c'))]), 'image/jpeg')), ['e0', 'da']);
  });

  it('puts the orientation block right after SOI when there is no JFIF header', () => {
    const out = stripMetadata(jpeg([exifSegment('MM', 8, 'x'), seg(0xdb, Buffer.alloc(65, 1))]), 'image/jpeg');
    assert.deepEqual(markersOf(out), ['e1', 'db', 'da']);
    assert.equal(orientationIn(out), 8);
  });

  it('drops anything appended after the final EOI marker (a favourite hiding place)', () => {
    const out = stripMetadata(jpeg([JFIF], { trailing: Buffer.from('TRAILING-PAYLOAD') }), 'image/jpeg');
    assert.ok(!out.includes('TRAILING'));
    assert.ok(out.subarray(-2).equals(EOI));
  });

  it('rejects corrupt files with a 400 instead of passing them through', () => {
    const good = jpeg([JFIF, seg(0xdb, Buffer.alloc(65, 1))]);
    for (const bad of [
      Buffer.from([0xff, 0xd8, 0xff]), // too short
      Buffer.from('not a jpeg at all'),
      good.subarray(0, 30), // truncated inside a segment
      Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, EOI]), // no scan data
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(10)]), // a segment claiming 65k
    ]) {
      assert.throws(() => stripMetadata(bad, 'image/jpeg'), isImageError);
    }
  });

  it('on a REAL phone-style photo (Pillow: EXIF + GPS + Make + comment): all of it is gone, orientation and image data are kept', { skip: NO_FIXTURES }, () => {
    const out = stripMetadata(fx.jpegWithExif, 'image/jpeg');
    for (const leaked of [fx.MARKERS.jpeg, fx.MARKERS.jpegComment, 'PrivacyPhone']) assert.ok(!out.includes(leaked), `leaked ${leaked}`);
    assert.equal(orientationIn(out), 6);
    assert.ok(out.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) && out.subarray(-2).equals(EOI));
    assert.ok(out.subarray(jpegSegments(out).at(-1).scanStart).equals(fx.jpegWithExif.subarray(jpegSegments(fx.jpegWithExif).at(-1).scanStart)), 'scan data identical to the original');
    assert.ok(out.length < fx.jpegWithExif.length);
  });
});

describe('PNG metadata stripping', () => {
  it('drops text/XMP/EXIF/time and unknown ancillary chunks and trailing data; keeps critical and rendering chunks verbatim', () => {
    const input = png(
      IHDR, pngChunk('gAMA', Buffer.from([0, 1, 0, 0])), pngChunk('tEXt', Buffer.from('Author\0LEAK-1')), pngChunk('iTXt', Buffer.from('XML:com.adobe.xmp\0LEAK-2')),
      pngChunk('zTXt', Buffer.from('c\0\0LEAK-3')), pngChunk('eXIf', Buffer.from('LEAK-4')), IDAT1, pngChunk('tIME', Buffer.alloc(7)),
      IDAT2, pngChunk('xtRA', Buffer.from('LEAK-5')), pngChunk('XTRA', Buffer.from('critical-unknown')), IEND, Buffer.from('TRAILING-PAYLOAD')
    );
    const out = stripMetadata(input, 'image/png');
    assert.deepEqual(pngTypes(out), ['IHDR', 'gAMA', 'IDAT', 'IDAT', 'XTRA', 'IEND']);
    assert.ok(!out.toString('latin1').includes('LEAK') && !out.includes('TRAILING'));
    assert.ok(out.includes(IDAT1) && out.includes(IDAT2), 'image data is untouched');
  });

  it('rejects corrupt PNGs with a 400', () => {
    for (const bad of [PNG_SIG, Buffer.from('not a png, not at all, not a png'), png(IDAT1, IEND), png(IHDR, IDAT1), png(IHDR, IDAT1, IEND).subarray(0, -5)]) {
      assert.throws(() => stripMetadata(bad, 'image/png'), isImageError);
    }
  });

  it('on a REAL PNG (Pillow: tEXt + eXIf with GPS): metadata gone, image chunks identical', { skip: NO_FIXTURES }, () => {
    const out = stripMetadata(fx.pngWithMetadata, 'image/png');
    for (const leaked of [fx.MARKERS.png, 'PrivacyPhone']) assert.ok(!out.includes(leaked));
    const types = pngTypes(out);
    assert.ok(!types.includes('eXIf') && !types.includes('tEXt'));
    assert.ok(types.includes('IHDR') && types.includes('IDAT') && types.at(-1) === 'IEND');
  });
});

describe('WebP metadata stripping', () => {
  it('removes EXIF and XMP chunks, clears their VP8X flags (keeping the others), and fixes the RIFF size', () => {
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04 | 0x10 | 0x20; // EXIF + XMP + alpha + ICC
    const vp8l = webpChunk('VP8L', Buffer.from('abcde')); // odd length: padded
    const out = stripMetadata(riff(webpChunk('VP8X', vp8x), vp8l, webpChunk('EXIF', Buffer.from('LEAK-EXIF')), webpChunk('XMP ', Buffer.from('LEAK-XMP'))), 'image/webp');
    assert.deepEqual(webpTypes(out), ['VP8X', 'VP8L']);
    assert.equal(out[20], 0x30, 'alpha and ICC flags stay, EXIF and XMP flags are cleared');
    assert.equal(out.readUInt32LE(4), out.length - 8);
    assert.ok(out.includes(vp8l));
    assert.ok(!out.toString('latin1').includes('LEAK'));
  });

  it('rejects corrupt WebP files with a 400', () => {
    const oversized = riff(webpChunk('VP8L', Buffer.from('abcd')));
    oversized.writeUInt32LE(9999, 16); // chunk claims far more data than exists
    for (const bad of [Buffer.from('RIFF\0\0\0\0WAVEfmt '), riff(), oversized, Buffer.from('short')]) {
      assert.throws(() => stripMetadata(bad, 'image/webp'), isImageError);
    }
  });

  it('on a REAL WebP (Pillow: EXIF with GPS): gone, and the container stays consistent', { skip: !fx.webpWithExif && 'no WebP fixture' }, () => {
    const out = stripMetadata(fx.webpWithExif, 'image/webp');
    for (const leaked of [fx.MARKERS.webp, 'PrivacyPhone']) assert.ok(!out.includes(leaked));
    assert.ok(!webpTypes(out).includes('EXIF'));
    assert.equal(out.readUInt32LE(4), out.length - 8);
  });
});

describe('GIF metadata stripping', () => {
  it('drops comments and non-animation application blocks and trailing data; keeps timing and looping', () => {
    const input = Buffer.concat([
      GIF_HEAD, gifExt(0xfe, Buffer.from('LEAK-GIF-COMMENT')), GIF_LOOP,
      gifExt(0xff, Buffer.from('XMP DataXMP'), Buffer.from('LEAK-GIF-XMP')), GIF_GCE, GIF_IMAGE, Buffer.from([0x3b]), Buffer.from('TRAILING-PAYLOAD'),
    ]);
    const out = stripMetadata(input, 'image/gif');
    assert.ok(!out.toString('latin1').includes('LEAK') && !out.includes('TRAILING'));
    assert.ok(out.includes(GIF_LOOP) && out.includes(GIF_GCE) && out.includes(GIF_IMAGE));
    assert.equal(out.at(-1), 0x3b);
  });

  it('rejects corrupt GIFs with a 400', () => {
    const ok = Buffer.concat([GIF_HEAD, GIF_IMAGE, Buffer.from([0x3b])]);
    for (const bad of [Buffer.from('GIF89a'), ok.subarray(0, 25), Buffer.concat([GIF_HEAD, Buffer.from([0x99, 0x00])]), Buffer.concat([GIF_HEAD, GIF_IMAGE])]) {
      assert.throws(() => stripMetadata(bad, 'image/gif'), isImageError);
    }
  });

  it('on a REAL GIF (Pillow, with a comment): the comment is gone and it is still terminated', { skip: !fx.gifWithComment && 'no GIF fixture' }, () => {
    const out = stripMetadata(fx.gifWithComment, 'image/gif');
    assert.ok(!out.includes(fx.MARKERS.gif));
    assert.equal(out.at(-1), 0x3b);
  });
});

describe('processAvatar', () => {
  function fakeSharp({ fail = false } = {}) {
    const calls = [];
    const chain = {
      rotate: () => { calls.push(['rotate']); return chain; },
      resize: (...args) => { calls.push(['resize', ...args]); return chain; },
      jpeg: (options) => { calls.push(['jpeg', options]); return chain; },
      png: () => { calls.push(['png']); return chain; },
      webp: () => { calls.push(['webp']); return chain; },
      toBuffer: async () => { if (fail) throw new Error('vips: unsupported image format'); return Buffer.from('REENCODED'); },
    };
    const sharp = (input, options) => { calls.push(['init', input, options]); return chain; };
    sharp.calls = calls;
    return sharp;
  }
  const PNG_BYTES = png(IHDR, IDAT1, IEND);
  const JPEG_BYTES = jpeg([JFIF]);
  const WEBP_BYTES = riff(webpChunk('VP8L', Buffer.from('abcd')));
  const GIF_BYTES = Buffer.concat([GIF_HEAD, GIF_IMAGE, Buffer.from([0x3b])]);

  it('only accepts bytes that really are the type the upload claims — a claim is not a fact', async () => {
    const sharp = fakeSharp();
    for (const [bytes, claimed] of [[PNG_BYTES, 'image/jpeg'], [JPEG_BYTES, 'image/png'], [Buffer.from('<html><script>alert(1)</script>'), 'image/png'], [Buffer.from('garbage'), 'image/gif']]) {
      await assert.rejects(processAvatar(bytes, claimed, { sharp }), isImageError);
      await assert.rejects(processAvatar(bytes, claimed, { sharp: null }), isImageError);
    }
    assert.equal(sharp.calls.length, 0, 'sniffing happens before any decoder sees the bytes');
  });

  it('with sharp: decodes guarded against pixel bombs, applies orientation, fits 512x512, re-encodes in a sensible format', async () => {
    const expectations = [
      [JPEG_BYTES, 'image/jpeg', ['jpeg', { quality: 85 }], 'image/jpeg', '.jpg'],
      [PNG_BYTES, 'image/png', ['png'], 'image/png', '.png'],
      [WEBP_BYTES, 'image/webp', ['webp'], 'image/webp', '.webp'],
      [GIF_BYTES, 'image/gif', ['png'], 'image/png', '.png'], // GIFs become a still PNG
    ];
    for (const [bytes, claimed, encoder, contentType, ext] of expectations) {
      const sharp = fakeSharp();
      const result = await processAvatar(bytes, claimed, { sharp });
      assert.deepEqual(sharp.calls, [
        ['init', bytes, { limitInputPixels: 24_000_000, failOn: 'error' }],
        ['rotate'],
        ['resize', 512, 512, { fit: 'cover', withoutEnlargement: true }],
        encoder,
      ]);
      assert.equal(result.buffer.toString(), 'REENCODED');
      assert.deepEqual([result.contentType, result.ext], [contentType, ext]);
    }
  });

  it('with sharp: an undecodable image is a clean 400 (not a 500 with decoder internals)', async () => {
    await assert.rejects(processAvatar(PNG_BYTES, 'image/png', { sharp: fakeSharp({ fail: true }) }), (err) => isImageError(err) && !/vips/.test(err.message));
  });

  it('without sharp: strips metadata in pure JS and keeps the format (GIFs stay GIFs)', async () => {
    const jpegResult = await processAvatar(jpeg([JFIF, exifSegment('II', 6, 'LEAK')]), 'image/jpeg', { sharp: null });
    assert.deepEqual([jpegResult.contentType, jpegResult.ext], ['image/jpeg', '.jpg']);
    assert.ok(!jpegResult.buffer.includes('LEAK'));
    assert.deepEqual((await processAvatar(PNG_BYTES, 'image/png', { sharp: null })).ext, '.png');
    assert.deepEqual((await processAvatar(WEBP_BYTES, 'image/webp', { sharp: null })).ext, '.webp');
    const gif = await processAvatar(GIF_BYTES, 'image/gif', { sharp: null });
    assert.deepEqual([gif.contentType, gif.ext], ['image/gif', '.gif']);
  });

  it('on REAL photos without sharp: nothing identifying survives', { skip: NO_FIXTURES }, async () => {
    for (const [bytes, type] of [[fx.jpegWithExif, 'image/jpeg'], [fx.pngWithMetadata, 'image/png'], [fx.webpWithExif, 'image/webp'], [fx.gifWithComment, 'image/gif']]) {
      if (!bytes) continue;
      const { buffer } = await processAvatar(bytes, type, { sharp: null });
      for (const marker of Object.values(fx.MARKERS).concat('PrivacyPhone')) assert.ok(!buffer.includes(marker), `${type} leaked ${marker}`);
    }
  });
});
