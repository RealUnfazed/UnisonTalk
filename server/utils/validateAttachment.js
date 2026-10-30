// Everything about an attachment that arrives over the socket is
// client-controlled, and it gets stored and later rendered into other
// people's browsers. Without this, someone could point `url` at an
// external host (turning every recipient's browser into a tracking-pixel
// request that leaks their IP) or at any path on this server. We rebuild
// the object from scratch with only validated fields.
const URL_RE = /^\/uploads\/[A-Za-z0-9._-]{1,120}$/; // exactly one path segment: no subfolders, no avatars, no traversal
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MIME_RE = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/;

// Raster image types that are safe to display inline. SVG is deliberately
// absent: it can carry script, so it's always downloaded, never rendered.
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const isInlineImageType = (mime) => INLINE_IMAGE_TYPES.has(String(mime).toLowerCase());

const MAX_FILE_BYTES = 100 * 1024 * 1024;

function b64Field(value, maxLen) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && B64_RE.test(value);
}

function sanitizeAttachment(raw, { isSecret }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Invalid attachment' };
  if (typeof raw.url !== 'string' || !URL_RE.test(raw.url) || raw.url.includes('..')) {
    return { error: 'Invalid attachment URL' };
  }

  if (isSecret) {
    if (!b64Field(raw.fileIv, 32) || !b64Field(raw.metaIv, 32) || !b64Field(raw.metaCiphertext, 4096)) {
      return { error: 'Invalid encrypted attachment' };
    }
    return { value: { url: raw.url, fileIv: raw.fileIv, metaCiphertext: raw.metaCiphertext, metaIv: raw.metaIv } };
  }

  const filename = typeof raw.filename === 'string'
    ? raw.filename.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim().slice(0, 255)
    : '';
  if (!filename) return { error: 'Attachment needs a filename' };

  const mimeType = typeof raw.mimeType === 'string' && raw.mimeType.length <= 100 && MIME_RE.test(raw.mimeType)
    ? raw.mimeType.toLowerCase()
    : 'application/octet-stream';
  const size = Number.isFinite(raw.size) && raw.size >= 0 && raw.size <= MAX_FILE_BYTES ? Math.floor(raw.size) : undefined;

  return { value: { url: raw.url, filename, mimeType, isImage: isInlineImageType(mimeType), size } };
}

module.exports = { sanitizeAttachment, isInlineImageType, INLINE_IMAGE_TYPES, URL_RE };
