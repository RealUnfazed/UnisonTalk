const crypto = require('crypto');
const User = require('../models/User');
const { serializeUser } = require('../utils/serialize');
const { getPhasetimeConfig } = require('../config/phasetime');

// Lets the client show/hide "Continue with Phasetime" without hardcoding
// it — this is the only SSO endpoint that isn't itself gated by
// getPhasetimeConfig() returning non-null, since its entire job is
// reporting that.
function status(_req, res) {
  res.json({ enabled: Boolean(getPhasetimeConfig()) });
}

// Kicks off a normal login/signup attempt. Not behind requireAuth — this
// is how someone who isn't logged in yet gets an account (or gets
// signed into their existing one), same as the regular login page.
function startLogin(req, res) {
  const config = getPhasetimeConfig();
  if (!config) return res.status(503).send('Phasetime SSO is not configured on this server.');
  redirectToAuthorize(req, res, config, /* linking = */ false);
}

// Kicks off linking Phasetime to the CURRENTLY logged-in account instead
// of starting a fresh one — see requireAuth on this route in authRoutes.js.
function startLink(req, res) {
  const config = getPhasetimeConfig();
  if (!config) return res.status(503).json({ error: 'Phasetime SSO is not configured on this server.' });
  redirectToAuthorize(req, res, config, /* linking = */ true);
}

function redirectToAuthorize(req, res, config, linking) {
  // Standard OAuth2 CSRF protection: a random value we can check for on
  // the way back. If the configured Phasetime instance doesn't happen to
  // round-trip `state` (the README's endpoint reference doesn't spell out
  // its authorize.php query format), the callback below treats a missing
  // state as "can't verify" rather than a hard failure — but a *present
  // and wrong* state always is one.
  const state = crypto.randomBytes(24).toString('hex');
  req.session.phasetimeState = state;
  req.session.phasetimeLinkUserId = linking ? req.session.userId : null;

  const url = new URL(`${config.baseUrl}/authorize.php`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  res.redirect(url.toString());
}

// One callback handles both flows (fresh login/signup, and linking an
// existing account) — req.session.phasetimeLinkUserId, set by whichever
// of the two functions above initiated this round trip, is what tells
// them apart.
async function handleCallback(req, res) {
  const config = getPhasetimeConfig();
  const linkUserId = req.session.phasetimeLinkUserId;
  const expectedState = req.session.phasetimeState;

  // Single-use regardless of outcome.
  delete req.session.phasetimeState;
  delete req.session.phasetimeLinkUserId;

  const onFailure = (code) =>
    res.redirect(linkUserId ? `/?ssoError=${encodeURIComponent(code)}` : `/login.html?ssoError=${encodeURIComponent(code)}`);

  if (!config) return onFailure('not_configured');

  const { code, state, error } = req.query;
  if (error) return onFailure(String(error));
  if (!code) return onFailure('missing_code');
  if (state && expectedState && state !== expectedState) {
    console.error('[sso] state mismatch on Phasetime callback — possible CSRF attempt');
    return onFailure('state_mismatch');
  }

  try {
    const tokenRes = await fetch(`${config.baseUrl}/token.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: String(code),
        redirect_uri: config.redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      console.error('[sso] token exchange failed:', tokenRes.status);
      return onFailure('token_exchange_failed');
    }
    const { access_token: accessToken } = await tokenRes.json();
    if (!accessToken) return onFailure('token_exchange_failed');

    const profileRes = await fetch(`${config.baseUrl}/userinfo.php`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!profileRes.ok) {
      console.error('[sso] userinfo fetch failed:', profileRes.status);
      return onFailure('userinfo_failed');
    }
    const profile = await profileRes.json(); // { id, name, email }
    if (!profile || !profile.id) return onFailure('invalid_profile');

    const phasetimeId = String(profile.id);

    // --- Linking Phasetime to an already-logged-in account ---
    if (linkUserId) {
      const conflict = await User.findOne({ phasetimeId });
      if (conflict && conflict._id.toString() !== linkUserId) {
        return res.redirect('/?ssoError=already_linked_elsewhere');
      }
      await User.findByIdAndUpdate(linkUserId, { phasetimeId });
      return res.redirect('/?ssoLinked=1');
    }

    // --- Fresh login or signup ---
    let user = await User.findOne({ phasetimeId });

    if (!user) {
      const email = (profile.email || '').toLowerCase().trim();
      const emailTaken = email && (await User.findOne({ email }));
      if (emailTaken) {
        // Deliberately not auto-linked by email match — we can't verify
        // from here whether Phasetime treats that email as verified, and
        // silently merging accounts on an email match is exactly the
        // kind of assumption that goes wrong quietly. They can link
        // explicitly instead, once logged into the existing account —
        // see startLink above.
        return onFailure('email_taken');
      }

      const username = await generateUniqueUsername(profile.name);
      user = await User.create({
        username,
        email: email || `${username}@phasetime.local`,
        phasetimeId,
        password: null,
      });
    }

    req.session.userId = user._id.toString();
    res.redirect('/');
  } catch (err) {
    console.error('[sso] callback failed:', err.message);
    onFailure('unexpected_error');
  }
}

async function unlink(req, res) {
  const user = await User.findByIdAndUpdate(req.session.userId, { phasetimeId: null }, { new: true }).select(
    '-password'
  );
  res.json({ user: serializeUser(user) });
}

// Derives a schema-valid, unique username from whatever display name
// Phasetime reports (which has no format guarantees at all — spaces,
// unicode, punctuation, anything).
async function generateUniqueUsername(rawName) {
  let base = (rawName || 'user')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents so e.g. "José" -> "Jose", not dropped entirely
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 20);
  if (base.length < 3) base = `${base}user`.slice(0, 20);

  let username = base;
  let suffix = 0;
  // Small, bounded collision space in practice (usernames are 3-24
  // chars); a sequential suffix is simple and sufficient here.
  // eslint-disable-next-line no-await-in-loop
  while (await User.findOne({ username })) {
    suffix += 1;
    username = `${base}${suffix}`.slice(0, 24);
  }
  return username;
}

module.exports = { status, startLogin, startLink, handleCallback, unlink };
