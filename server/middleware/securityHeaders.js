// Defence-in-depth response headers, set on every response.
//
// CSP_MODE=report-only (default) | enforce | off. It ships report-only
// because the UI currently loads Tailwind's Play CDN, Google Fonts and Font
// Awesome from third-party hosts, and a policy that is wrong for your
// deployment would blank the page. Load the app, check the browser console
// for "Content Security Policy" violations, then set CSP_MODE=enforce.
// (Moving Tailwind to a build step would let this be tightened further.)
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  'font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com',
  "img-src 'self' data: blob: https://ui-avatars.com",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production' && req.secure) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  const mode = (process.env.CSP_MODE || 'report-only').toLowerCase();
  if (mode === 'enforce') res.setHeader('Content-Security-Policy', CSP);
  else if (mode !== 'off') res.setHeader('Content-Security-Policy-Report-Only', CSP);
  next();
}

module.exports = { securityHeaders, CSP };
