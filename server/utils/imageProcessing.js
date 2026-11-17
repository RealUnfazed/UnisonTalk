// Everything an avatar goes through before it is stored.
//
//  1. Sniff: the bytes must really be the image type the upload claims. The
//     claimed type is client-controlled; this makes it a fact.
//  2. Sanitise: with `sharp` installed the image is decoded, auto-rotated,
//     resized to fit 512x512 and re-encoded — which drops ALL metadata. Without
//     it, metadata is stripped WITHOUT re-encoding (pure JS, below), so the
//     privacy guarantee never depends on an optional native module.
//
// What gets removed matters: phone photos carry EXIF with GPS coordinates,
// device model and timestamps, and avatars are public.
class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
    this.status = 400; // shown to the client as-is by the app's error handler
  }
}

const AVATAR_SIZE = 512;
const MAX_INPUT_PIXELS = 24_000_000;
const EXT = { png: '.png', jpeg: '.jpg', webp: '.webp' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const head6 = buf.subarray(0, 6).toString('latin1');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// ------------------------------- JPEG -------------------------------------
// EXIF's one useful field is orientation (phones store photos unrotated and
// say how to rotate them). Dropping it would show portrait photos sideways,
// so it's read first and written back in a minimal EXIF block holding
// nothing else.
function readExifOrientation(tiff) {
  if (tiff.length < 8) return null;
  const order = tiff.subarray(0, 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  const u16 = (o) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
  }
  return null;
}

function orientationSegment(orientation) {
  const tiff = Buffer.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD0 at offset 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, count 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0x00, 0x00]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
}

function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new ImageError('That image is corrupt.');
  const kept = [];
  let orientation = null;
  let pos = 2;
  let sawScan = false;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw new ImageError('That image is corrupt.');
    while (buf[pos + 1] === 0xff) pos += 1; // padding
    const marker = buf[pos + 1];
    if (marker === undefined) throw new ImageError('That image is corrupt.');
    if (marker === 0xd9) break; // EOI before any scan: nothing to decode
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      kept.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > buf.length) throw new ImageError('That image is corrupt.');
    const length = buf.readUInt16BE(pos + 2); // includes these two bytes
    if (length < 2 || pos + 2 + length > buf.length) throw new ImageError('That image is corrupt.');
    const segment = buf.subarray(pos, pos + 2 + length);

    if (marker === 0xda) {
      // Start of scan: the rest is entropy-coded image data up to EOI. Anything
      // after the final EOI is trailing junk (a favourite hiding place) — dropped.
      let end = buf.length;
      const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi > pos) end = eoi + 2;
      kept.push(buf.subarray(pos, end));
      sawScan = true;
      break;
    }

    const isExif = marker === 0xe1 && segment.subarray(4, 10).toString('latin1') === 'Exif\0\0';
    if (isExif && orientation === null) orientation = readExifOrientation(segment.subarray(10));
    // Keep what decoding needs: JFIF (APP0), ICC colour profile (APP2), Adobe
    // colour transform (APP14), and every structural segment. Drop EXIF/XMP
    // (APP1), Photoshop (APP13), comments, and other APPn.
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep =
      !isApp ? marker !== 0xfe
        : marker === 0xe0 || marker === 0xee || (marker === 0xe2 && segment.subarray(4, 16).toString('latin1') === 'ICC_PROFILE\0');
    if (keep) kept.push(segment);
    pos += 2 + length;
  }
  if (!sawScan) throw new ImageError('That image is corrupt.');

  const out = [buf.subarray(0, 2)];
  const hasJfif = kept.length > 0 && kept[0][1] === 0xe0;
  kept.forEach((segment, i) => {
    out.push(segment);
    if (i === 0 && hasJfif && orientation && orientation !== 1) out.push(orientationSegment(orientation));
  });
  if (!hasJfif && orientation && orientation !== 1) out.splice(1, 0, orientationSegment(orientation));
  return Buffer.concat(out);
}

// -------------------------------- PNG --------------------------------------
const PNG_KEEP = new Set(['tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD', 'acTL', 'fcTL', 'fdAT', 'cICP']);

