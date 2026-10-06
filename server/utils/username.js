// Derives a schema-valid username base (3-24 chars, [a-zA-Z0-9_]) from
// whatever display name an SSO provider reports, which has no format
// guarantees at all. Pure function so it can be unit tested; the
// uniqueness loop lives in controllers/ssoController.js (it needs the DB).
function sanitizeUsernameBase(rawName) {
  let base = String(rawName || 'user')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents so "José" -> "Jose", not dropped entirely
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 20);
  if (base.length < 3) base = `${base}user`.slice(0, 20);
  return base;
}

module.exports = { sanitizeUsernameBase };
