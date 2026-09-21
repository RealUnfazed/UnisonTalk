// Phasetime SSO (https://github.com/RealUnfazed/Phasetime-SSO) is
// entirely optional. If these environment variables aren't set, SSO is
// simply disabled — no crash, no forced setup step, unlike
// CLOUD_ENCRYPTION_KEY. getPhasetimeConfig() returning null is the
// signal the rest of the app uses to hide/reject SSO routes gracefully.
function getPhasetimeConfig() {
  const baseUrl = process.env.PHASETIME_SSO_BASE_URL;
  const clientId = process.env.PHASETIME_CLIENT_ID;
  const clientSecret = process.env.PHASETIME_CLIENT_SECRET;
  const redirectUri = process.env.PHASETIME_REDIRECT_URI;

  if (!baseUrl || !clientId || !clientSecret || !redirectUri) return null;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''), // strip trailing slash so `${baseUrl}/authorize.php` is never doubled up
    clientId,
    clientSecret,
    redirectUri,
  };
}

module.exports = { getPhasetimeConfig };