function stripPng(buf) {
  if (buf.length < 8 + 12 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new ImageError('That image is corrupt.');
  const out = [buf.subarray(0, 8)];
  let pos = 8;
  let sawIhdr = false;
  let sawIend = false;
  while (pos + 12 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('latin1');
    const end = pos + 12 + length;
    if (end > buf.length) throw new ImageError('That image is corrupt.');
    if (pos === 8 && type !== 'IHDR') throw new ImageError('That image is corrupt.');
    if (type === 'IHDR') sawIhdr = true;
    // Critical chunks (first letter uppercase) are needed to decode; of the
    // optional ones only rendering-related chunks stay. eXIf, tEXt, zTXt, iTXt
    // (text, XMP), tIME and unknown extras go. Anything after IEND goes too.
    const critical = type[0] >= 'A' && type[0] <= 'Z';
    if (critical || PNG_KEEP.has(type)) out.push(buf.subarray(pos, end));
    pos = end;
    if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  if (!sawIhdr || !sawIend) throw new ImageError('That image is corrupt.');
  return Buffer.concat(out);
}

// -------------------------------- WebP -------------------------------------
function stripWebp(buf) {
  if (buf.length < 12 || buf.subarray(0, 4).toString('latin1') !== 'RIFF' || buf.subarray(8, 12).toString('latin1') !== 'WEBP') {
    throw new ImageError('That image is corrupt.');
  }
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks = [];
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const type = buf.subarray(pos, pos + 4).toString('latin1');
    const size = buf.readUInt32LE(pos + 4);
    const end = pos + 8 + size + (size % 2); // chunks are padded to an even length
    if (pos + 8 + size > riffEnd) throw new ImageError('That image is corrupt.');
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(buf.subarray(pos, Math.min(end, riffEnd)));
      if (type === 'VP8X' && size >= 1) chunk[8] &= ~0x0c; // clear the "has EXIF" and "has XMP" flags
      chunks.push(chunk);
    }
    pos = end;
  }
  if (chunks.length === 0) throw new ImageError('That image is corrupt.');
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// -------------------------------- GIF --------------------------------------
// GIFs carry no EXIF, but comment blocks and non-animation application
// blocks (XMP) can hold text. Walk the block structure and drop those.
function stripGif(buf) {
  if (buf.length < 13) throw new ImageError('That image is corrupt.');
  let pos = 13;
  const flags = buf[10];
  if (flags & 0x80) pos += 3 * (1 << ((flags & 7) + 1)); // global colour table
  const out = [buf.subarray(0, pos)];
  const skipSubBlocks = (p) => {
    while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
    if (p >= buf.length) throw new ImageError('That image is corrupt.');
    return p + 1;
  };
  while (pos < buf.length) {
    const introducer = buf[pos];
    if (introducer === 0x3b) {
      out.push(buf.subarray(pos, pos + 1));
      return Buffer.concat(out); // trailer — anything after it is dropped
    }
    if (introducer === 0x2c) {
      let p = pos + 10;
      if (p > buf.length) throw new ImageError('That image is corrupt.');
      if (buf[pos + 9] & 0x80) p += 3 * (1 << ((buf[pos + 9] & 7) + 1)); // local colour table
      p = skipSubBlocks(p + 1); // LZW minimum code size byte, then data sub-blocks
      out.push(buf.subarray(pos, p));
      pos = p;
    } else if (introducer === 0x21) {
      const label = buf[pos + 1];
      const end = skipSubBlocks(pos + 2);
      const isNetscapeLoop = label === 0xff && buf.subarray(pos + 3, pos + 14).toString('latin1') === 'NETSCAPE2.0';
      if (label === 0xf9 || isNetscapeLoop) out.push(buf.subarray(pos, end)); // timing and looping stay
      pos = end;
    } else {
      throw new ImageError('That image is corrupt.');
    }
  }
  throw new ImageError('That image is corrupt.');
}

const STRIPPERS = { 'image/jpeg': stripJpeg, 'image/png': stripPng, 'image/webp': stripWebp, 'image/gif': stripGif };
const stripMetadata = (buf, type) => STRIPPERS[type](buf);

// ------------------------------ pipeline ------------------------------------
let cachedSharp;
function loadSharp() {
  if (cachedSharp === undefined) {
    try {
      cachedSharp = require('sharp');
    } catch {
      cachedSharp = null; // optional dependency: not installed
    }
  }
  return cachedSharp;
}

// `declaredType` is what the upload claimed (multer's mimetype).
async function processAvatar(buffer, declaredType, { sharp = loadSharp() } = {}) {
  const type = sniffImageType(buffer);
  if (!type || type !== declaredType) throw new ImageError('That file is not a valid image of the type it claims to be.');

  if (sharp) {
    // GIFs become a still PNG of the first frame; JPEG and WebP keep their format.
    const format = type === 'image/jpeg' ? 'jpeg' : type === 'image/webp' ? 'webp' : 'png';
    try {
      const encoder = sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate() // apply EXIF orientation, then the re-encode drops the EXIF itself
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', withoutEnlargement: true });
      const out = await (format === 'jpeg' ? encoder.jpeg({ quality: 85 }) : encoder[format]()).toBuffer();
      return { buffer: out, contentType: `image/${format}`, ext: EXT[format] };
    } catch {
      throw new ImageError('That image could not be read.');
    }
  }
  return { buffer: stripMetadata(buffer, type), contentType: type, ext: type === 'image/gif' ? '.gif' : EXT[type.slice(6)] };
}

module.exports = { processAvatar, sniffImageType, stripMetadata, readExifOrientation, ImageError, AVATAR_SIZE };
